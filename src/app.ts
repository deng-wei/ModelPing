import { Hono } from "hono";
import { cors } from "hono/cors";
import { timingSafeEqual } from "hono/utils/buffer";
import type { LookupRequest, PingRequest, Protocol, StatusEntry, TestRequest } from "./types.js";
import { runTest, runTestStream } from "./runner.js";
import { normalizePresets, FALLBACK_DEFAULTS } from "./presets-schema.js";
import type { SettingsStore } from "./store/index.js";
import { fetchModels, modelsTargetUrls } from "./models-fetch.js";
import { fetchBalance, balanceTargetUrl } from "./balance.js";
import { pingEndpoint, pingTargetUrls } from "./ping.js";
import { encrypt, decrypt } from "./crypto.js";
import { emptyPrivateState, normalizePrivateState, normalizeStatusEntries } from "./private-state.js";
import { normalizeUserAgent } from "./user-agent.js";
import { isPrivateUrl } from "./ssrf.js";

const PROTOCOLS: Protocol[] = ["openai-chat", "openai-responses", "gemini", "anthropic"];

// 框架无关的 Hono app。node.ts / worker.ts 共用。
// 环境变量（两处入口都通过 env 注入）：
//   APP_PASSWORD     可选访问口令；设置后所有 /api 请求需带 x-app-password 头
//   ALLOWED_HOSTS    可选逗号分隔的目标主机 allowlist（防 SSRF/开放代理），缺省不限制
//   CORS_ORIGIN      可选逗号分隔的 CORS 允许来源；缺省不下发 ACAO 头（默认同源，跨站 JS 调不动 /api）
export interface Env {
  APP_PASSWORD?: string;
  ALLOWED_HOSTS?: string;
  CORS_ORIGIN?: string;
  // 设为 "1"/"true" 时，拒绝目标解析到私有/环回/链路本地/云元数据地址（应用层 SSRF 兜底）。
  // 默认关闭：本工具的合法用途包含测试本地/内网端点（如 Ollama），不默认拦截。
  BLOCK_PRIVATE_HOSTS?: string;
  // 设置持久化存储（presets）。由各入口按部署平台注入；未注入时走前端纯本地模式。
  store?: SettingsStore;
  // 状态列表持久化存储（含密钥，加密落盘）。各入口用 createStore(env,"status") 注入。
  statusStore?: SettingsStore;
  // 私有工作态持久化存储（含历史/连接/参数/状态，加密落盘）。各入口用 createStore(env,"private") 注入。
  privateStore?: SettingsStore;
  // 状态列表加密密钥源；缺省回退 APP_PASSWORD。两者都缺时禁用状态持久化。
  STATUS_SECRET?: string;
  // 私有工作态加密密钥源；缺省回退 STATUS_SECRET，再回退 APP_PASSWORD。
  PRIVATE_STATE_SECRET?: string;
}

// 状态列表加密密钥源：优先 STATUS_SECRET，回退 APP_PASSWORD。
function statusSecret(env?: Env): string | null {
  const s = (env?.STATUS_SECRET || env?.APP_PASSWORD || "").trim();
  return s || null;
}

function privateStateSecret(env?: Env): string | null {
  const s = (env?.PRIVATE_STATE_SECRET || env?.STATUS_SECRET || env?.APP_PASSWORD || "").trim();
  return s || null;
}

