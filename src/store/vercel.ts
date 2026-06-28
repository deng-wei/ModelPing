import { list, put } from "@vercel/blob";
import type { SettingsStore } from "./types.js";

// Vercel 驱动：用 Vercel Blob 存单个 JSON 文件。
// 需环境变量 BLOB_READ_WRITE_TOKEN（Vercel 项目接入 Blob 后自动注入）。
// 固定 pathname（addRandomSuffix:false）+ allowOverwrite，读时按前缀 list 再 fetch。
export class VercelBlobStore implements SettingsStore {
  // pathname 默认存预设；状态列表用 settings/status.enc（密文）。
  constructor(
    private readonly token?: string,
    private readonly pathname: string = "settings/presets.json",
  ) {}

  async get(): Promise<string | null> {
    const { blobs } = await list({ prefix: this.pathname, token: this.token });
    const hit = blobs.find((b) => b.pathname === this.pathname);
    if (!hit) return null;
    const res = await fetch(hit.url, { cache: "no-store" });
    if (!res.ok) return null;
    return res.text();
  }

  async put(value: string): Promise<void> {
    await put(this.pathname, value, {
      access: "public",
      token: this.token,
      contentType: "application/json",
      addRandomSuffix: false,
    });
  }
}
