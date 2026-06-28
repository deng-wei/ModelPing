import type { SettingsStore } from "./types.js";

// Cloudflare Workers 驱动：用 KV 命名空间绑定存储。零新依赖。
// 绑定在 wrangler.toml 配置：[[kv_namespaces]] binding = "SETTINGS_KV"。
interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export class CfKvStore implements SettingsStore {
  // key 默认 "presets"；状态列表用 "status"，与预设分开存。
  constructor(
    private readonly kv: KVNamespace,
    private readonly key: string = "presets",
  ) {}

  get(): Promise<string | null> {
    return this.kv.get(this.key);
  }

  put(value: string): Promise<void> {
    return this.kv.put(this.key, value);
  }
}
