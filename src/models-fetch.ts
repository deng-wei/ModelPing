import type { LookupRequest, ModelsResult } from "./types.js";
import { trimSlash, isOriginOnlyUrl } from "./adapters/base.js";
import { withUserAgent } from "./user-agent.js";

// 拉取供应商模型列表。按 baseUrl host/形态选择候选端点与认证方式。
// 全程经后端代理（避开浏览器 CORS），apiKey 仅用于本次转发，不存储/打印。

const FETCH_TIMEOUT_MS = 15000;

function stripHash(value: string): string {
  return value.split("#", 1)[0] ?? value;
}

// base 末段是否已是版本段（v1 / v4 / v1beta...）：v + 余下含数字。
function endsWithVersionSegment(base: string): boolean {
  const seg = trimSlash(base).split("/").pop() ?? "";
  return /^v\d+[a-z0-9]*$/i.test(seg);
}

async function fetchWithTimeout(url: string, headers: Record<string, string>): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { method: "GET", headers, signal: ctrl.signal });
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error(`请求超时 (${FETCH_TIMEOUT_MS}ms)`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const ANTHROPIC_VERSION = "2023-06-01";

interface Plan {
  urls: string[];                       // 候选 URL（按序尝试，404/405 试下一个）
  headers: Record<string, string>;
  parse: (json: any) => string[];
}

function parseOpenAiModels(json: any): string[] {
  const data = json?.data;
  if (!Array.isArray(data)) return [];
  return data.map((m: any) => String(m?.id ?? "")).filter(Boolean);
}

function parseGeminiModels(json: any): string[] {
  const list = json?.models;
  if (!Array.isArray(list)) return [];
  return list
    .map((m: any) => String(m?.name ?? ""))
    .filter(Boolean)
    .map((n: string) => (n.startsWith("models/") ? n.slice("models/".length) : n));
}

// 由连接信息推导拉取计划（端点候选 + 认证 + 解析）。
function planFor(req: LookupRequest): Plan {
  const raw = stripHash(req.baseUrl.trim());
  const base = trimSlash(raw);
  const host = (() => {
    try { return new URL(base).hostname.toLowerCase(); } catch { return ""; }
  })();

  // isFullUrl：baseUrl 已是完整测试端点，回退到其 origin 再拼 models 路径。
  const origin = (() => {
    try { return new URL(base).origin; } catch { return base; }
  })();
  const root = req.isFullUrl ? origin : base;

  if (host.includes("generativelanguage") || host.includes("gemini")) {
    const r = endsWithVersionSegment(root) ? root : `${root}/v1beta`;
    return {
      urls: [`${r}/models`],
      headers: withUserAgent({ "x-goog-api-key": req.apiKey }, req.userAgent),
      parse: parseGeminiModels,
    };
  }

  if (host.includes("anthropic") || host.includes("claude")) {
    const r = endsWithVersionSegment(root) ? root : `${root}/v1`;
    return {
      urls: [`${r}/models`],
      headers: withUserAgent({ "x-api-key": req.apiKey, "anthropic-version": ANTHROPIC_VERSION }, req.userAgent),
      parse: parseOpenAiModels,
    };
  }

  // OpenAI 兼容：base 已含版本段时只追加 /models，否则同时尝试 /v1/models 与 /models。
  const urls = endsWithVersionSegment(root) || isOriginOnlyUrl(root)
    ? (endsWithVersionSegment(root) ? [`${root}/models`] : [`${root}/v1/models`, `${root}/models`])
    : [`${root}/v1/models`, `${root}/models`];
  return {
    urls,
    headers: withUserAgent({ authorization: `Bearer ${req.apiKey}` }, req.userAgent),
    parse: parseOpenAiModels,
  };
}

export async function fetchModels(req: LookupRequest): Promise<ModelsResult> {
  const plan = planFor(req);
  let lastErr = "未能拉取模型列表";

  for (const url of plan.urls) {
    let res: Response;
    try {
      res = await fetchWithTimeout(url, plan.headers);
    } catch (e: any) {
      lastErr = e?.message ?? String(e);
      continue;
    }
    if (res.status === 404 || res.status === 405) {
      lastErr = `HTTP ${res.status}`;
      continue; // 端点不对，试下一个候选
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 500)}`);
    }
    const json = await res.json().catch(() => null);
    const models = [...new Set(plan.parse(json))].sort();
    return { models };
  }

  throw new Error(lastErr);
}

// 暴露给最终目标 URL 校验：返回本次会真正请求的 URL 列表（用于 allowlist）。
export function modelsTargetUrls(req: LookupRequest): string[] {
  return planFor(req).urls;
}
