import type { Balance, DualTestResult, ModelsResult, PingResult, PresetsResponse, PrivateState, StreamEvent, TestResult, Usage } from "./types.js";
import { normalizePresets } from "./presets.js";
import { drainSseBlocks, extractSseData } from "../../src/sse.js";

// 空用量（探测失败/无结果时的占位）。前后端共享同一形状。
export const EMPTY_USAGE: Usage = { inputTokens: null, outputTokens: null, totalTokens: null };

// 访问口令（可选）。若后端启用 APP_PASSWORD，前端把口令存内存 + sessionStorage。
let appPassword: string | null = sessionStorage.getItem("app_password");

export function setAppPassword(pw: string) {
  appPassword = pw;
  sessionStorage.setItem("app_password", pw);
}

function authHeaders(): Record<string, string> {
  return appPassword ? { "x-app-password": appPassword } : {};
}

export interface TestPayload {
  protocol: string;
  baseUrl: string;
  isFullUrl?: boolean;
  apiKey: string;
  model: string;
  input: string;
  stream: boolean;
  timeoutMs: number;
  maxRetries: number;
  maxTokens: number;
  userAgent?: string;
}

export interface HealthResponse {
  ok: boolean;
  needPassword: boolean;
  security?: {
    hasPassword: boolean;
    hasAllowedHosts: boolean;
    blockPrivateHosts: boolean;
    shouldWarnOpenProxy: boolean;
  };
  persistence?: {
    settings: boolean;
    privateState: boolean;
    privateStateScope: "full" | "config" | "none";
  };
}

export async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch("/api/health");
  // 非 2xx（如反代 5xx / 返回 HTML 错误页）直接 res.json() 会抛解析错，
  // 这里显式判 ok 并回退，避免初始化整体崩在一个无信息的 SyntaxError。
  if (!res.ok) throw new Error(`健康检查失败: HTTP ${res.status}`);
  return res.json();
}

// 静态默认预设（构建产物），作为「重置默认」目标与服务端/本地都无数据时的兜底。
export async function fetchPresets(): Promise<PresetsResponse> {
  const res = await fetch("/presets.json", { cache: "no-cache" });
  if (!res.ok) throw new Error(`拉取预设失败: HTTP ${res.status}`);
  return normalizePresets(await res.json());
}

// 服务端持久化的预设（跨设备共享）。204/501 表示未配置 store，返回 null 让调用方降级到本地。
export async function fetchSettings(): Promise<PresetsResponse | null> {
  const res = await fetch("/api/settings", { headers: authHeaders(), cache: "no-cache" });
  if (res.status === 204) return null;
  if (!res.ok) return null;
  try {
    return normalizePresets(await res.json());
  } catch {
    return null;
  }
}

// 写回服务端。返回 false 表示服务端未配置持久化（501）；其他错误抛出。
export async function saveSettings(presets: PresetsResponse): Promise<boolean> {
  const res = await fetch("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(presets),
  });
  if (res.status === 501) return false;
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j: any = await res.json();
      if (j?.error) msg = j.error;
    } catch {}
    throw new Error(msg);
  }
  return true;
}

export function emptyPrivateState(): PrivateState {
  return {
    v: 1,
    historyPersist: true,
    history: [],
    conn: null,
    config: null,
    statusEntries: [],
    updatedAt: Date.now(),
  };
}

export async function fetchPrivateState(): Promise<PrivateState | null> {
  const res = await fetch("/api/private-state", { headers: authHeaders(), cache: "no-cache" });
  if (res.status === 204) return null;
  if (res.status === 409) {
    let msg = "私有工作态无法解密";
    try {
      const j: any = await res.json();
      if (j?.error) msg = j.error;
    } catch {}
    throw new Error(msg);
  }
  if (!res.ok) return null;
  try {
    const raw = await res.json();
    const state = raw && typeof raw === "object" ? raw as Partial<PrivateState> : {};
    return {
      ...emptyPrivateState(),
      ...state,
      historyPersist: state?.historyPersist !== false,
      history: Array.isArray(state?.history) ? state.history : [],
      conn: state?.conn ?? null,
      config: state?.config ?? null,
      statusEntries: Array.isArray(state?.statusEntries) ? state.statusEntries : [],
    };
  } catch {
    return null;
  }
}

export async function savePrivateState(state: PrivateState): Promise<boolean> {
  const res = await fetch("/api/private-state", {
    method: "PUT",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(state),
  });
  if (res.status === 501) return false;
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j: any = await res.json();
      if (j?.error) msg = j.error;
    } catch {}
    throw new Error(msg);
  }
  return true;
}

export interface LookupPayload {
  baseUrl: string;
  isFullUrl?: boolean;
  apiKey: string;
  userAgent?: string;
}

