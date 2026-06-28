import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { buildAppEnv } from "./env.js";

describe("runtime env injection", () => {
  it("builds an env that gates api routes before handlers run", async () => {
    const app = createApp();
    const env = await buildAppEnv({ APP_PASSWORD: "pw", STORAGE_DRIVER: "none" });

    const denied = await app.fetch(new Request("http://x.test/api/settings"), env);
    expect(denied.status).toBe(401);

    const allowed = await app.fetch(new Request("http://x.test/api/settings", {
      headers: { "x-app-password": "pw" },
    }), env);
    expect(allowed.status).toBe(204);
  });
});
