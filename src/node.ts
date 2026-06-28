import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFile } from "node:fs/promises";
import { createApp } from "./app.js";
import { buildAppEnv } from "./env.js";
import { DEFAULT_SETTINGS_FILE } from "./store/index.js";

// Node 入口：复用框架无关的 app，叠加静态资源服务（dist/client）。
// 环境变量从 process.env 注入到 Hono 的 c.env。
// 设置持久化默认用 FileStore（./web/public/presets.json），可用 STORAGE_DRIVER / SETTINGS_FILE 覆盖。
// /presets.json 与 FileStore 指向同一源文件，UI 修改与手改文件统一、改即生效。
const PRESETS_FILE = process.env.SETTINGS_FILE || DEFAULT_SETTINGS_FILE;
const env = await buildAppEnv(process.env);

const app = createApp();

// 注：env 不能用 app.use("*") 注入——createApp() 已先注册了 /api/* 路由，
// 命中路由的 handler 会在后注册的中间件之前返回，导致 c.env 为空（APP_PASSWORD /
// ALLOWED_HOSTS 形同虚设）。改为像 worker.ts 那样在 fetch 时直接把 env 作为第二参传入。
const fetch = (req: Request) => app.fetch(req, env);

// 静态资源：构建产物在 dist/client，相对运行目录 dist/server/node.js → ../client。
const STATIC_ROOT = "./dist/client";
app.use("/assets/*", serveStatic({ root: STATIC_ROOT }));
app.get("/favicon.ico", serveStatic({ path: `${STATIC_ROOT}/favicon.ico` }));
app.get("/favicon.svg", serveStatic({ path: `${STATIC_ROOT}/favicon.svg` }));

// /presets.json 直接读源文件（与 FileStore 同源），改即生效、无需 rebuild；
// 读不到时回退构建副本，兼容只部署 dist 的精简场景。
app.get("/presets.json", async (c) => {
  for (const path of [PRESETS_FILE, `${STATIC_ROOT}/presets.json`]) {
    try {
      const text = await readFile(path, "utf-8");
      return c.body(text, 200, { "content-type": "application/json", "cache-control": "no-store" });
    } catch {
      // 试下一个候选路径
    }
  }
  return c.notFound();
});

// SPA 兜底：非 /api 路由一律返回 index.html。
app.get("*", async (c) => {
  if (c.req.path.startsWith("/api")) return c.notFound();
  try {
    const html = await readFile(`${STATIC_ROOT}/index.html`, "utf-8");
    return c.html(html);
  } catch {
    return c.text("前端未构建。请先运行 npm run build。", 200);
  }
});

const port = Number(process.env.PORT ?? 8787);
serve({ fetch, port }, (info) => {
  console.log(`ModelPing 运行中: http://localhost:${info.port}`);
  if (env.APP_PASSWORD) console.log("访问口令已启用 (APP_PASSWORD)");
  if (env.ALLOWED_HOSTS) console.log(`目标主机白名单: ${env.ALLOWED_HOSTS}`);
  console.log(env.store ? "设置持久化已启用（跨设备共享）" : "设置持久化未启用（前端本地模式）");
  const statusReady = env.statusStore && (env.STATUS_SECRET || env.APP_PASSWORD);
  console.log(statusReady ? "状态持久化已启用（加密落盘）" : "状态持久化未启用（需 store + APP_PASSWORD/STATUS_SECRET，前端走内存模式）");
  const privateReady = env.privateStore && (env.PRIVATE_STATE_SECRET || env.STATUS_SECRET || env.APP_PASSWORD);
  console.log(privateReady ? "私有工作态持久化已启用（加密落盘）" : "私有工作态持久化未启用（需 store + APP_PASSWORD/STATUS_SECRET/PRIVATE_STATE_SECRET）");
});
