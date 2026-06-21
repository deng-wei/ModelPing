import type { TestRequest, TestResult, Usage, StreamEvent } from "./types.js";
import { getAdapter, type Adapter, type StreamChunk } from "./adapters/index.js";
import { EMPTY_USAGE } from "./adapters/base.js";
import { withUserAgent } from "./user-agent.js";
import { drainSseBlocks, extractSseData } from "./sse.js";

// 单次输出文本展示上限，避免超长响应撑爆历史记录/前端。
const MAX_TEXT = 4000;
const MAX_ERROR_BODY = 1200;
const MAX_FAILURE_LOG = 6000;

// 合并 usage：以「最新出现的非空字段」覆盖。流式中 input 早出现、output 后出现，
// 各家末包给的可能是累计值也可能是增量值，这里统一取「见过的最大有效值」更稳。
export function mergeUsage(acc: Usage, next: Partial<Usage> | undefined): Usage {
  if (!next) return acc;
  const pick = (a: number | null, b: number | null | undefined) => {
    if (b == null) return a;
    if (a == null) return b;
    return Math.max(a, b); // 防止增量/累计混用导致回退
  };
  const inputTokens = pick(acc.inputTokens, next.inputTokens);
  const outputTokens = pick(acc.outputTokens, next.outputTokens);
  let totalTokens = pick(acc.totalTokens, next.totalTokens);
  if (totalTokens == null && inputTokens != null && outputTokens != null) {
    totalTokens = inputTokens + outputTokens;
  }
  return { inputTokens, outputTokens, totalTokens };
}

function truncate(s: string): string {
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + `…(已截断, 共${s.length}字符)` : s;
}

function truncateForLog(s: string, max = MAX_FAILURE_LOG): string {
  return s.length > max ? s.slice(0, max) + `\n...(日志已截断, 共${s.length}字符)` : s;
}

export function redactSecrets(text: string, req: TestRequest): string {
  let out = text;
  if (req.apiKey) out = out.split(req.apiKey).join("[REDACTED_API_KEY]");
  out = out.replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;"}&]+/gi, "$1[REDACTED]");
  out = out.replace(/((?:api[_-]?key|x-goog-api-key|x-api-key|access[_-]?token|token)\s*[:=]\s*)[^\s,;"}&]+/gi, "$1[REDACTED]");
  out = out.replace(/((?:api[_-]?key|key|token|access_token)=)[^&\s]+/gi, "$1[REDACTED]");
  return out;
}

export function sanitizeUrl(raw: string, req: TestRequest): string {
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) {
      if (/key|token|secret|authorization|auth/i.test(key)) url.searchParams.set(key, "[REDACTED]");
    }
    return redactSecrets(url.toString(), req);
  } catch {
    return redactSecrets(raw, req);
  }
}

export function isUnsupportedProtocol(status: number, bodyOrError = ""): boolean {
  if (status === 404 || status === 405 || status === 501) return true;
  if (status !== 400 && status !== 422) return false;

  const t = bodyOrError.toLowerCase();
  return [
    /unsupported\s+(api\s+)?protocol/,
    /unsupported\s+endpoint/,
    /endpoint\s+.*not\s+(found|supported|exist)/,
    /(no|unknown|unrecognized)\s+(route|endpoint|url|path)/,
    /(invalid|unknown|unrecognized)\s+(endpoint|url|path)/,
    /method\s+.*not\s+(allowed|supported)/,
    /cannot\s+(post|put|get|patch|delete)\b/,
    /route\s+.*not\s+found/,
    /path\s+.*not\s+found/,
  ].some((re) => re.test(t));
}

