import { describe, it, expect, afterEach } from "vitest";
import {
  validateProviderUrl,
  PRIVATE_RANGES,
  BLOCKED_HOSTNAMES,
  _resolver,
} from "../src/security/ssrfProtection.js";

// ── Unit tests for PRIVATE_RANGES and BLOCKED_HOSTNAMES ────────────────

describe("PRIVATE_RANGES", () => {
  it("covers loopback 127.0.0.0/8", () => {
    const loopback = PRIVATE_RANGES.find((r) => r.label.includes("loopback (127"));
    expect(loopback).toBeDefined();
  });

  it("covers RFC1918 ranges", () => {
    const rfc1918 = PRIVATE_RANGES.filter((r) => r.label.includes("RFC1918"));
    expect(rfc1918.length).toBe(3);
  });

  it("covers link-local 169.254.0.0/16", () => {
    const linkLocal = PRIVATE_RANGES.find((r) =>
      r.label.includes("link-local (169.254")
    );
    expect(linkLocal).toBeDefined();
  });

  it("covers CGNAT 100.64.0.0/10", () => {
    const cgnat = PRIVATE_RANGES.find((r) => r.label.includes("CGNAT"));
    expect(cgnat).toBeDefined();
  });

  it("covers current-network 0.0.0.0/8", () => {
    const current = PRIVATE_RANGES.find((r) =>
      r.label.includes("current-network")
    );
    expect(current).toBeDefined();
  });

  it("covers IPv6 loopback ::1", () => {
    const v6Loopback = PRIVATE_RANGES.find((r) =>
      r.label.includes("IPv6 loopback")
    );
    expect(v6Loopback).toBeDefined();
  });

  it("covers IPv6 link-local fe80::/10", () => {
    const v6LinkLocal = PRIVATE_RANGES.find((r) =>
      r.label.includes("IPv6 link-local")
    );
    expect(v6LinkLocal).toBeDefined();
  });

  it("covers IPv6 unique local fc00::/7", () => {
    const v6Ula = PRIVATE_RANGES.find((r) =>
      r.label.includes("IPv6 unique local")
    );
    expect(v6Ula).toBeDefined();
  });

  it("all ranges have valid start <= end", () => {
    for (const range of PRIVATE_RANGES) {
      expect(range.start <= range.end, `${range.label}: start > end`).toBe(true);
    }
  });
});

describe("BLOCKED_HOSTNAMES", () => {
  it("contains localhost", () => {
    expect(BLOCKED_HOSTNAMES.has("localhost")).toBe(true);
  });

  it("contains Google metadata endpoint", () => {
    expect(BLOCKED_HOSTNAMES.has("metadata.google.internal")).toBe(true);
  });

  it("contains Azure metadata endpoint", () => {
    expect(BLOCKED_HOSTNAMES.has("metadata.azure.internal")).toBe(true);
  });
});

// ── validateProviderUrl tests ───────────────────────────────────────────

