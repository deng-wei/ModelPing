import type { Balance, ModelsResult, PresetsResponse, StreamEvent, TestResult, Usage } from "./types.js";
import { normalizePresets } from "./presets.js";

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

export async function fetchHealth(): Promise<{ ok: boolean; needPassword: boolean }> {
  const res = await fetch("/api/health");
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
export async function runTestJson(payload: TestPayload): Promise<TestResult> {
  const res = await fetch("/api/test", {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ ...payload, stream: false }),
  });
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
  return res.json();
}

// 流式测试：解析后端吐回的 SSE（每个 data: 是一个 StreamEvent），
// 通过 onEvent 回调逐事件上报，最终 resolve 出 done 事件里的 TestResult。
export async function runTestStream(
  payload: TestPayload,
  onEvent: (ev: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<TestResult> {
  const res = await fetch("/api/test", {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ ...payload, stream: true }),
    signal,
  });

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
    const line = block.split(/\r?\n/).find((l) => l.startsWith("data:"));
    if (!line) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let ev: StreamEvent;
    try {
      ev = JSON.parse(data);
    } catch {
      return;
    }
    onEvent(ev);
    if (ev.type === "done") finalResult = ev.result;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + (buf[idx] === "\r" ? 4 : 2));
      handleBlock(block);
    }
  }
  if (buf.trim()) handleBlock(buf);

  return (
    finalResult ?? {
      ok: false, status: 0, latencyMs: 0, ttftMs: null,
      usage: EMPTY_USAGE,
      text: "", error: "流式未返回最终结果", requestUrl: null, attempts: 0,
    }
  );
}
