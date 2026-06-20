import { handle } from "hono/vercel";
import { createApp, type Env } from "../src/app.js";
import { createStore } from "../src/store/index.js";

// Vercel 入口（serverless）。静态资源由 vercel.json 路由到 dist/client，
// 这里只处理 /api/*。设置持久化默认走 Vercel Blob（需 BLOB_READ_WRITE_TOKEN）。
export const config = { runtime: "nodejs" };

const app = createApp();

app.use("/api/*", async (c, next) => {
  const env = process.env as unknown as Env & Record<string, string | undefined>;
  const store = await createStore(process.env);
  Object.assign(c.env as object, {
    APP_PASSWORD: env.APP_PASSWORD,
    ALLOWED_HOSTS: env.ALLOWED_HOSTS,
    CORS_ORIGIN: env.CORS_ORIGIN,
    BLOCK_PRIVATE_HOSTS: env.BLOCK_PRIVATE_HOSTS,
    store: store ?? undefined,
  });
  await next();
});

export default handle(app);
