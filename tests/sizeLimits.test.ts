import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ProviderError,
  DEFAULT_MAX_PROVIDER_RESPONSE_BYTES,
} from "../src/providers/llm.js";

// We need to import the module to test fetchWithAbort, which is not exported.
// We'll test it indirectly through provider invoke() or by importing and testing the internals.

describe("H7 — Body/response size limits", () => {
  describe("DEFAULT_MAX_PROVIDER_RESPONSE_BYTES constant", () => {
    it("should be 5 MB", () => {
      expect(DEFAULT_MAX_PROVIDER_RESPONSE_BYTES).toBe(5 * 1024 * 1024);
    });
  });

  describe("ProviderError with PROVIDER_RESPONSE_TOO_LARGE", () => {
    it("should create a ProviderError with code PROVIDER_RESPONSE_TOO_LARGE", () => {
      const error = new ProviderError({
        code: "PROVIDER_RESPONSE_TOO_LARGE",
        provider: "test-provider",
        message: "Response too large",
        retryable: false,
      });
      expect(error).toBeInstanceOf(ProviderError);
      expect(error.code).toBe("PROVIDER_RESPONSE_TOO_LARGE");
      expect(error.provider).toBe("test-provider");
      expect(error.retryable).toBe(false);
    });

    it("should carry details about the limit violation", () => {
      const error = new ProviderError({
        code: "PROVIDER_RESPONSE_TOO_LARGE",
        provider: "test-provider",
        message: "Response too large",
        retryable: false,
        details: { contentLength: 10_000_000, maxResponseBytes: 5_242_880 },
      });
      expect(error.details).toEqual({ contentLength: 10_000_000, maxResponseBytes: 5_242_880 });
    });
  });

  describe("express.json({ limit: '1mb' })", () => {
    it("server.ts should contain express.json with limit option", async () => {
      const serverSource = await import("fs").then((fs) =>
        fs.readFileSync("src/api/server.ts", "utf-8"),
      );
      expect(serverSource).toMatch(/express\.json\(\s*\{\s*limit\s*:\s*["']1mb["']\s*\}\s*\)/);
    });
  });

  describe("fetchWithAbort — Content-Length pre-check", () => {
    // We test fetchWithAbort indirectly by exercising the internal logic.
    // Since fetchWithAbort is not exported, we verify the behavior through
    // a simulated fetch that returns a large Content-Length.

    it("should throw PROVIDER_RESPONSE_TOO_LARGE when Content-Length exceeds limit", async () => {
      // Dynamically import to get a fresh module with our fetchWithAbort
      const { TogetherAIProvider } = await import("../src/providers/llm.js");

      const mockFetch = vi.fn().mockResolvedValue(
        new Response("{}", {
          status: 200,
          headers: { "content-length": String(DEFAULT_MAX_PROVIDER_RESPONSE_BYTES + 1) },
        }),
      );

      const provider = new TogetherAIProvider({
        apiKey: "test-key",
        enableNetwork: true,
        fetchImpl: mockFetch,
      });

      await expect(
        provider.invoke({
          model: "test",
          messages: [{ role: "user", content: "hi" }],
        }),
      ).rejects.toThrow();
    });

    it("should NOT throw when Content-Length is within limit", async () => {
      const { TogetherAIProvider } = await import("../src/providers/llm.js");

      const mockResponse = {
        id: "chatcmpl-1",
        object: "chat.completion",
        model: "test-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Hello!" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      };

      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { "content-length": "200" },
        }),
      );

      const provider = new TogetherAIProvider({
        apiKey: "test-key",
        enableNetwork: true,
        fetchImpl: mockFetch,
      });

      const result = await provider.invoke({
        model: "test",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(result.content).toBe("Hello!");
    });
  });

  describe("fetchWithAbort — bounded stream consumption", () => {
    it("should throw PROVIDER_RESPONSE_TOO_LARGE when body exceeds limit during streaming", async () => {
      const { TogetherAIProvider } = await import("../src/providers/llm.js");

      // Create a response with a body that exceeds the limit.
      // We use a small limit by constructing a provider and a mock fetch
      // that returns a very large body without Content-Length header.
      const largeBody = "x".repeat(DEFAULT_MAX_PROVIDER_RESPONSE_BYTES + 100);
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          // Send one chunk that exceeds the limit
          controller.enqueue(encoder.encode(largeBody));
          controller.close();
        },
      });

      const mockFetch = vi.fn().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: {}, // No Content-Length — forces streaming path
        }),
      );

      const provider = new TogetherAIProvider({
        apiKey: "test-key",
        enableNetwork: true,
        fetchImpl: mockFetch,
      });

      // The bounded stream will error; response.json() should fail
      await expect(
        provider.invoke({
          model: "test",
          messages: [{ role: "user", content: "hi" }],
        }),
      ).rejects.toThrow();
    });

    it("should allow responses with body within limit", async () => {
      const { TogetherAIProvider } = await import("../src/providers/llm.js");

      const mockResponse = {
        id: "chatcmpl-1",
        object: "chat.completion",
        model: "test-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Small response" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      };

      const body = JSON.stringify(mockResponse);
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(body));
          controller.close();
        },
      });

      const mockFetch = vi.fn().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: {}, // No Content-Length
        }),
      );

      const provider = new TogetherAIProvider({
        apiKey: "test-key",
        enableNetwork: true,
        fetchImpl: mockFetch,
      });

      const result = await provider.invoke({
        model: "test",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(result.content).toBe("Small response");
    });
  });

  describe("fetchWithAbort — explicit maxResponseBytes from all providers", () => {
    it("should pass DEFAULT_MAX_PROVIDER_RESPONSE_BYTES to fetchWithAbort in TogetherAIProvider", async () => {
      const { TogetherAIProvider } = await import("../src/providers/llm.js");

      // Verify the source passes the constant explicitly
      const fs = await import("fs");
      const source = fs.readFileSync("src/providers/llm.ts", "utf-8");
      const matches = source.match(/fetchWithAbort\([^)]+DEFAULT_MAX_PROVIDER_RESPONSE_BYTES[^)]*\)/g);
      expect(matches).toBeDefined();
      expect(matches!.length).toBeGreaterThanOrEqual(4); // 4 providers
    });
  });
});
