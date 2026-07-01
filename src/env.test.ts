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

  it("exposes runtime safety flags in health", async () => {
    const app = createApp();
    const env = await buildAppEnv({ APP_PASSWORD: "pw", ALLOWED_HOSTS: "api.example.com", STORAGE_DRIVER: "none" });

    const res = await app.fetch(new Request("http://x.test/api/health"), env);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      needPassword: true,
      security: {
        hasPassword: true,
        hasAllowedHosts: true,
        blockPrivateHosts: false,
        shouldWarnOpenProxy: false,
      },
      persistence: {
        settings: false,
        privateState: false,
        privateStateScope: "none",
      },
    });
  });

  it("exposes config-scope private persistence in health", async () => {
    const app = createApp();
    const env = await buildAppEnv({
      APP_PASSWORD: "pw",
      STORAGE_DRIVER: "file",
      SETTINGS_FILE: "/tmp/modelping-env-test-presets.json",
      PRIVATE_STATE_FILE: "/tmp/modelping-env-test-private.enc",
      PRIVATE_STATE_SCOPE: "config",
    });

    const res = await app.fetch(new Request("http://x.test/api/health"), env);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      persistence: {
        settings: true,
        privateState: true,
        privateStateScope: "config",
      },
    });
  });
});
