import type { Defaults, PresetsResponse, ProviderPreset } from "./types.js";

// 预设校验逻辑，前后端共享（前端经 web/lib/presets.ts re-export，后端 PUT /api/settings 直接用）。
// 纯函数、无 DOM / localStorage 依赖，可在 Node / Workers / 浏览器任意环境运行。

export const CUSTOM_PROVIDER_ID = "custom";
export const CUSTOM_PROVIDER_NAME = "自定义";

export const FALLBACK_DEFAULTS: Defaults = {
  input: "你好，请用一句话自我介绍。",
  stream: false,
  timeoutMs: 30000,
  maxRetries: 1,
  maxTokens: 512,
  userAgent: "",
};

function asRecord(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("配置必须是 JSON 对象");
  return v as Record<string, unknown>;
}

function cleanString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function optionalString(v: unknown): string | undefined {
  const s = cleanString(v);
  return s ? s : undefined;
}

function numberDefault(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function assertHttpUrl(value: string, label: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} 不是合法 URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} 必须以 http:// 或 https:// 开头`);
  }
}

export function normalizePresets(raw: unknown): PresetsResponse {
  const obj = asRecord(raw);
  const defaultsRaw = asRecord(obj.defaults ?? FALLBACK_DEFAULTS);
  const defaults: Defaults = {
    input: typeof defaultsRaw.input === "string" ? defaultsRaw.input : FALLBACK_DEFAULTS.input,
    stream: Boolean(defaultsRaw.stream ?? FALLBACK_DEFAULTS.stream),
    timeoutMs: numberDefault(defaultsRaw.timeoutMs, FALLBACK_DEFAULTS.timeoutMs),
    maxRetries: numberDefault(defaultsRaw.maxRetries, FALLBACK_DEFAULTS.maxRetries),
    maxTokens: numberDefault(defaultsRaw.maxTokens, FALLBACK_DEFAULTS.maxTokens),
    userAgent: cleanString(defaultsRaw.userAgent),
  };

  if (!Array.isArray(obj.providers)) throw new Error("providers 必须是数组");
  const providerIds = new Set<string>();
  const providers: ProviderPreset[] = obj.providers.map((item, idx) => {
    const p = asRecord(item);
    const id = cleanString(p.id);
    const name = cleanString(p.name);
    const baseUrl = cleanString(p.baseUrl);
    if (!id) throw new Error(`第 ${idx + 1} 个供应商缺少 id`);
    if (id === CUSTOM_PROVIDER_ID) throw new Error("供应商 id 不能使用 custom");
    if (providerIds.has(id)) throw new Error(`供应商 id 重复：${id}`);
    if (!name) throw new Error(`供应商 ${id} 缺少 name`);
    if (!baseUrl) throw new Error(`供应商 ${id} 缺少 baseUrl`);
    assertHttpUrl(baseUrl, `供应商 ${id} 的 baseUrl`);
    providerIds.add(id);

    const rawModels = Array.isArray(p.models) ? p.models : [];
    const modelIds = new Set<string>();
    const models = rawModels.map((model, mIdx) => {
      const m = asRecord(model);
      const modelId = cleanString(m.id);
      if (!modelId) throw new Error(`供应商 ${id} 的第 ${mIdx + 1} 个模型缺少 id`);
      if (modelIds.has(modelId)) throw new Error(`供应商 ${id} 的模型 id 重复：${modelId}`);
      modelIds.add(modelId);
      return {
        id: modelId,
        // label 是官方原始模型名，用于前端展示和跨供应商去重；id 保留第三方实际请求名。
        ...(optionalString(m.label) ? { label: optionalString(m.label) } : {}),
      };
    });

    return {
      id,
      name,
      baseUrl,
      ...(Boolean(p.isFullUrl) ? { isFullUrl: true } : {}),
      ...(optionalString(p.keyHint) ? { keyHint: optionalString(p.keyHint) } : {}),
      ...(optionalString(p.docs) ? { docs: optionalString(p.docs) } : {}),
      models,
    };
  });

  return { providers, defaults };
}