describe("validateProviderUrl", () => {
  // ── Invalid URL ──

  it("rejects invalid URLs", async () => {
    await expect(validateProviderUrl("not-a-url")).rejects.toThrow(
      /invalid URL/
    );
  });

  // ── Protocol ──

  it("rejects ftp:// protocol", async () => {
    await expect(
      validateProviderUrl("ftp://example.com/resource")
    ).rejects.toThrow(/protocol/);
  });

  it("rejects file:// protocol", async () => {
    await expect(
      validateProviderUrl("file:///etc/passwd")
    ).rejects.toThrow(/protocol/);
  });

  it("accepts http:// protocol (public IP)", async () => {
    await expect(
      validateProviderUrl("http://8.8.8.8/api")
    ).resolves.toBeUndefined();
  });

  it("accepts https:// protocol (public IP)", async () => {
    await expect(
      validateProviderUrl("https://8.8.8.8/api")
    ).resolves.toBeUndefined();
  });

  // ── Blocked hostnames ──

  it("rejects localhost", async () => {
    await expect(
      validateProviderUrl("http://localhost:3000/api")
    ).rejects.toThrow(/blocked/);
  });

  it("rejects metadata.google.internal", async () => {
    await expect(
      validateProviderUrl("http://metadata.google.internal/computeMetadata/v1/")
    ).rejects.toThrow(/blocked/);
  });

  it("rejects metadata.azure.internal", async () => {
    await expect(
      validateProviderUrl("http://metadata.azure.internal/metadata/instance")
    ).rejects.toThrow(/blocked/);
  });

  // ── Private IPv4 ──

  it("rejects 127.0.0.1 (loopback)", async () => {
    await expect(
      validateProviderUrl("http://127.0.0.1/api")
    ).rejects.toThrow(/private range/);
  });

  it("rejects 10.0.0.1 (RFC1918)", async () => {
    await expect(
      validateProviderUrl("https://10.0.0.1/api")
    ).rejects.toThrow(/private range/);
  });

  it("rejects 172.16.0.1 (RFC1918)", async () => {
    await expect(
      validateProviderUrl("https://172.16.0.1/api")
    ).rejects.toThrow(/private range/);
  });

  it("rejects 192.168.1.1 (RFC1918)", async () => {
    await expect(
      validateProviderUrl("https://192.168.1.1/api")
    ).rejects.toThrow(/private range/);
  });

  it("rejects 169.254.169.254 (link-local / cloud metadata)", async () => {
    await expect(
      validateProviderUrl("http://169.254.169.254/metadata")
    ).rejects.toThrow(/private range/);
  });

  it("rejects 100.64.0.1 (CGNAT)", async () => {
    await expect(
      validateProviderUrl("https://100.64.0.1/api")
    ).rejects.toThrow(/private range/);
  });

  it("rejects 0.0.0.0 (current-network)", async () => {
    await expect(
      validateProviderUrl("http://0.0.0.0/api")
    ).rejects.toThrow(/private range/);
  });

  // ── Private IPv6 ──

  it("rejects ::1 (IPv6 loopback)", async () => {
    await expect(
      validateProviderUrl("http://[::1]/api")
    ).rejects.toThrow(/private range/);
  });

  it("rejects fe80::1 (IPv6 link-local)", async () => {
    await expect(
      validateProviderUrl("http://[fe80::1]/api")
    ).rejects.toThrow(/private range/);
  });

  it("rejects fc00::1 (IPv6 unique local)", async () => {
    await expect(
      validateProviderUrl("http://[fc00::1]/api")
    ).rejects.toThrow(/private range/);
  });

  // ── Public IPs (should pass) ──

  it("accepts 8.8.8.8 (public Google DNS)", async () => {
    await expect(
      validateProviderUrl("https://8.8.8.8/api")
    ).resolves.toBeUndefined();
  });

  it("accepts 1.1.1.1 (public Cloudflare DNS)", async () => {
    await expect(
      validateProviderUrl("https://1.1.1.1/api")
    ).resolves.toBeUndefined();
  });

  // ── DNS resolution (via _resolver injection) ──

  let origResolve4: typeof _resolver.resolve4;
  let origResolve6: typeof _resolver.resolve6;

  afterEach(() => {
    if (origResolve4) _resolver.resolve4 = origResolve4;
    if (origResolve6) _resolver.resolve6 = origResolve6;
  });

  it("rejects DNS hostname resolving to private IP", async () => {
    origResolve4 = _resolver.resolve4;
    origResolve6 = _resolver.resolve6;
    _resolver.resolve4 = async () => ["10.0.0.1"];
    _resolver.resolve6 = async () => [];

    await expect(
      validateProviderUrl("https://evil.example.com/api")
    ).rejects.toThrow(/resolves to private IP/);
  });

  it("accepts DNS hostname resolving to public IP", async () => {
    origResolve4 = _resolver.resolve4;
    origResolve6 = _resolver.resolve6;
    _resolver.resolve4 = async () => ["8.8.8.8"];
    _resolver.resolve6 = async () => [];

    await expect(
      validateProviderUrl("https://safe.example.com/api")
    ).resolves.toBeUndefined();
  });

  it("rejects unresolvable hostname", async () => {
    origResolve4 = _resolver.resolve4;
    origResolve6 = _resolver.resolve6;
    _resolver.resolve4 = async () => { throw new Error("ENOTFOUND"); };
    _resolver.resolve6 = async () => { throw new Error("ENOTFOUND"); };

    await expect(
      validateProviderUrl("https://nonexistent.example.com/api")
    ).rejects.toThrow(/did not resolve/);
  });

  it("rejects hostname with IPv6 resolving to private IP", async () => {
    origResolve4 = _resolver.resolve4;
    origResolve6 = _resolver.resolve6;
    _resolver.resolve4 = async () => [];
    _resolver.resolve6 = async () => ["::1"];

    await expect(
      validateProviderUrl("https://evil6.example.com/api")
    ).rejects.toThrow(/resolves to private IP/);
  });
});
