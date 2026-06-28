import { createApp } from "../src/app.js";
import { buildAppEnv } from "../src/env.js";

// Vercel 入口（serverless）。静态资源由 vercel.json 路由到 dist/client，
// 这里只处理 /api/*。设置持久化默认走 Vercel Blob（需 BLOB_READ_WRITE_TOKEN）。
export const config = { runtime: "nodejs" };

const app = createApp();

export default async function handler(req: Request) {
  const storageEnv = {
    ...process.env,
    STORAGE_DRIVER: process.env.STORAGE_DRIVER ?? (process.env.BLOB_READ_WRITE_TOKEN ? undefined : "none"),
  };
  return app.fetch(req, await buildAppEnv(storageEnv));
}
