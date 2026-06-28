// 协议族标识。不同协议族对应不同的请求构造、响应解析、流式解析逻辑。
export type Protocol = "openai-chat" | "openai-responses" | "gemini" | "anthropic";

// 前端 → 后端的测试请求体。后端是无状态代理，apiKey 仅用于本次转发，绝不存储/打印。
export interface TestRequest {
  protocol: Protocol;
  baseUrl: string;
  isFullUrl?: boolean; // true 时 baseUrl 已是完整请求 URL，不再追加协议路径。
  apiKey: string;
  model: string;
  input: string;
  stream: boolean;
  timeoutMs: number;   // 单次请求超时（含每次重试各自计时）
  maxRetries: number;  // 失败重试次数（指数退避，仅网络/超时/5xx）
  maxTokens: number;   // 输出 token 上限
  userAgent: string;   // 可选 User-Agent；空串表示不覆盖运行时默认 UA。
}

// token 消耗。各协议字段名不同，统一归一为这三个。
export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

// 后端 → 前端的统一测试结果（非流式，或流式聚合后的最终结果）。
export interface TestResult {
  ok: boolean;
  status: number;          // HTTP 状态码（0 表示请求未发出/网络层失败）
  latencyMs: number;       // 总延迟（发起 → 完成）
  ttftMs: number | null;   // 首 token 延迟（仅流式有意义）
  usage: Usage;
  text: string;            // 模型输出文本（截断展示）
  error: string | null;    // 失败原因
  requestUrl?: string | null; // 脱敏后的最终请求 URL，便于复盘。
  failureLog?: string | null; // 可复盘失败日志；协议不支持类失败不返回
  failureKind?: "unsupported_protocol" | "request_failed" | null;
  attempts: number;        // 实际尝试次数
}

// 流式时后端经 SSE 吐给前端的事件。最终以 done 收尾并携带完整 TestResult。
export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "usage"; usage: Usage }
  | { type: "ttft"; ttftMs: number }
  | { type: "done"; result: TestResult }
  | { type: "error"; error: string; status?: number };

// ---------- 预设（供应商 / 模型 / 默认参数） ----------
// 持久化到服务端并跨设备共享的「设置」。不含 apiKey。
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

// ---------- 余额 / 模型列表（即时查询，不持久化） ----------
// 前端 → 后端：仅转发本次查询所需的连接信息。apiKey 绝不存储/打印。
export interface LookupRequest {
  baseUrl: string;
  isFullUrl?: boolean;
  apiKey: string;
  userAgent?: string; // 可选 User-Agent；用于模型列表/余额等辅助请求。
}

// 统一余额结构。各家字段不同，归一为这几个；不支持的 host 返回 supported:false。
export interface Balance {
  supported: boolean;
  remaining: number | null; // 可用余额
  total: number | null;     // 总额度（如 OpenRouter）
  used: number | null;      // 已用（如 OpenRouter）
  currency: string | null;  // 币种/单位
  isValid?: boolean | null;  // 账户/额度是否有效（如 DeepSeek is_available）
}

// 模型列表查询结果。
export interface ModelsResult {
  models: string[];
}

// ---------- 端点延迟测速（ping，不消耗 token） ----------
// 前端 → 后端：测速所需连接信息 + 协议/模型。优先 GET /models，无该端点时回退最小补全。
export interface PingRequest {
  protocol: Protocol;
  baseUrl: string;
  isFullUrl?: boolean;
  apiKey: string;
  model: string;
  userAgent?: string;
}

// 测速结果。kind 标明走的是 models 探测还是补全回退。
export interface PingResult {
  ok: boolean;
  status: number;                  // HTTP 状态码（0=网络层失败）
  latencyMs: number;
  kind: "models" | "completion";
  error: string | null;
}

// ---------- 状态列表（持久化到后端，加密落盘） ----------
// 含 apiKey；仅以密文存储（src/crypto.ts），且受 APP_PASSWORD 中间件保护。
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

// ---------- 私有工作态（后端加密持久化，跨设备） ----------
// 含历史、连接、测试参数、状态页条目等敏感数据；仅加密落盘。
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

export interface HistoryEntry {
  id: string;
  ts: number;
  providerName: string;
  protocol: Protocol;
  baseUrl: string;
  isFullUrl?: boolean;
  apiKey: string;
  userAgent?: string;
  model: string;
  modelLabel: string;
  streamVerdict: "stream" | "single" | "none" | null;
  result: TestResult;
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
