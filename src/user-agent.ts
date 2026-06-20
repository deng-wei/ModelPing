// User-Agent override helper.
// Empty/whitespace means "do not set". Invalid control characters are ignored
// instead of failing a request path, matching cc-switch's tolerant runtime design.

// HTTP header values must not contain control characters except HTAB.
// 单一来源：前端校验（web/lib/user-agent.ts）复用此函数，避免正则漂移。
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x08\x0a-\x1f\x7f]/;

export function hasControlChars(value: string): boolean {
  return CONTROL_CHARS.test(value);
}

export function normalizeUserAgent(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return hasControlChars(trimmed) ? undefined : trimmed;
}

export function withUserAgent<T extends Record<string, string>>(headers: T, value: unknown): T {
  const userAgent = normalizeUserAgent(value);
  return userAgent ? { ...headers, "user-agent": userAgent } : headers;
}
