import { describe, it, expect } from "vitest";
import { isPrivateHost, isPrivateUrl } from "./ssrf.js";

describe("isPrivateHost", () => {
  it("flags loopback and local names", () => {
    expect(isPrivateHost("localhost")).toBe(true);
    expect(isPrivateHost("foo.localhost")).toBe(true);
    expect(isPrivateHost("printer.local")).toBe(true);
    expect(isPrivateHost("svc.internal")).toBe(true);
  });

  it("flags private IPv4 ranges", () => {
    expect(isPrivateHost("127.0.0.1")).toBe(true);
    expect(isPrivateHost("10.1.2.3")).toBe(true);
    expect(isPrivateHost("172.16.0.1")).toBe(true);
    expect(isPrivateHost("172.31.255.254")).toBe(true);
    expect(isPrivateHost("192.168.0.1")).toBe(true);
    expect(isPrivateHost("100.64.0.1")).toBe(true);
    expect(isPrivateHost("0.0.0.0")).toBe(true);
  });

  it("flags the cloud metadata address", () => {
    expect(isPrivateHost("169.254.169.254")).toBe(true);
  });

  it("flags private IPv6", () => {
    expect(isPrivateHost("::1")).toBe(true);
    expect(isPrivateHost("[::1]")).toBe(true);
    expect(isPrivateHost("fe80::1")).toBe(true);
    expect(isPrivateHost("fd00::1")).toBe(true);
    expect(isPrivateHost("::ffff:127.0.0.1")).toBe(true);
  });

  it("allows public hosts", () => {
    expect(isPrivateHost("api.openai.com")).toBe(false);
    expect(isPrivateHost("8.8.8.8")).toBe(false);
    expect(isPrivateHost("172.32.0.1")).toBe(false); // just outside 172.16/12
    expect(isPrivateHost("100.128.0.1")).toBe(false); // just outside 100.64/10
    expect(isPrivateHost("93.184.216.34")).toBe(false);
  });

  it("treats empty host as unsafe", () => {
    expect(isPrivateHost("")).toBe(true);
  });
});

describe("isPrivateUrl", () => {
  it("extracts and judges the host", () => {
    expect(isPrivateUrl("http://127.0.0.1:8080/v1")).toBe(true);
    expect(isPrivateUrl("http://169.254.169.254/latest/meta-data/")).toBe(true);
    expect(isPrivateUrl("https://api.anthropic.com/v1/messages")).toBe(false);
  });

  it("treats invalid URLs as unsafe", () => {
    expect(isPrivateUrl("not a url")).toBe(true);
  });
});
