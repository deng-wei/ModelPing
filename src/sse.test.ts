import { describe, it, expect } from "vitest";
import { drainSseBlocks, extractSseData } from "./sse.js";

describe("drainSseBlocks", () => {
  it("splits complete blocks and keeps the trailing remainder", () => {
    const { blocks, rest } = drainSseBlocks("a\n\nb\n\nhalf");
    expect(blocks).toEqual(["a", "b"]);
    expect(rest).toBe("half");
  });

  it("returns no blocks when no separator yet", () => {
    const { blocks, rest } = drainSseBlocks("data: incomplete");
    expect(blocks).toEqual([]);
    expect(rest).toBe("data: incomplete");
  });

  it("handles CRLF separators", () => {
    const { blocks, rest } = drainSseBlocks("x\r\n\r\ny\r\n\r\n");
    expect(blocks).toEqual(["x", "y"]);
    expect(rest).toBe("");
  });

  it("handles mixed LF / CRLF separators", () => {
    const { blocks, rest } = drainSseBlocks("a\n\nb\r\n\r\nc");
    expect(blocks).toEqual(["a", "b"]);
    expect(rest).toBe("c");
  });

  it("supports incremental framing across chunks", () => {
    // chunk 1: one full block + partial
    const r1 = drainSseBlocks("data: 1\n\ndata: 2");
    expect(r1.blocks).toEqual(["data: 1"]);
    // chunk 2: append, the partial now completes
    const r2 = drainSseBlocks(r1.rest + "9\n\n");
    expect(r2.blocks).toEqual(["data: 29"]);
    expect(r2.rest).toBe("");
  });
});

describe("extractSseData", () => {
  it("extracts a single data line", () => {
    expect(extractSseData("data: hello")).toBe("hello");
  });

  it("joins multiple data lines with newline (SSE spec)", () => {
    expect(extractSseData("data: a\ndata: b")).toBe("a\nb");
  });

  it("ignores event/id/comment lines", () => {
    expect(extractSseData("event: message\ndata: payload\nid: 1")).toBe("payload");
  });

  it("returns null when no data line present", () => {
    expect(extractSseData("event: ping\n: keep-alive")).toBeNull();
    expect(extractSseData("")).toBeNull();
  });
});