function failureFields(
  req: TestRequest,
  params: {
    url: string;
    status: number;
    latencyMs: number;
    attempt: number;
    error: string;
    body?: string;
    ttftMs?: number | null;
    partialText?: string;
  },
): Pick<TestResult, "failureKind" | "failureLog"> {
  const body = params.body ?? "";
  if (isUnsupportedProtocol(params.status, `${params.error}\n${body}`)) {
    return { failureKind: "unsupported_protocol", failureLog: null };
  }

  const lines = [
    "测试失败日志",
    `protocol: ${req.protocol}`,
    `model: ${req.model}`,
    `stream: ${req.stream ? "true" : "false"}`,
    `attempt: ${params.attempt}`,
    `requestUrl: ${sanitizeUrl(params.url, req)}`,
    `status: ${params.status || "network_error"}`,
    `latencyMs: ${params.latencyMs}`,
  ];
  if (params.ttftMs != null) lines.push(`ttftMs: ${params.ttftMs}`);
  if (params.partialText != null) lines.push(`partialTextChars: ${params.partialText.length}`);
  lines.push(`error: ${params.error}`);
  if (body) lines.push(`responseBody:\n${body.slice(0, MAX_ERROR_BODY)}`);

  return {
    failureKind: "request_failed",
    failureLog: truncateForLog(redactSecrets(lines.join("\n"), req)),
  };
}

// 判断是否值得重试：网络层错误(status 0)、超时、5xx、429。
export function retryable(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || (status >= 500 && status < 600);
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// 带超时的 fetch。外部取消优先于超时，并与内部 AbortController 合并。
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
  const ctrl = new AbortController();
  let timedOut = false;
  const onAbort = () => ctrl.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e: any) {
    if (signal?.aborted) throw abortError(signal);
    if (timedOut && e?.name === "AbortError") {
      const err = new Error(`请求超时 (${timeoutMs}ms)`);
      (err as any).isTimeout = true;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

// 提取错误体文本（限长），便于前端定位（如 401/400 的供应商报错）。
async function readErrorBody(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, MAX_ERROR_BODY);
  } catch {
    return "";
  }
}

// ---------- 非流式 ----------
async function runOnce(adapter: Adapter, req: TestRequest, attempt: number, signal?: AbortSignal): Promise<TestResult> {
  const url = adapter.buildUrl(req);
  const requestUrl = sanitizeUrl(url, req);
  const headers = withUserAgent(adapter.buildHeaders(req), req.userAgent);
  const body = JSON.stringify(adapter.buildBody(req));
  const start = Date.now();

  try {
    const res = await fetchWithTimeout(url, { method: "POST", headers, body }, req.timeoutMs, signal);
    if (!res.ok) {
      const errBody = await readErrorBody(res);
      const latencyMs = Date.now() - start;
      const error = `HTTP ${res.status}: ${errBody}`;
      return {
        ok: false, status: res.status, latencyMs, ttftMs: null,
        usage: { ...EMPTY_USAGE }, text: "", error, requestUrl, attempts: 1,
        ...failureFields(req, { url, status: res.status, latencyMs, attempt, error, body: errBody }),
      };
    }
    const json = await res.json();
    const latencyMs = Date.now() - start;
    const text = truncate(adapter.extractText(json));
    const usage = adapter.parseUsage(json);
    // HTTP 200 但响应不含任何 LLM 内容（无输出文本、无 token 用量），
    // 说明该 URL 大概率不是 LLM 端点（如普通网站/代理返回了空 JSON）。
    // 不应判为通过，否则用户会误以为测试走了正确的 API 却没有结果。
    if (!text && usage.inputTokens == null && usage.outputTokens == null && usage.totalTokens == null) {
      const error = `HTTP ${res.status} response contains no LLM content (no output text and no token usage); verify the URL points to a valid LLM endpoint`;
      return {
        ok: false, status: res.status, latencyMs, ttftMs: null,
        usage, text: "", error, requestUrl, attempts: 1,
        ...failureFields(req, { url, status: res.status, latencyMs, attempt, error }),
      };
    }
    return {
      ok: true, status: res.status, latencyMs, ttftMs: null,
      usage, text, error: null, requestUrl, attempts: 1,
    };
  } catch (e: any) {
    if (signal?.aborted) throw abortError(signal);
    const status = e?.isTimeout ? 408 : 0;
    const latencyMs = Date.now() - start;
    const error = e?.message ?? String(e);
    return {
      ok: false, status, latencyMs, ttftMs: null,
      usage: { ...EMPTY_USAGE }, text: "", error, requestUrl, attempts: 1,
      ...failureFields(req, { url, status, latencyMs, attempt, error }),
    };
  }
}

