import { describe, expect, it } from "vitest";
import { createApp, type Env } from "./app.js";
import { encrypt } from "./crypto.js";
import { emptyPrivateState, normalizePrivateState } from "./private-state.js";
import type { SettingsStore } from "./store/index.js";

class MemoryStore implements SettingsStore {
  value: string | null = null;
  get(): Promise<string | null> {
    return Promise.resolve(this.value);
  }
  put(value: string): Promise<void> {
    this.value = value;
    return Promise.resolve();
  }
}

function req(path: string, init?: RequestInit) {
  return new Request(`http://x.test${path}`, init);
}

describe("private state", () => {
  it("normalizes defaults and trims history", () => {
    const state = normalizePrivateState({
      historyPersist: false,
      history: Array.from({ length: 205 }, (_, i) => ({
        id: `h${i}`,
        ts: i,
        providerName: "P",
        protocol: "openai-chat",
        baseUrl: "https://api.example.com",
        apiKey: "sk",
        model: "m",
        modelLabel: "m",
        streamVerdict: null,
        result: { ok: true, status: 200, latencyMs: 1, ttftMs: null, usage: {}, text: "", error: null, attempts: 1 },
      })),
    });
    expect(state.historyPersist).toBe(false);
    expect(state.history).toHaveLength(200);
    expect(state.statusEntries).toEqual([]);
  });

  it("returns 204 when private store is unavailable", async () => {
    const app = createApp();
    const res = await app.fetch(req("/api/private-state", { headers: { "x-app-password": "pw" } }), { APP_PASSWORD: "pw" } satisfies Env);
    expect(res.status).toBe(204);
  });

  it("returns default private state for an empty configured store", async () => {
    const app = createApp();
    const store = new MemoryStore();
    const res = await app.fetch(req("/api/private-state", { headers: { "x-app-password": "pw" } }), {
      APP_PASSWORD: "pw",
      privateStore: store,
    } satisfies Env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ v: 1, historyPersist: true, history: [], statusEntries: [] });
  });

  it("writes encrypted private state and reads it back", async () => {
    const app = createApp();
    const store = new MemoryStore();
    const env = { APP_PASSWORD: "pw", privateStore: store } satisfies Env;
    const state = {
      ...emptyPrivateState(),
      conn: { providerId: "custom", baseUrl: "https://api.example.com", apiKey: "sk-live" },
    };
    const put = await app.fetch(req("/api/private-state", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-app-password": "pw" },
      body: JSON.stringify(state),
    }), env);
    expect(put.status).toBe(200);
    expect(store.value).not.toContain("sk-live");

    const get = await app.fetch(req("/api/private-state", { headers: { "x-app-password": "pw" } }), env);
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({ conn: { apiKey: "sk-live" } });
  });

  it("config scope persists private config but strips history", async () => {
    const app = createApp();
    const store = new MemoryStore();
    const env = { APP_PASSWORD: "pw", privateStore: store, PRIVATE_STATE_SCOPE: "config" } satisfies Env;
    const state = {
      ...emptyPrivateState(),
      historyPersist: true,
      history: [{
        id: "h1",
        ts: 1,
        providerName: "P",
        protocol: "openai-chat" as const,
        baseUrl: "https://api.example.com",
        apiKey: "sk-live",
        model: "m",
        modelLabel: "m",
        streamVerdict: null,
        result: { ok: true, status: 200, latencyMs: 1, ttftMs: null, usage: {}, text: "ok", error: null, attempts: 1 },
      }],
      conn: { providerId: "custom", baseUrl: "https://api.example.com", apiKey: "sk-live" },
    };

    const put = await app.fetch(req("/api/private-state", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-app-password": "pw" },
      body: JSON.stringify(state),
    }), env);
    expect(put.status).toBe(200);

    const get = await app.fetch(req("/api/private-state", { headers: { "x-app-password": "pw" } }), env);
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({
      historyPersist: false,
      history: [],
      conn: { apiKey: "sk-live" },
    });
  });

  it("none scope disables private-state persistence", async () => {
    const app = createApp();
    const store = new MemoryStore();
    const env = { APP_PASSWORD: "pw", privateStore: store, PRIVATE_STATE_SCOPE: "none" } satisfies Env;

    const get = await app.fetch(req("/api/private-state", { headers: { "x-app-password": "pw" } }), env);
    expect(get.status).toBe(204);

    const put = await app.fetch(req("/api/private-state", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-app-password": "pw" },
      body: JSON.stringify(emptyPrivateState()),
    }), env);
    expect(put.status).toBe(501);
  });

  it("returns 409 when encrypted private state cannot be decrypted", async () => {
    const app = createApp();
    const store = new MemoryStore();
    store.value = await encrypt(JSON.stringify(emptyPrivateState()), "old-secret");
    const res = await app.fetch(req("/api/private-state", { headers: { "x-app-password": "pw" } }), {
      APP_PASSWORD: "pw",
      privateStore: store,
      PRIVATE_STATE_SECRET: "new-secret",
    } satisfies Env);
    expect(res.status).toBe(409);
  });
});
