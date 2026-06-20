// User-Agent override helper.
// Empty/whitespace means "do not set". Invalid control characters are ignored
// instead of failing a request path, matching cc-switch's tolerant runtime design.

export function normalizeUserAgent(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  // HTTP header values must not contain control characters except HTAB.
  // eslint-disable-next-line no-control-regex
  return /[\x00-\x08\x0a-\x1f\x7f]/.test(trimmed) ? undefined : trimmed;
}

export function withUserAgent<T extends Record<string, string>>(headers: T, value: unknown): T {
  const userAgent = normalizeUserAgent(value);
  return userAgent ? { ...headers, "user-agent": userAgent } : headers;
}