// BLOCK_PRIVATE_HOSTS 是否开启。
function blockPrivate(env?: Env): boolean {
  const v = (env?.BLOCK_PRIVATE_HOSTS ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

// 把前端传入的部分字段补齐为完整 TestRequest，并做基本校验。
function normalize(raw: any): { req?: TestRequest; error?: string } {
  if (!raw || typeof raw !== "object") return { error: "请求体非法" };
  const baseUrl = String(raw.baseUrl ?? "").trim();
  const apiKey = String(raw.apiKey ?? "");
  const model = String(raw.model ?? "").trim();
  const protocol = String(raw.protocol ?? "").trim();
  if (!baseUrl) return { error: "缺少 baseUrl" };
  if (!model) return { error: "缺少 model" };
  if (!protocol) return { error: "缺少 protocol" };

  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return { error: "baseUrl 不是合法 URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { error: "baseUrl 协议须为 http/https" };
  }

  const toInt = (v: unknown, def: number, min: number, max: number) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, Math.trunc(n)));
  };

  const req: TestRequest = {
    protocol: protocol as TestRequest["protocol"],
    baseUrl,
    isFullUrl: Boolean(raw.isFullUrl),
    apiKey,
    model,
    input: typeof raw.input === "string" && raw.input.length ? raw.input : FALLBACK_DEFAULTS.input,
    stream: Boolean(raw.stream ?? FALLBACK_DEFAULTS.stream),
    timeoutMs: toInt(raw.timeoutMs, FALLBACK_DEFAULTS.timeoutMs, 1000, 600000),
    maxRetries: toInt(raw.maxRetries, FALLBACK_DEFAULTS.maxRetries, 0, 10),
    maxTokens: toInt(raw.maxTokens, FALLBACK_DEFAULTS.maxTokens, 1, 200000),
    userAgent: normalizeUserAgent(raw.userAgent) ?? "",
  };
  return { req };
}

// 校验目标主机是否在 allowlist（若配置）。
function hostAllowed(baseUrl: string, allowed?: string): boolean {
  if (!allowed) return true;
  const list = allowed.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return true;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return list.some((h) => host === h || host.endsWith("." + h));
  } catch {
    return false;
  }
}

// 校验「余额/模型」查询请求体（仅需 baseUrl + apiKey）。
function normalizeLookup(raw: any): { req?: LookupRequest; error?: string } {
  if (!raw || typeof raw !== "object") return { error: "请求体非法" };
  const baseUrl = String(raw.baseUrl ?? "").trim();
  const apiKey = String(raw.apiKey ?? "");
  if (!baseUrl) return { error: "缺少 baseUrl" };
  if (!apiKey) return { error: "缺少 apiKey" };
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return { error: "baseUrl 不是合法 URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { error: "baseUrl 协议须为 http/https" };
  }
  return { req: { baseUrl, isFullUrl: Boolean(raw.isFullUrl), apiKey, userAgent: normalizeUserAgent(raw.userAgent) } };
}

// 校验测速请求体（baseUrl + apiKey + protocol + model）。
function normalizePing(raw: any): { req?: PingRequest; error?: string } {
  const lookup = normalizeLookup(raw);
  if (lookup.error || !lookup.req) return { error: lookup.error };
  const protocol = String(raw.protocol ?? "").trim();
  const model = String(raw.model ?? "").trim();
  if (!PROTOCOLS.includes(protocol as Protocol)) return { error: "protocol 非法" };
  if (!model) return { error: "缺少 model" };
  return { req: { ...lookup.req, protocol: protocol as Protocol, model } };
}