// ---------- 流式（内部生成器，逐事件 yield，最终 yield done） ----------
async function* runStreamOnce(adapter: Adapter, req: TestRequest, attempt: number, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
  const url = adapter.buildUrl(req);
  const requestUrl = sanitizeUrl(url, req);
  const headers = withUserAgent({ ...adapter.buildHeaders(req), accept: "text/event-stream" }, req.userAgent);
  const body = JSON.stringify(adapter.buildBody(req));
  const start = Date.now();
  let ttftMs: number | null = null;
  let usage: Usage = { ...EMPTY_USAGE };
  let text = "";

  // 流式专用的超时控制：连接 + 每次读取之间各自计时（idle 超时）。
  // 上游发完响应头后若挂住不再发数据，idle 计时器到点即 abort，避免读循环无限阻塞。
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const armTimer = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, req.timeoutMs);
  };
  const disarmTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const cleanup = () => {
    disarmTimer();
    signal?.removeEventListener("abort", onAbort);
  };

  let res: Response;
  armTimer();
  try {
    res = await fetch(url, { method: "POST", headers, body, signal: ctrl.signal });
  } catch (e: any) {
    cleanup();
    if (signal?.aborted) return;
    const isTimeout = timedOut || e?.name === "AbortError";
    const status = isTimeout ? 408 : 0;
    const latencyMs = Date.now() - start;
    const error = isTimeout ? `请求超时 (${req.timeoutMs}ms)` : (e?.message ?? String(e));
    yield { type: "error", error, status };
    yield {
      type: "done",
      result: {
        ok: false, status, latencyMs, ttftMs: null, usage, text: "", error, requestUrl, attempts: 1,
        ...failureFields(req, { url, status, latencyMs, attempt, error }),
      },
    };
    return;
  }

  if (!res.ok || !res.body) {
    cleanup();
    const errBody = await readErrorBody(res);
    const error = `HTTP ${res.status}: ${errBody}`;
    const latencyMs = Date.now() - start;
    yield { type: "error", error, status: res.status };
    yield {
      type: "done",
      result: {
        ok: false, status: res.status, latencyMs, ttftMs: null, usage, text: "", error, requestUrl, attempts: 1,
        ...failureFields(req, { url, status: res.status, latencyMs, attempt, error, body: errBody }),
      },
    };
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  // 处理一个完整 SSE 事件块（多行）。聚合所有 data: 行，跳过 [DONE]。
  const handleEventBlock = (block: string): StreamEvent[] => {
    const events: StreamEvent[] = [];
    const data = extractSseData(block);
    if (data === null || data === "[DONE]") return events;

    let payload: any;
    try {
      payload = JSON.parse(data);
    } catch {
      return events; // 非 JSON 的保活行等，忽略
    }
    const chunk: StreamChunk | null = adapter.parseStreamChunk(payload);
    if (!chunk) return events;
    if (chunk.text) {
      if (ttftMs === null) {
        ttftMs = Date.now() - start;
        events.push({ type: "ttft", ttftMs });
      }
      text += chunk.text;
      events.push({ type: "delta", text: chunk.text });
    }
    if (chunk.usage) {
      usage = mergeUsage(usage, chunk.usage);
      events.push({ type: "usage", usage });
    }
    return events;
  };

  try {
    while (true) {
      armTimer(); // 每次读取前重置 idle 计时器；读到数据或正常结束即解除。
      const { done, value } = await reader.read();
      if (done) {
        cleanup();
        break;
      }
      disarmTimer();
      buf += decoder.decode(value, { stream: true });
      // SSE 事件以空行分隔
      const { blocks, rest } = drainSseBlocks(buf);
      buf = rest;
      for (const block of blocks) {
        for (const ev of handleEventBlock(block)) yield ev;
      }
    }
    // 处理残留缓冲
    if (buf.trim()) for (const ev of handleEventBlock(buf)) yield ev;
  } catch (e: any) {
    cleanup();
    if (signal?.aborted) return;
    const isTimeout = timedOut || e?.name === "AbortError" || e?.isTimeout;
    const error = isTimeout ? `流式读取超时 (${req.timeoutMs}ms)` : (e?.message ?? String(e));
    const status = isTimeout ? 408 : 0;
    const latencyMs = Date.now() - start;
    yield { type: "error", error, status };
    yield {
      type: "done",
      result: {
        ok: false, status, latencyMs, ttftMs, usage, text: truncate(text), error, requestUrl, attempts: 1,
        ...failureFields(req, { url, status, latencyMs, attempt, error, ttftMs, partialText: text }),
      },
    };
    return;
  }

  cleanup();
  const finalText = truncate(text);
  const streamLatencyMs = Date.now() - start;
  // 流式正常结束但无任何 LLM 内容（无输出文本、无 token 用量），
  // 说明该 URL 大概率不是 LLM 端点。与非流式 runOnce 保持一致判定。
  if (!finalText && usage.inputTokens == null && usage.outputTokens == null && usage.totalTokens == null) {
    const error = `HTTP ${res.status} response contains no LLM content (no output text and no token usage); verify the URL points to a valid LLM endpoint`;
    yield {
      type: "done",
      result: {
        ok: false, status: res.status, latencyMs: streamLatencyMs, ttftMs, usage, text: "", error, requestUrl, attempts: 1,
        ...failureFields(req, { url, status: res.status, latencyMs: streamLatencyMs, attempt, error }),
      },
    };
    return;
  }
  yield {
    type: "done",
    result: { ok: true, status: res.status, latencyMs: streamLatencyMs, ttftMs, usage, text: finalText, error: null, requestUrl, attempts: 1 },
  };
}

