import type { PresetsResponse } from "./types.js";
// 校验逻辑下沉到后端共享模块（src/presets-schema.ts），前后端单一来源。
// Vite 支持跨目录 import；该模块是纯函数，不会拖入后端运行时代码。
import { normalizePresets } from "../../src/presets-schema.js";

export {
  normalizePresets,
  CUSTOM_PROVIDER_ID,
  CUSTOM_PROVIDER_NAME,
  FALLBACK_DEFAULTS,
  normalizeConcurrency,
} from "../../src/presets-schema.js";

const K_PRESETS = "llm-test:presets";

// ---------- localStorage 缓存（服务端不可用时降级，或作为服务端结果的本地镜像） ----------
export function loadLocalPresets(): PresetsResponse | null {
  try {
    const raw = localStorage.getItem(K_PRESETS);
    return raw ? normalizePresets(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function saveLocalPresets(presets: PresetsResponse): void {
  localStorage.setItem(K_PRESETS, JSON.stringify(normalizePresets(presets)));
}