// 拉取供应商模型列表（经后端代理）。
export async function fetchModels(payload: LookupPayload): Promise<ModelsResult> {
  const res = await fetch("/api/models", {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j: any = await res.json();
      if (j?.error) msg = j.error;
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}

// 端点延迟测速（不消耗 token，经后端代理）。
export interface PingPayload {
  protocol: string;
  baseUrl: string;
  isFullUrl?: boolean;
  apiKey: string;
  model: string;
  userAgent?: string;
}

export async function pingEndpoint(payload: PingPayload, signal?: AbortSignal): Promise<PingResult> {
  let res: Response;
  try {
    res = await fetch("/api/ping", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (e: any) {
    return { ok: false, status: 0, latencyMs: 0, kind: "models", error: e?.message ?? String(e) };
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j: any = await res.json();
      if (j?.error) msg = j.error;
    } catch {}
    return { ok: false, status: res.status, latencyMs: 0, kind: "models", error: msg };
  }
  try {
    return await res.json();
  } catch (e: any) {
    return { ok: false, status: res.status, latencyMs: 0, kind: "models", error: `响应解析失败: ${e?.message ?? e}` };
  }
}

// 查询供应商余额/额度（经后端代理）。
export async function fetchBalance(payload: LookupPayload): Promise<Balance> {
  const res = await fetch("/api/balance", {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j: any = await res.json();
      if (j?.error) msg = j.error;
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}

// 非流式测试：直接返回 TestResult。
// 始终返回 TestResult（不抛异常），网络/解析错误也归一为 ok:false 结果，
// 避免 detectRow 的 Promise.all 因单个协议失败而整体拒绝、探针卡在 testing。
export async function runTestJson(payload: TestPayload, signal?: AbortSignal): Promise<TestResult> {
  let res: Response;
  try {
    res = await fetch("/api/test", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ ...payload, stream: false }),
      signal,
    });
  } catch (e: any) {
    return {
      ok: false, status: 0, latencyMs: 0, ttftMs: null,
      usage: EMPTY_USAGE,
      text: "", error: e?.message ?? String(e), requestUrl: null, attempts: 0,
    };
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j: any = await res.json();
      if (j?.error) msg = j.error;
    } catch {}
    return {
      ok: false, status: res.status, latencyMs: 0, ttftMs: null,
      usage: EMPTY_USAGE,
      text: "", error: msg, requestUrl: null, attempts: 0,
    };
  }
  try {
    return await res.json();
  } catch (e: any) {
    return {
      ok: false, status: res.status, latencyMs: 0, ttftMs: null,
      usage: EMPTY_USAGE,
      text: "", error: `响应解析失败: ${e?.message ?? e}`, requestUrl: null, attempts: 0,
    };
  }
}

export async function runTestDual(payload: TestPayload, signal?: AbortSignal): Promise<DualTestResult> {
  let res: Response;
  try {
    res = await fetch("/api/test-dual", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (e: any) {
    const failed: TestResult = {
      ok: false, status: 0, latencyMs: 0, ttftMs: null,
      usage: EMPTY_USAGE,
      text: "", error: e?.message ?? String(e), requestUrl: null, attempts: 0,
    };
    return { json: failed, stream: failed, streamVerdict: "none", streamTtftMs: null };
  }

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j: any = await res.json();
      if (j?.error) msg = j.error;
    } catch {}
    const failed: TestResult = {
      ok: false, status: res.status, latencyMs: 0, ttftMs: null,
      usage: EMPTY_USAGE,
      text: "", error: msg, requestUrl: null, attempts: 0,
    };
    return { json: failed, stream: failed, streamVerdict: "none", streamTtftMs: null };
  }

  try {
    return await res.json();
  } catch (e: any) {
    const failed: TestResult = {
      ok: false, status: res.status, latencyMs: 0, ttftMs: null,
      usage: EMPTY_USAGE,
      text: "", error: `响应解析失败: ${e?.message ?? e}`, requestUrl: null, attempts: 0,
    };
    return { json: failed, stream: failed, streamVerdict: "none", streamTtftMs: null };
  }
}

// 流式测试：解析后端吐回的 SSE（每个 data: 是一个 StreamEvent），
// 通过 onEvent 回调逐事件上报，最终 resolve 出 done 事件里的 TestResult。
export async function runTestStream(
  payload: TestPayload,
  onEvent: (ev: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<TestResult> {
  let res: Response;
  try {
    res = await fetch("/api/test", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ ...payload, stream: true }),
      signal,
    });
  } catch (e: any) {
    const result: TestResult = {
      ok: false, status: 0, latencyMs: 0, ttftMs: null,
      usage: EMPTY_USAGE,
      text: "", error: e?.message ?? String(e), requestUrl: null, attempts: 0,
    };
    onEvent({ type: "error", error: result.error!, status: 0 });
    return result;
  }

  if (!res.ok || !res.body) {
    let msg = `HTTP ${res.status}`;
    try {
      const j: any = await res.json();
      if (j?.error) msg = j.error;
    } catch {}
    const result: TestResult = {
      ok: false, status: res.status, latencyMs: 0, ttftMs: null,
      usage: EMPTY_USAGE,
      text: "", error: msg, requestUrl: null, attempts: 0,
    };
    onEvent({ type: "error", error: msg, status: res.status });
    return result;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let finalResult: TestResult | null = null;

  const handleBlock = (block: string) => {
    const data = extractSseData(block);
    if (data === null || data === "[DONE]") return;
    let ev: StreamEvent;
    try {
      ev = JSON.parse(data);
    } catch {
      return;
    }
    onEvent(ev);
    if (ev.type === "done") finalResult = ev.result;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const { blocks, rest } = drainSseBlocks(buf);
      buf = rest;
      for (const block of blocks) handleBlock(block);
    }
    if (buf.trim()) handleBlock(buf);
  } catch (e: any) {
    // 流读取异常（连接中断等）：若已收到 done 则用之，否则返回错误结果。
    return (
      finalResult ?? {
        ok: false, status: 0, latencyMs: 0, ttftMs: null,
        usage: EMPTY_USAGE,
        text: "", error: e?.message ?? String(e), requestUrl: null, attempts: 0,
      }
    );
  }

  return (
    finalResult ?? {
      ok: false, status: 0, latencyMs: 0, ttftMs: null,
      usage: EMPTY_USAGE,
      text: "", error: "流式未返回最终结果", requestUrl: null, attempts: 0,
    }
  );
}
