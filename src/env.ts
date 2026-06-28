import type { Env } from "./app.js";
import { createStore, type StoreEnv } from "./store/index.js";

// All runtime entrypoints build the same Hono env before calling app.fetch().
// This keeps auth, SSRF controls, and encrypted stores from drifting by platform.
export async function buildAppEnv(raw: StoreEnv & Record<string, unknown>): Promise<Env> {
  const store = await createStore(raw);
  const statusStore = await createStore(raw, "status");
  const privateStore = await createStore(raw, "private");

  return {
    APP_PASSWORD: typeof raw.APP_PASSWORD === "string" ? raw.APP_PASSWORD : undefined,
    ALLOWED_HOSTS: typeof raw.ALLOWED_HOSTS === "string" ? raw.ALLOWED_HOSTS : undefined,
    CORS_ORIGIN: typeof raw.CORS_ORIGIN === "string" ? raw.CORS_ORIGIN : undefined,
    BLOCK_PRIVATE_HOSTS: typeof raw.BLOCK_PRIVATE_HOSTS === "string" ? raw.BLOCK_PRIVATE_HOSTS : undefined,
    STATUS_SECRET: typeof raw.STATUS_SECRET === "string" ? raw.STATUS_SECRET : undefined,
    PRIVATE_STATE_SECRET: typeof raw.PRIVATE_STATE_SECRET === "string" ? raw.PRIVATE_STATE_SECRET : undefined,
    store: store ?? undefined,
    statusStore: statusStore ?? undefined,
    privateStore: privateStore ?? undefined,
  };
}
