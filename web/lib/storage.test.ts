import { describe, expect, it } from "vitest";
import { migrateLegacyPrivateState } from "./storage.js";

class MemoryStorage implements Storage {
  private readonly data = new Map<string, string>();

  get length(): number {
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

describe("migrateLegacyPrivateState", () => {
  it("reads legacy sensitive localStorage once and removes it", () => {
    const storage = new MemoryStorage();
    storage.setItem("llm-test:persist", "0");
    storage.setItem("llm-test:conn", JSON.stringify({ providerId: "custom", baseUrl: "https://api.example.com", apiKey: "sk" }));
    storage.setItem("llm-test:config", JSON.stringify({ timeoutMs: 1000, concurrency: 2 }));
    storage.setItem("llm-test:history", JSON.stringify([{ id: "h1", apiKey: "sk" }]));

    const migrated = migrateLegacyPrivateState(storage);

    expect(migrated.historyPersist).toBe(false);
    expect(migrated.conn).toMatchObject({ apiKey: "sk" });
    expect(migrated.config).toMatchObject({ timeoutMs: 1000 });
    expect(migrated.history).toHaveLength(1);
    expect(storage.getItem("llm-test:conn")).toBeNull();
    expect(storage.getItem("llm-test:history")).toBeNull();
    expect(storage.getItem("llm-test:config")).toBeNull();
    expect(storage.getItem("llm-test:persist")).toBeNull();
  });
});
