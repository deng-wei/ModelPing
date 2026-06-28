import type { SettingsStore } from "./types.js";

export type { SettingsStore } from "./types.js";

// 驱动选择的环境输入。各入口按自身可用的绑定/环境变量填充。
export interface StoreEnv {
  STORAGE_DRIVER?: string;            // 显式覆盖：file | cf-kv | vercel | none
  SETTINGS_FILE?: string;             // file 驱动的预设路径，缺省 ./web/public/presets.json
  STATUS_FILE?: string;               // file 驱动的状态路径，缺省 ./data/status.enc
  PRIVATE_STATE_FILE?: string;        // file 驱动的私有工作态路径，缺省 ./data/private-state.enc
  SETTINGS_KV?: unknown;              // Cloudflare KV 绑定
  BLOB_READ_WRITE_TOKEN?: string;     // Vercel Blob token
}

// 逻辑存储名：presets（设置，明文公开）/ status（旧状态列表）/ private（私有工作态，含密钥、加密落盘）。
export type StoreName = "presets" | "status" | "private";

// Node 自托管：UI 修改与手改文件统一指向同一份 presets，改即生效（也是 /presets.json 的源）。
export const DEFAULT_SETTINGS_FILE = "./web/public/presets.json";
// 状态列表落盘路径：务必在 web 静态目录与 web/public 之外，绝不能被 /presets.json 之类公开服务。
export const DEFAULT_STATUS_FILE = "./data/status.enc";
export const DEFAULT_PRIVATE_STATE_FILE = "./data/private-state.enc";

// 按优先级选择驱动；都不满足返回 null（前端退回纯本地模式）。
// 驱动模块用动态 import，避免把 node:fs / @vercel/blob 打进不相关的部署包。
// name 选择存哪一份逻辑数据（默认 presets）。
export async function createStore(env: StoreEnv, name: StoreName = "presets"): Promise<SettingsStore | null> {
  const driver = (env.STORAGE_DRIVER ?? "").trim().toLowerCase();

  if (driver === "none") return null;

  if (driver === "cf-kv" || (!driver && env.SETTINGS_KV)) {
    if (!env.SETTINGS_KV) throw new Error("STORAGE_DRIVER=cf-kv 但缺少 SETTINGS_KV 绑定");
    const { CfKvStore } = await import("./cf-kv.js");
    return new CfKvStore(env.SETTINGS_KV as any, name);
  }

  if (driver === "vercel" || (!driver && env.BLOB_READ_WRITE_TOKEN)) {
    const { VercelBlobStore } = await import("./vercel.js");
    const pathname = name === "private"
      ? "settings/private-state.enc"
      : name === "status"
        ? "settings/status.enc"
        : "settings/presets.json";
    return new VercelBlobStore(env.BLOB_READ_WRITE_TOKEN, pathname);
  }

  if (driver === "file" || !driver) {
    const { FileStore } = await import("./file.js");
    const path = name === "private"
      ? (env.PRIVATE_STATE_FILE || env.STATUS_FILE || DEFAULT_PRIVATE_STATE_FILE)
      : name === "status"
        ? (env.STATUS_FILE || DEFAULT_STATUS_FILE)
        : (env.SETTINGS_FILE || DEFAULT_SETTINGS_FILE);
    return new FileStore(path);
  }

  throw new Error(`未知 STORAGE_DRIVER：${driver}`);
}
