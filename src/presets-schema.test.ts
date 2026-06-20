import { describe, it, expect } from "vitest";
import { normalizePresets, FALLBACK_DEFAULTS } from "./presets-schema.js";

describe("normalizePresets", () => {
  it("applies fallback defaults when defaults omitted", () => {
    const out = normalizePresets({ providers: [] });
    expect(out.defaults).toEqual(FALLBACK_DEFAULTS);
    expect(out.providers).toEqual([]);
  });

  it("normalizes a valid provider", () => {
    const out = normalizePresets({
      providers: [{ id: "p1", name: "P1", baseUrl: "https://api.x.com", models: [{ id: "m1", label: "Model 1" }] }],
    });
    expect(out.providers[0]).toMatchObject({ id: "p1", name: "P1", baseUrl: "https://api.x.com" });
    expect(out.providers[0].models[0]).toEqual({ id: "m1", label: "Model 1" });
  });

  it("rejects non-object root", () => {
    expect(() => normalizePresets(null)).toThrow();
    expect(() => normalizePresets([])).toThrow();
  });

  it("rejects non-array providers", () => {
    expect(() => normalizePresets({ providers: {} })).toThrow(/providers/);
  });

  it("rejects missing id / name / baseUrl", () => {
    expect(() => normalizePresets({ providers: [{ name: "x", baseUrl: "https://a.com" }] })).toThrow(/id/);
    expect(() => normalizePresets({ providers: [{ id: "p", baseUrl: "https://a.com" }] })).toThrow(/name/);
    expect(() => normalizePresets({ providers: [{ id: "p", name: "x" }] })).toThrow(/baseUrl/);
  });

  it("rejects reserved id 'custom'", () => {
    expect(() => normalizePresets({ providers: [{ id: "custom", name: "x", baseUrl: "https://a.com" }] })).toThrow(
      /custom/,
    );
  });

  it("rejects duplicate provider ids", () => {
    expect(() =>
      normalizePresets({
        providers: [
          { id: "p", name: "a", baseUrl: "https://a.com", models: [] },
          { id: "p", name: "b", baseUrl: "https://b.com", models: [] },
        ],
      }),
    ).toThrow(/重复/);
  });

  it("rejects invalid baseUrl protocol", () => {
    expect(() => normalizePresets({ providers: [{ id: "p", name: "x", baseUrl: "ftp://a.com" }] })).toThrow();
  });

  it("rejects duplicate model ids within a provider", () => {
    expect(() =>
      normalizePresets({
        providers: [{ id: "p", name: "x", baseUrl: "https://a.com", models: [{ id: "m" }, { id: "m" }] }],
      }),
    ).toThrow(/重复/);
  });

  it("omits label when absent", () => {
    const out = normalizePresets({
      providers: [{ id: "p", name: "x", baseUrl: "https://a.com", models: [{ id: "m" }] }],
    });
    expect(out.providers[0].models[0]).toEqual({ id: "m" });
  });
});
