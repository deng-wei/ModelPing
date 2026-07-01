// 前端用到的类型，镜像后端 src/types.ts（结构一致，TS 结构化兼容）。
// 注：preset 的校验逻辑（normalizePresets）已下沉到 src/presets-schema.ts，前后端单一来源；
// 这里仅保留类型声明，避免业务组件直接 import 后端目录。
export type Protocol = "openai-chat" | "openai-responses" | "gemini" | "anthropic";

export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface TestResult {
  ok: boolean;
  status: number;
  latencyMs: number;
  ttftMs: number | null;
  usage: Usage;
  text: string;
  error: string | null;
  requestUrl?: string | null;
  failureLog?: string | null;
  failureKind?: "unsupported_protocol" | "request_failed" | null;
  attempts: number;
}

export interface DualTestResult {
  json: TestResult;
  stream: TestResult;
  streamVerdict: "stream" | "single" | "none";
  streamTtftMs: number | null;
}

export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "usage"; usage: Usage }
  | { type: "ttft"; ttftMs: number }
  | { type: "done"; result: TestResult }
  | { type: "error"; error: string; status?: number };

// 流式探测结论：
//   "stream" 真增量流式（收到 ≥1 个 delta）
//   "single" 服务端接受 stream:true 但一次性返回（无增量，非真流式）
//   "none"   流式请求失败
//   null     未探测
export type StreamVerdict = "stream" | "single" | "none" | null;

export interface ModelPreset {
  id: string;     // 实际请求时传给供应商的 model id。
  label?: string; // 官方原始模型名；未填时使用 id，用于展示和跨供应商去重。
}

export interface ProviderPreset {
  id: string;
  name: string;
  baseUrl: string;
  isFullUrl?: boolean;
  keyHint?: string;
  docs?: string;
  models: ModelPreset[];
}

export interface Defaults {
  input: string;
  stream: boolean;
  timeoutMs: number;
  maxRetries: number;
  maxTokens: number;
  userAgent: string;
  concurrency: number;
}

export interface PresetsResponse {
  providers: ProviderPreset[];
  defaults: Defaults;
}

// ---------- 余额 / 模型列表（即时查询，镜像后端 src/types.ts） ----------
export interface Balance {
  supported: boolean;
  remaining: number | null;
  total: number | null;
  used: number | null;
  currency: string | null;
  isValid?: boolean | null;
}

export interface ModelsResult {
  models: string[];
}

// ---------- 端点延迟测速（ping，镜像后端 src/types.ts） ----------
export interface PingResult {
  ok: boolean;
  status: number;                  // HTTP 状态码（0=网络层失败）
  latencyMs: number;
  kind: "models" | "completion";   // 测速走的路径
  error: string | null;
}

// ---------- 状态列表条目（持久化到后端，加密落盘） ----------
// 含 apiKey；仅经后端加密存储，前端不再明文落 localStorage。
export interface StatusEntry {
  id: string;
  providerName: string;
  protocol: Protocol;
  baseUrl: string;
  isFullUrl?: boolean;
  apiKey: string;
  userAgent?: string;
  model: string;
}

export interface ConnState {
  providerId: string;
  baseUrl: string;
  isFullUrl?: boolean;
  apiKey: string;
}

export interface ConfigState {
  input: string;
  timeoutMs: number;
  maxRetries: number;
  maxTokens: number;
  userAgent: string;
  concurrency: number;
}

// 一条历史记录（每条 = 一个「模型 × 协议」的探测结果）。
export interface HistoryEntry {
  id: string;
  ts: number;            // 测试时间戳
  providerName: string;  // 供应商显示名
  protocol: Protocol;
  baseUrl: string;
  isFullUrl?: boolean;
  apiKey: string;        // 仅存于浏览器；展示时掩码，可复制
  userAgent?: string;    // 可选 User-Agent；空值不设置。
  model: string;
  modelLabel: string;
  streamVerdict: StreamVerdict; // 流式探测结论（stream/single/none/null）
  result: TestResult;    // 非流式探测结果
}

export interface PrivateState {
  v: 1;
  historyPersist: boolean;
  history: HistoryEntry[];
  conn: ConnState | null;
  config: Partial<ConfigState> | null;
  statusEntries: StatusEntry[];
  updatedAt: number;
}
