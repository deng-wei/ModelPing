import type { PingRequest, PingResult, LookupRequest, TestRequest } from "./types.js";
import { planFor } from "./models-fetch.js";
import { runTest } from "./runner.js";

// 端点延迟测速（不消耗 token）。
// 主路径：GET 供应商 /models（复用 models-fetch 的协议感知端点+认证），只测延迟与可达性。
// 回退：所有 /models 候选都 404/405（无该端点）时，发一次最小补全（max_tokens=1）取延迟。
// 全程经后端代理，apiKey 仅用于本次转发，不存储/打印。

const PING_TIMEOUT_MS = 15000;

function lookupOf(req: PingRequest): LookupRequest {
  return { baseUrl: req.baseUrl, isFullUrl: req.isFullUrl, apiKey: req.apiKey, userAgent: req.userAgent };
}

// 用最小补全测速：max_tokens=1、不流式、不重试、极短输入。
async function pingViaCompletion(req: PingRequest, signal?: AbortSignal): Promise<PingResult> {
  const testReq: TestRequest = {
    protocol: req.protocol,
    baseUrl: req.baseUrl,
    isFullUrl: req.isFullUrl,
    apiKey: req.apiKey,
    model: req.model,
    input: "hi",
    stream: false,
    timeoutMs: PING_TIMEOUT_MS,
    maxRetries: 0,
    maxTokens: 1,
    userAgent: req.userAgent ?? "",
  };
  const r = await runTest(testReq, signal);
  return { ok: r.ok, status: r.status, latencyMs: r.latencyMs, kind: "completion", error: r.error };
}

export async function pingEndpoint(req: PingRequest, signal?: AbortSignal): Promise<PingResult> {
  const plan = planFor(lookupOf(req));

  for (const url of plan.urls) {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), PING_TIMEOUT_MS);
    const start = Date.now();
    try {
      const res = await fetch(url, { method: "GET", headers: plan.headers, signal: ctrl.signal });
      const latencyMs = Date.now() - start;
      await res.text().catch(() => {}); // 读掉 body 释放连接，不解析。
      // 端点不存在 → 试下一候选，全不存在则回退补全。
      if (res.status === 404 || res.status === 405) continue;
      // 其余（含 2xx / 401 / 403）都视为端点可达，延迟有效。
      return { ok: res.ok, status: res.status, latencyMs, kind: "models", error: res.ok ? null : `HTTP ${res.status}` };
    } catch (e: any) {
      const latencyMs = Date.now() - start;
      const error = e?.name === "AbortError" ? `请求超时 (${PING_TIMEOUT_MS}ms)` : (e?.message ?? String(e));
      // 网络层失败（非 404/405）直接判失败，不再回退。
      return { ok: false, status: 0, latencyMs, kind: "models", error };
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  // 所有 /models 候选都 404/405 → 回退最小补全。
  return pingViaCompletion(req, signal);
}

// 本次测速会请求的 /models 目标 URL（用于 allowlist 校验；补全回退同 host，host 校验已覆盖）。
export function pingTargetUrls(req: PingRequest): string[] {
  return planFor(lookupOf(req)).urls;
}
