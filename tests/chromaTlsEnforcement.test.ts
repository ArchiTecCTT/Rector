import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { ChromaMemoryProvider } from "../src/memory/chromaMemoryAdapter";
import { createFakeChromaClient, fixedNow } from "./support/memoryProviderContract";

describe("Chroma TLS enforcement (M12)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.RECTOR_ALLOW_HTTP_CHROMA;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // -----------------------------------------------------------------------
  // Helper: build a provider with a given baseUrl and capture the error
  // -----------------------------------------------------------------------
  async function getCollectionError(baseUrl: string): Promise<Error | null> {
    const provider = new ChromaMemoryProvider({
      id: "tls-test",
      config: { baseUrl },
      now: fixedNow,
      clientFactory: () => createFakeChromaClient(),
    });
    try {
      // getCollection is private, but searchMemory calls it
      await provider.searchMemory("test");
      return null;
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }
  }

  // -----------------------------------------------------------------------
  // HTTPS is always allowed
  // -----------------------------------------------------------------------
  it("allows https: URLs for any hostname", async () => {
    const err = await getCollectionError("https://chroma.example.com:8000");
    expect(err).toBeNull();
  });

  // -----------------------------------------------------------------------
  // HTTP localhost variants are allowed
  // -----------------------------------------------------------------------
  it.each([
    ["http://localhost:8000", "localhost"],
    ["http://127.0.0.1:8000", "127.0.0.1"],
    ["http://[::1]:8000", "::1"],
    ["http://0.0.0.0:8000", "0.0.0.0"],
  ])("allows http: for localhost hostname %s (%s)", async (url: string) => {
    const err = await getCollectionError(url);
    expect(err).toBeNull();
  });

  // -----------------------------------------------------------------------
  // HTTP non-localhost is rejected
  // -----------------------------------------------------------------------
  it("rejects http: for a non-localhost hostname", async () => {
    const err = await getCollectionError("http://chroma.example.com:8000");
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/requires HTTPS for non-localhost/);
  });

  it("rejects http: for a non-localhost IP", async () => {
    // Use a public IP to avoid SSRF private-range check interference
    const err = await getCollectionError("http://8.8.8.8:8000");
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/requires HTTPS for non-localhost/);
  });

  // -----------------------------------------------------------------------
  // Error message explains the requirement
  // -----------------------------------------------------------------------
  it("error message mentions RECTOR_ALLOW_HTTP_CHROMA override", async () => {
    const err = await getCollectionError("http://chroma.example.com:8000");
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/RECTOR_ALLOW_HTTP_CHROMA/);
  });

  it("error message warns about credentials and data in transit", async () => {
    const err = await getCollectionError("http://chroma.example.com:8000");
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/exposes credentials and data in transit/);
  });

  // -----------------------------------------------------------------------
  // RECTOR_ALLOW_HTTP_CHROMA override
  // -----------------------------------------------------------------------
  it("allows http: non-localhost when RECTOR_ALLOW_HTTP_CHROMA is set", async () => {
    process.env.RECTOR_ALLOW_HTTP_CHROMA = "1";
    const err = await getCollectionError("http://chroma.example.com:8000");
    expect(err).toBeNull();
  });

  it("allows http: non-localhost IP when RECTOR_ALLOW_HTTP_CHROMA is set", async () => {
    process.env.RECTOR_ALLOW_HTTP_CHROMA = "true";
    // Use a public IP to avoid SSRF private-range check interference
    const err = await getCollectionError("http://8.8.8.8:8000");
    expect(err).toBeNull();
  });

  // -----------------------------------------------------------------------
  // validateConfig sync path still works
  // -----------------------------------------------------------------------
  it("validateConfig still rejects non-http(s) URLs", () => {
    const provider = new ChromaMemoryProvider({
      id: "tls-test-sync",
      config: { baseUrl: "ftp://chroma.example.com:8000" },
      now: fixedNow,
      clientFactory: () => createFakeChromaClient(),
    });
    expect(() => provider.validateConfig()).toThrow(/valid http\(s\) URL/);
  });

  it("validateConfig still accepts valid http(s) URLs", () => {
    const provider = new ChromaMemoryProvider({
      id: "tls-test-sync",
      config: { baseUrl: "https://chroma.example.com:8000" },
      now: fixedNow,
      clientFactory: () => createFakeChromaClient(),
    });
    expect(() => provider.validateConfig()).not.toThrow();
  });

  it("validateConfig accepts http: localhost URLs", () => {
    const provider = new ChromaMemoryProvider({
      id: "tls-test-sync",
      config: { baseUrl: "http://localhost:8000" },
      now: fixedNow,
      clientFactory: () => createFakeChromaClient(),
    });
    expect(() => provider.validateConfig()).not.toThrow();
  });

  // -----------------------------------------------------------------------
  // Production mode still runs full SSRF check
  // -----------------------------------------------------------------------
  it("in production mode, still rejects http: non-localhost", async () => {
    process.env.NODE_ENV = "production";
    const err = await getCollectionError("http://chroma.example.com:8000");
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/requires HTTPS for non-localhost/);
  });

  // -----------------------------------------------------------------------
  // Edge case: hostname that starts with "localhost" but isn't
  // -----------------------------------------------------------------------
  it("rejects http: for hostname that merely contains 'localhost'", async () => {
    const err = await getCollectionError("http://localhost.evil.com:8000");
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/requires HTTPS for non-localhost/);
  });
});
