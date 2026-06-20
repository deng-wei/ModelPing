import { describe, it, expect } from "vitest";
import type { TestRequest, Usage } from "./types.js";
import { redactSecrets, sanitizeUrl, mergeUsage, isUnsupportedProtocol, retryable } from "./runner.js";

function req(over: Partial<TestRequest> = {}): TestRequest {
  return {
    protocol: "openai-chat",
    baseUrl: "https://api.x.com",
    apiKey: "sk-secret-123",
    model: "m",
    input: "hi",
    stream: false,
    timeoutMs: 30000,
    maxRetries: 0,
    maxTokens: 64,
    userAgent: "",
    ...over,
  };
}

const NIL: Usage = { inputTokens: null, outputTokens: null, totalTokens: null };

describe("redactSecrets", () => {
  it("redacts the exact apiKey wherever it appears", () => {
    const out = redactSecrets("key=sk-secret-123 and again sk-secret-123", req());
    expect(out).not.toContain("sk-secret-123");
    expect(out).toContain("[REDACTED_API_KEY]");
  });

  it("redacts Authorization Bearer tokens", () => {
    const out = redactSecrets("Authorization: Bearer abc.def.ghi", req({ apiKey: "" }));
    expect(out).toBe("Authorization: Bearer [REDACTED]");
  });

  it("redacts x-api-key / x-goog-api-key header values", () => {
    expect(redactSecrets("x-api-key: zzz999", req({ apiKey: "" }))).toContain("[REDACTED]");
    expect(redactSecrets("x-goog-api-key: zzz999", req({ apiKey: "" }))).toContain("[REDACTED]");
    expect(redactSecrets("x-api-key: zzz999", req({ apiKey: "" }))).not.toContain("zzz999");
  });

  it("redacts token=... in query-style strings", () => {
    const out = redactSecrets("https://h/p?token=abc123&x=1", req({ apiKey: "" }));
    expect(out).not.toContain("abc123");
    expect(out).toContain("x=1");
  });
});

describe("sanitizeUrl", () => {
  it("redacts sensitive query params", () => {
    const out = sanitizeUrl("https://h/p?key=abc&token=def&safe=1", req({ apiKey: "" }));
    expect(out).not.toContain("abc");
    expect(out).not.toContain("def");
    expect(out).toContain("safe=1");
  });

  it("redacts the apiKey embedded in the path", () => {
    const out = sanitizeUrl("https://h/sk-secret-123/chat", req());
    expect(out).not.toContain("sk-secret-123");
  });

  it("falls back to redactSecrets on non-URL input", () => {
    expect(sanitizeUrl("not a url sk-secret-123", req())).not.toContain("sk-secret-123");
  });
});

describe("mergeUsage", () => {
  it("returns acc unchanged when next is undefined", () => {
    expect(mergeUsage(NIL, undefined)).toEqual(NIL);
  });

  it("fills nulls from next", () => {
    expect(mergeUsage(NIL, { inputTokens: 10 })).toEqual({ inputTokens: 10, outputTokens: null, totalTokens: null });
  });

  it("keeps the max value (guards against incremental/cumulative regress)", () => {
    expect(mergeUsage({ inputTokens: 10, outputTokens: 50, totalTokens: null }, { outputTokens: 30 }).outputTokens).toBe(
      50,
    );
    expect(mergeUsage({ inputTokens: 10, outputTokens: 50, totalTokens: null }, { outputTokens: 80 }).outputTokens).toBe(
      80,
    );
  });

  it("derives total when input+output known but total missing", () => {
    expect(mergeUsage(NIL, { inputTokens: 10, outputTokens: 20 }).totalTokens).toBe(30);
  });
});

describe("isUnsupportedProtocol", () => {
  it("treats 404/405/501 as unsupported", () => {
    expect(isUnsupportedProtocol(404)).toBe(true);
    expect(isUnsupportedProtocol(405)).toBe(true);
    expect(isUnsupportedProtocol(501)).toBe(true);
  });

  it("matches body phrases on 400/422", () => {
    expect(isUnsupportedProtocol(400, "Unsupported protocol")).toBe(true);
    expect(isUnsupportedProtocol(422, "route not found")).toBe(true);
    expect(isUnsupportedProtocol(400, "invalid api key")).toBe(false);
  });

  it("ignores other statuses", () => {
    expect(isUnsupportedProtocol(401, "unsupported endpoint")).toBe(false);
    expect(isUnsupportedProtocol(200)).toBe(false);
  });
});

describe("retryable", () => {
  it("retries network(0)/408/429/5xx only", () => {
    expect(retryable(0)).toBe(true);
    expect(retryable(408)).toBe(true);
    expect(retryable(429)).toBe(true);
    expect(retryable(500)).toBe(true);
    expect(retryable(503)).toBe(true);
    expect(retryable(400)).toBe(false);
    expect(retryable(401)).toBe(false);
    expect(retryable(404)).toBe(false);
  });
});
