import { describe, it, expect } from "vitest";
import type { TestRequest } from "../types.js";
import {
  buildOpenAiUrl,
  buildAnthropicUrl,
  buildGeminiUrl,
  normalizeGeminiModelId,
  isOriginOnlyUrl,
  trimSlash,
  num,
} from "./base.js";

// 构造一个最小 TestRequest，只关心 URL 构造相关字段。
function req(over: Partial<TestRequest>): TestRequest {
  return {
    protocol: "openai-chat",
    baseUrl: "",
    apiKey: "k",
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

describe("trimSlash / isOriginOnlyUrl", () => {
  it("trims trailing slashes", () => {
    expect(trimSlash("https://a.com/")).toBe("https://a.com");
    expect(trimSlash("https://a.com///")).toBe("https://a.com");
    expect(trimSlash("https://a.com/v1")).toBe("https://a.com/v1");
  });

  it("detects origin-only URLs", () => {
    expect(isOriginOnlyUrl("https://a.com")).toBe(true);
    expect(isOriginOnlyUrl("https://a.com/")).toBe(true);
    expect(isOriginOnlyUrl("https://a.com/v1")).toBe(false);
    expect(isOriginOnlyUrl("https://a.com/v1/chat")).toBe(false);
  });
});

describe("buildOpenAiUrl", () => {
  it("appends /v1/chat/completions to origin-only base", () => {
    expect(buildOpenAiUrl(req({ baseUrl: "https://api.x.com" }), "chat/completions")).toBe(
      "https://api.x.com/v1/chat/completions",
    );
  });

  it("appends path directly when base already ends with /v1", () => {
    expect(buildOpenAiUrl(req({ baseUrl: "https://api.x.com/v1" }), "chat/completions")).toBe(
      "https://api.x.com/v1/chat/completions",
    );
  });

  it("collapses duplicate /v1/v1", () => {
    expect(buildOpenAiUrl(req({ baseUrl: "https://api.x.com/v1/v1" }), "responses")).toBe(
      "https://api.x.com/v1/responses",
    );
  });

  it("passes through full URL untouched (minus hash)", () => {
    expect(
      buildOpenAiUrl(req({ baseUrl: "https://api.x.com/custom/path#frag", isFullUrl: true }), "chat/completions"),
    ).toBe("https://api.x.com/custom/path");
  });

  it("preserves query string", () => {
    expect(buildOpenAiUrl(req({ baseUrl: "https://api.x.com?api-version=1" }), "chat/completions")).toBe(
      "https://api.x.com/v1/chat/completions?api-version=1",
    );
  });

  it("uses non-v1 base path as-is", () => {
    expect(buildOpenAiUrl(req({ baseUrl: "https://api.x.com/openai" }), "chat/completions")).toBe(
      "https://api.x.com/openai/chat/completions",
    );
  });
});

describe("buildAnthropicUrl", () => {
  it("appends /v1/messages to origin", () => {
    expect(buildAnthropicUrl(req({ baseUrl: "https://api.anthropic.com" }))).toBe(
      "https://api.anthropic.com/v1/messages",
    );
  });

  it("collapses duplicate version segment", () => {
    expect(buildAnthropicUrl(req({ baseUrl: "https://api.anthropic.com/v1" }))).toBe(
      "https://api.anthropic.com/v1/messages",
    );
  });

  it("honors isFullUrl", () => {
    expect(buildAnthropicUrl(req({ baseUrl: "https://proxy/m", isFullUrl: true }))).toBe("https://proxy/m");
  });
});

describe("normalizeGeminiModelId", () => {
  it("strips models/ prefix and leading slashes", () => {
    expect(normalizeGeminiModelId("models/gemini-1.5-pro")).toBe("gemini-1.5-pro");
    expect(normalizeGeminiModelId("/gemini-1.5-pro")).toBe("gemini-1.5-pro");
    expect(normalizeGeminiModelId("gemini-1.5-pro")).toBe("gemini-1.5-pro");
  });
});

describe("buildGeminiUrl", () => {
  it("builds non-stream generateContent from origin", () => {
    expect(buildGeminiUrl(req({ protocol: "gemini", baseUrl: "https://gl.googleapis.com", model: "gemini-1.5-pro" }))).toBe(
      "https://gl.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent",
    );
  });

  it("builds stream URL with alt=sse", () => {
    expect(
      buildGeminiUrl(
        req({ protocol: "gemini", baseUrl: "https://gl.googleapis.com", model: "gemini-1.5-pro", stream: true }),
      ),
    ).toBe("https://gl.googleapis.com/v1beta/models/gemini-1.5-pro:streamGenerateContent?alt=sse");
  });

  it("strips existing version/openai suffixes from base", () => {
    expect(buildGeminiUrl(req({ protocol: "gemini", baseUrl: "https://gl.googleapis.com/v1beta", model: "g" }))).toBe(
      "https://gl.googleapis.com/v1beta/models/g:generateContent",
    );
  });

  it("rewrites verb on structured full URL", () => {
    expect(
      buildGeminiUrl(
        req({
          protocol: "gemini",
          baseUrl: "https://gl.googleapis.com/v1beta/models/g:generateContent",
          model: "g",
          isFullUrl: true,
          stream: true,
        }),
      ),
    ).toBe("https://gl.googleapis.com/v1beta/models/g:streamGenerateContent?alt=sse");
  });
});

describe("num", () => {
  it("returns finite numbers, null otherwise", () => {
    expect(num(5)).toBe(5);
    expect(num(0)).toBe(0);
    expect(num(NaN)).toBeNull();
    expect(num("5")).toBeNull();
    expect(num(undefined)).toBeNull();
    expect(num(null)).toBeNull();
  });
});
