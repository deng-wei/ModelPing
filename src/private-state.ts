import type { ConfigState, ConnState, HistoryEntry, PrivateState, Protocol, StatusEntry, TestResult } from "./types.js";

const PROTOCOLS: Protocol[] = ["openai-chat", "openai-responses", "gemini", "anthropic"];
export const MAX_PRIVATE_HISTORY = 200;

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

function protocolOf(value: unknown): Protocol | null {
  const protocol = String(value ?? "").trim();
  return PROTOCOLS.includes(protocol as Protocol) ? protocol as Protocol : null;
}

function intOrNull(value: unknown, min: number, max: number): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function normalizeTestResult(raw: any): TestResult {
  const usage = raw?.usage && typeof raw.usage === "object" ? raw.usage : {};
  return {
    ok: Boolean(raw?.ok),
    status: intOrNull(raw?.status, 0, 999) ?? 0,
    latencyMs: intOrNull(raw?.latencyMs, 0, 24 * 60 * 60 * 1000) ?? 0,
    ttftMs: raw?.ttftMs == null ? null : intOrNull(raw.ttftMs, 0, 24 * 60 * 60 * 1000),
    usage: {
      inputTokens: usage.inputTokens == null ? null : intOrNull(usage.inputTokens, 0, 1_000_000_000),
      outputTokens: usage.outputTokens == null ? null : intOrNull(usage.outputTokens, 0, 1_000_000_000),
      totalTokens: usage.totalTokens == null ? null : intOrNull(usage.totalTokens, 0, 1_000_000_000),
    },
    text: String(raw?.text ?? "").slice(0, 200_000),
    error: raw?.error == null ? null : String(raw.error).slice(0, 20_000),
    requestUrl: raw?.requestUrl == null ? null : String(raw.requestUrl).slice(0, 20_000),
    failureLog: raw?.failureLog == null ? null : String(raw.failureLog).slice(0, 100_000),
    failureKind: raw?.failureKind === "unsupported_protocol" || raw?.failureKind === "request_failed" ? raw.failureKind : null,
    attempts: intOrNull(raw?.attempts, 0, 100) ?? 0,
  };
}

export function normalizeStatusEntries(raw: unknown): StatusEntry[] {
  if (!Array.isArray(raw)) throw new Error("状态列表须为数组");
  const out: StatusEntry[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const item = e as any;
    const protocol = protocolOf(item.protocol);
    const baseUrl = String(item.baseUrl ?? "").trim();
    const model = String(item.model ?? "").trim();
    const id = String(item.id ?? "").trim();
    if (!id || !baseUrl || !model || !protocol) continue;
    out.push({
      id,
      providerName: String(item.providerName ?? ""),
      protocol,
      baseUrl,
      isFullUrl: Boolean(item.isFullUrl),
      apiKey: String(item.apiKey ?? ""),
      userAgent: typeof item.userAgent === "string" ? item.userAgent : undefined,
      model,
    });
  }
  return out;
}

function normalizeHistory(raw: unknown): HistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: HistoryEntry[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const item = e as any;
    const protocol = protocolOf(item.protocol);
    const id = String(item.id ?? "").trim();
    const model = String(item.model ?? "").trim();
    const modelLabel = String(item.modelLabel ?? "").trim();
    const baseUrl = String(item.baseUrl ?? "").trim();
    if (!id || !protocol || !model || !modelLabel || !baseUrl) continue;
    const streamVerdict = item.streamVerdict === "stream" || item.streamVerdict === "single" || item.streamVerdict === "none"
      ? item.streamVerdict
      : null;
    out.push({
      id,
      ts: intOrNull(item.ts, 0, 99_999_999_999_999) ?? Date.now(),
      providerName: String(item.providerName ?? ""),
      protocol,
      baseUrl,
      isFullUrl: Boolean(item.isFullUrl),
      apiKey: String(item.apiKey ?? ""),
      userAgent: typeof item.userAgent === "string" ? item.userAgent : undefined,
      model,
      modelLabel,
      streamVerdict,
      result: normalizeTestResult(item.result),
    });
  }
  return out.slice(0, MAX_PRIVATE_HISTORY);
}

function normalizeConn(raw: unknown): ConnState | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as any;
  const providerId = String(item.providerId ?? "").trim();
  if (!providerId) return null;
  return {
    providerId,
    baseUrl: String(item.baseUrl ?? "").trim(),
    isFullUrl: Boolean(item.isFullUrl),
    apiKey: String(item.apiKey ?? ""),
  };
}

function normalizeConfig(raw: unknown): Partial<ConfigState> | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as any;
  const out: Partial<ConfigState> = {};
  if (typeof item.input === "string") out.input = item.input;
  const timeoutMs = intOrNull(item.timeoutMs, 1000, 600000);
  if (timeoutMs != null) out.timeoutMs = timeoutMs;
  const maxRetries = intOrNull(item.maxRetries, 0, 10);
  if (maxRetries != null) out.maxRetries = maxRetries;
  const maxTokens = intOrNull(item.maxTokens, 1, 200000);
  if (maxTokens != null) out.maxTokens = maxTokens;
  if (typeof item.userAgent === "string") out.userAgent = item.userAgent;
  const concurrency = intOrNull(item.concurrency, 1, 10);
  if (concurrency != null) out.concurrency = concurrency;
  return Object.keys(out).length ? out : null;
}

export function normalizePrivateState(raw: unknown): PrivateState {
  const defaults = emptyPrivateState();
  if (!raw || typeof raw !== "object") return defaults;
  const item = raw as any;
  return {
    v: 1,
    historyPersist: item.historyPersist !== false,
    history: normalizeHistory(item.history),
    conn: normalizeConn(item.conn),
    config: normalizeConfig(item.config),
    statusEntries: normalizeStatusEntries(Array.isArray(item.statusEntries) ? item.statusEntries : []),
    updatedAt: intOrNull(item.updatedAt, 0, 99_999_999_999_999) ?? Date.now(),
  };
}