// 轻量校验状态列表：保留形状合法的条目，丢弃非法项。落盘前用于 PUT。
export function createApp() {
  const app = new Hono<{ Bindings: Env }>();

  app.use(
    "/api/*",
    cors({
      // origin 用函数形式，注册时拿不到 env，请求时从 c.env.CORS_ORIGIN 读取。
      // 配置了（逗号分隔）→ 命中来源回显放行；未配置 → 返回 null（不下发 ACAO，默认同源）。
      origin: (origin, c) => {
        const raw = (c.env as Env)?.CORS_ORIGIN;
        if (!raw) return null;
        const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
        if (list.includes("*")) return "*";
        return list.includes(origin) ? origin : null;
      },
    }),
  );

  // 健康检查 + 是否需要口令（前端据此决定要不要弹口令输入）。
  // 必须放在口令中间件之前：前端正是靠它来发现「是否需要口令」，不能被口令挡住。
  app.get("/api/health", (c) => {
    return c.json({ ok: true, needPassword: Boolean(c.env?.APP_PASSWORD) });
  });

  // 可选访问口令。设置 APP_PASSWORD 后，所有 /api 请求须带 x-app-password。
  // 用 timingSafeEqual 做常量时间比较，避免计时侧信道下的口令枚举。
  app.use("/api/*", async (c, next) => {
    const pw = c.env?.APP_PASSWORD;
    if (pw) {
      const got = c.req.header("x-app-password") ?? "";
      if (!(await timingSafeEqual(got, pw))) return c.json({ error: "访问口令错误" }, 401);
    }
    await next();
  });

  // ---------- 设置持久化（presets，跨设备共享） ----------
  // 已被上面的 APP_PASSWORD 中间件保护。不存储 apiKey。
  // 未配置 store 时：GET 返回 204（前端据此回退静态 /presets.json 或本地缓存）。
  app.get("/api/settings", async (c) => {
    const store = c.env?.store;
    if (!store) return c.body(null, 204);
    const raw = await store.get();
    if (!raw) return c.body(null, 204);
    return c.body(raw, 200, { "content-type": "application/json", "cache-control": "no-store" });
  });

  app.put("/api/settings", async (c) => {
    const store = c.env?.store;
    if (!store) return c.json({ error: "服务端未配置持久化存储" }, 501);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "请求体须为 JSON" }, 400);
    }
    let normalized;
    try {
      normalized = normalizePresets(raw);
    } catch (e: any) {
      return c.json({ error: e?.message ?? "预设校验失败" }, 400);
    }
    await store.put(JSON.stringify(normalized));
    return c.json({ ok: true });
  });

  // ---------- 私有工作态持久化（含历史/连接/参数/状态，加密落盘） ----------
  app.get("/api/private-state", async (c) => {
    const store = c.env?.privateStore;
    const secret = privateStateSecret(c.env);
    if (!store || !secret) return c.body(null, 204);
    const raw = await store.get();
    if (!raw) return c.json(emptyPrivateState(), 200, { "cache-control": "no-store" });
    let decrypted: string;
    try {
      decrypted = await decrypt(raw, secret);
    } catch {
      return c.json({ error: "私有工作态无法解密，请检查 PRIVATE_STATE_SECRET/STATUS_SECRET/APP_PASSWORD 或清空私有状态文件" }, 409);
    }
    try {
      return c.json(normalizePrivateState(JSON.parse(decrypted)), 200, { "cache-control": "no-store" });
    } catch {
      return c.json({ error: "私有工作态格式损坏，请清空私有状态文件后重试" }, 409);
    }
  });

  app.put("/api/private-state", async (c) => {
    const store = c.env?.privateStore;
    const secret = privateStateSecret(c.env);
    if (!store || !secret) return c.json({ error: "服务端未配置私有工作态持久化（需 store + PRIVATE_STATE_SECRET/STATUS_SECRET/APP_PASSWORD）" }, 501);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "请求体须为 JSON" }, 400);
    }
    let state;
    try {
      state = normalizePrivateState(raw);
    } catch (e: any) {
      return c.json({ error: e?.message ?? "私有工作态校验失败" }, 400);
    }
    state.updatedAt = Date.now();
    await store.put(await encrypt(JSON.stringify(state), secret));
    return c.json({ ok: true });
  });

  // ---------- 状态列表持久化（含密钥，加密落盘） ----------
  // 受 APP_PASSWORD 中间件保护。未配置 statusStore 或无密钥源时：GET 返回 204、PUT 返回 501，
  // 前端据此回退到「仅本会话内存」模式，绝不明文落本地。
  app.get("/api/status", async (c) => {
    const store = c.env?.statusStore;
    const secret = statusSecret(c.env);
    if (!store || !secret) return c.body(null, 204);
    const raw = await store.get();
    if (!raw) return c.body("[]", 200, { "content-type": "application/json", "cache-control": "no-store" });
    let json: string;
    try {
      json = await decrypt(raw, secret);
    } catch {
      // 密钥变更/密文损坏：当作无数据，避免整页报错。
      return c.body(null, 204);
    }
    return c.body(json, 200, { "content-type": "application/json", "cache-control": "no-store" });
  });

  app.put("/api/status", async (c) => {
    const store = c.env?.statusStore;
    const secret = statusSecret(c.env);
    if (!store || !secret) return c.json({ error: "服务端未配置状态持久化（需 store + APP_PASSWORD/STATUS_SECRET）" }, 501);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "请求体须为 JSON" }, 400);
    }
    let entries: StatusEntry[];
    try {
      entries = normalizeStatusEntries(raw);
    } catch (e: any) {
      return c.json({ error: e?.message ?? "状态列表校验失败" }, 400);
    }
    await store.put(await encrypt(JSON.stringify(entries), secret));
    return c.json({ ok: true });
  });

  // 核心测试端点。stream=true 时返回 SSE，否则返回 JSON。
  app.post("/api/test", async (c) => {
    let raw: any;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "请求体须为 JSON" }, 400);
    }

    const { req, error } = normalize(raw);
    if (error || !req) return c.json({ error: error ?? "参数错误" }, 400);

    if (!hostAllowed(req.baseUrl, c.env?.ALLOWED_HOSTS)) {
      return c.json({ error: "目标主机不在允许列表内" }, 403);
    }
    if (blockPrivate(c.env) && isPrivateUrl(req.baseUrl)) {
      return c.json({ error: "目标主机为私有/本地地址，已被禁止" }, 403);
    }

    if (req.stream) {
      const stream = runTestStream(req, c.req.raw.signal);
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
        },
      });
    }

    try {
      const result = await runTest(req, c.req.raw.signal);
      return c.json(result);
    } catch (error) {
      if (c.req.raw.signal.aborted || (error as { name?: string } | null)?.name === "AbortError") {
        return new Response(null, { status: 499 });
      }
      throw error;
    }
  });

  // 拉取供应商模型列表（GET 各家 /models 端点，经后端避开 CORS）。
  app.post("/api/models", async (c) => {
    let raw: any;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "请求体须为 JSON" }, 400);
    }
    const { req, error } = normalizeLookup(raw);
    if (error || !req) return c.json({ error: error ?? "参数错误" }, 400);

    // 对每个候选目标 URL 做 allowlist 校验，任一不在列表即拒绝。
    for (const target of modelsTargetUrls(req)) {
      if (!hostAllowed(target, c.env?.ALLOWED_HOSTS)) {
        return c.json({ error: "目标主机不在允许列表内" }, 403);
      }
      if (blockPrivate(c.env) && isPrivateUrl(target)) {
        return c.json({ error: "目标主机为私有/本地地址，已被禁止" }, 403);
      }
    }
    try {
      return c.json(await fetchModels(req));
    } catch (e: any) {
      return c.json({ error: e?.message ?? "拉取模型列表失败" }, 502);
    }
  });

  // 查询供应商余额/额度（按 host 匹配已知端点；不支持的 host 返回 supported:false）。
  app.post("/api/balance", async (c) => {
    let raw: any;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "请求体须为 JSON" }, 400);
    }
    const { req, error } = normalizeLookup(raw);
    if (error || !req) return c.json({ error: error ?? "参数错误" }, 400);

    const target = balanceTargetUrl(req.baseUrl);
    if (target && !hostAllowed(target, c.env?.ALLOWED_HOSTS)) {
      return c.json({ error: "目标主机不在允许列表内" }, 403);
    }
    if (target && blockPrivate(c.env) && isPrivateUrl(target)) {
      return c.json({ error: "目标主机为私有/本地地址，已被禁止" }, 403);
    }
    try {
      return c.json(await fetchBalance(req));
    } catch (e: any) {
      return c.json({ error: e?.message ?? "查询余额失败" }, 502);
    }
  });

  // 端点延迟测速（不消耗 token）。优先 GET /models，无该端点时回退最小补全。
  app.post("/api/ping", async (c) => {
    let raw: any;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "请求体须为 JSON" }, 400);
    }
    const { req, error } = normalizePing(raw);
    if (error || !req) return c.json({ error: error ?? "参数错误" }, 400);

    // 校验本次测速会请求的目标主机（/models 与补全回退同 host，host 校验已覆盖）。
    for (const target of pingTargetUrls(req)) {
      if (!hostAllowed(target, c.env?.ALLOWED_HOSTS)) {
        return c.json({ error: "目标主机不在允许列表内" }, 403);
      }
      if (blockPrivate(c.env) && isPrivateUrl(target)) {
        return c.json({ error: "目标主机为私有/本地地址，已被禁止" }, 403);
      }
    }
    try {
      return c.json(await pingEndpoint(req, c.req.raw.signal));
    } catch (e: any) {
      if (c.req.raw.signal.aborted || (e as { name?: string } | null)?.name === "AbortError") {
        return new Response(null, { status: 499 });
      }
      return c.json({ error: e?.message ?? "测速失败" }, 502);
    }
  });

  return app;
}