// ---------- 对外：非流式（含重试） ----------
export async function runTest(req: TestRequest, signal?: AbortSignal): Promise<TestResult> {
  signal?.throwIfAborted();
  const adapter = getAdapter(req.protocol);
  if (!adapter) {
    return { ok: false, status: 0, latencyMs: 0, ttftMs: null, usage: { ...EMPTY_USAGE }, text: "", error: `未知协议: ${req.protocol}`, requestUrl: null, attempts: 0 };
  }

  let last: TestResult | null = null;
  for (let attempt = 1; attempt <= req.maxRetries + 1; attempt++) {
    const r = await runOnce(adapter, req, attempt, signal);
    r.attempts = attempt;
    if (r.ok || !retryable(r.status) || attempt > req.maxRetries) {
      return r;
    }
    last = r;
    await sleep(Math.min(500 * 2 ** (attempt - 1), 4000), signal); // 指数退避，封顶 4s
  }
  return last!;
}

// ---------- 对外：流式（含重试，整轮失败才重试） ----------
// 返回一个 SSE 字符串的 ReadableStream，供 Hono c.body 直接返回。
export function runTestStream(req: TestRequest, signal?: AbortSignal): ReadableStream<Uint8Array> {
  const adapter = getAdapter(req.protocol);
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (ev: StreamEvent) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));

      if (!adapter) {
        send({ type: "error", error: `未知协议: ${req.protocol}` });
        send({ type: "done", result: { ok: false, status: 0, latencyMs: 0, ttftMs: null, usage: { ...EMPTY_USAGE }, text: "", error: `未知协议: ${req.protocol}`, requestUrl: null, attempts: 0 } });
        controller.close();
        return;
      }

      for (let attempt = 1; attempt <= req.maxRetries + 1; attempt++) {
        let finalResult: TestResult | null = null;
        let producedDelta = false;

        for await (const ev of runStreamOnce(adapter, req, attempt, signal)) {
          if (ev.type === "done") {
            finalResult = ev.result;
            finalResult.attempts = attempt;
            break;
          }
          if (ev.type === "delta") producedDelta = true;
          // 重试前不向前端透传中途事件，避免重复输出；首轮或最后一轮才透传。
          if (attempt === 1 || attempt > req.maxRetries) send(ev);
        }

        if (!finalResult) break;

        const shouldRetry =
          !finalResult.ok && !producedDelta && retryable(finalResult.status) && attempt <= req.maxRetries;

        if (!shouldRetry) {
          // 透传最终 done（无论本轮中途事件是否被静默，done 都要发）
          send({ type: "done", result: finalResult });
          controller.close();
          return;
        }

        try {
          await sleep(Math.min(500 * 2 ** (attempt - 1), 4000), signal);
        } catch (error) {
          if (signal?.aborted) {
            controller.close();
            return;
          }
          throw error;
        }
      }
      controller.close();
    },
  });
}
