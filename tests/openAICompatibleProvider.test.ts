import { describe, expect, it, vi } from "vitest";
import {
  LLMResponseSchema,
  OpenAICompatibleProvider,
  ProviderError,
} from "../src/providers";

const SECRET_KEY = "sk-super-secret-byok-key-1234567890";
const BASE_URL = "https://proxy.unit.test/v1";
const MODEL = "meta-llama/Llama-3.3-70B-Instruct";

const request = {
  messages: [{ role: "user" as const, content: "Summarize provider contract" }],
  route: "DIRECT_ANSWER",
  task: "openai-compatible adapter test",
  maxOutputTokens: 128,
};

function validProvider(overrides: Record<string, unknown> = {}) {
  return new OpenAICompatibleProvider({
    apiKey: SECRET_KEY,
    baseUrl: BASE_URL,
    model: MODEL,
    ...overrides,
  });
}

/**
 * Serialize every observable field of a thrown ProviderError so a test can
 * assert the API key never leaks into a message, the details payload, or any
 * nested cause object.
 */
function serializeError(err: unknown): string {
  if (err instanceof ProviderError) {
    return JSON.stringify({
      message: err.message,
      code: err.code,
      provider: err.provider,
      status: err.status,
      details: err.details,
      detailsString: String(err.details ?? ""),
      stack: err.stack ?? "",
    });
  }
  return JSON.stringify({ value: String(err) });
}

describe("OpenAICompatibleProvider adapter", () => {
  describe("validateConfig matrix", () => {
    it("passes for a complete, well-formed configuration", () => {
      expect(() => validProvider().validateConfig()).not.toThrow();
    });

    it("fails with CONFIG_INVALID when the API key is missing", () => {
      const provider = new OpenAICompatibleProvider({ apiKey: "", baseUrl: BASE_URL, model: MODEL });
      expect(() => provider.validateConfig()).toThrow(ProviderError);
      try {
        provider.validateConfig();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.code).toBe("CONFIG_INVALID");
        expect(err.provider).toBe("openai-compatible");
        expect(err.message).toMatch(/API key is required/i);
      }
    });

    it("fails with CONFIG_INVALID when the base URL is missing", () => {
      const provider = new OpenAICompatibleProvider({ apiKey: SECRET_KEY, baseUrl: "", model: MODEL });
      try {
        provider.validateConfig();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err).toBeInstanceOf(ProviderError);
        expect(err.code).toBe("CONFIG_INVALID");
        expect(err.message).toMatch(/base URL/i);
      }
    });

    it("fails with CONFIG_INVALID when the base URL is not an absolute http(s) URL", () => {
      for (const badUrl of ["ftp://proxy.test/v1", "proxy.test/v1", "not a url", "/relative/path"]) {
        const provider = new OpenAICompatibleProvider({ apiKey: SECRET_KEY, baseUrl: badUrl, model: MODEL });
        try {
          provider.validateConfig();
          expect.fail(`Should have thrown for base URL: ${badUrl}`);
        } catch (err: any) {
          expect(err).toBeInstanceOf(ProviderError);
          expect(err.code).toBe("CONFIG_INVALID");
          expect(err.message).toMatch(/base URL/i);
        }
      }
    });

    it("fails with CONFIG_INVALID when the model id is missing", () => {
      const provider = new OpenAICompatibleProvider({ apiKey: SECRET_KEY, baseUrl: BASE_URL, model: "   " });
      try {
        provider.validateConfig();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err).toBeInstanceOf(ProviderError);
        expect(err.code).toBe("CONFIG_INVALID");
        expect(err.message).toMatch(/model id is required/i);
      }
    });
  });

  describe("network gating (enableNetwork=false)", () => {
    it("blocks the network and raises NETWORK_DISABLED without calling fetch", async () => {
      const globalFetchSpy = vi.spyOn(globalThis, "fetch");
      const injectedFetch = vi.fn();
      const provider = validProvider({ enableNetwork: false, fetchImpl: injectedFetch as any });

      await expect(provider.invoke(request)).rejects.toMatchObject({
        code: "NETWORK_DISABLED",
        provider: "openai-compatible",
      });

      expect(injectedFetch).not.toHaveBeenCalled();
      expect(globalFetchSpy).not.toHaveBeenCalled();
      globalFetchSpy.mockRestore();
    });

    it("defaults enableNetwork to false when the option is omitted", async () => {
      const injectedFetch = vi.fn();
      const provider = new OpenAICompatibleProvider({
        apiKey: SECRET_KEY,
        baseUrl: BASE_URL,
        model: MODEL,
        fetchImpl: injectedFetch as any,
      });

      await expect(provider.invoke(request)).rejects.toMatchObject({ code: "NETWORK_DISABLED" });
      expect(injectedFetch).not.toHaveBeenCalled();
    });
  });

  describe("response parsing and error mapping with an injected fetchImpl", () => {
    it("parses a successful chat-completions response into the common shape", async () => {
      const mockJson = {
        model: MODEL,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Mocked OpenAI-compatible response" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 11, completion_tokens: 17, total_tokens: 28 },
      };
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => mockJson });
      const provider = validProvider({ enableNetwork: true, fetchImpl: mockFetch as any });

      const response = await provider.invoke(request);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://proxy.unit.test/v1/chat/completions",
        expect.objectContaining({ method: "POST" })
      );
      expect(LLMResponseSchema.parse(response)).toEqual(response);
      expect(response.provider).toBe("openai-compatible");
      expect(response.model).toBe(MODEL);
      expect(response.content).toBe("Mocked OpenAI-compatible response");
      expect(response.finishReason).toBe("stop");
      expect(response.usage.inputTokens).toBe(11);
      expect(response.usage.outputTokens).toBe(17);
      expect(response.usage.totalTokens).toBe(28);
      expect(response.usage.modelCalls).toBe(1);
    });

    it("maps an HTTP failure to a PROVIDER_HTTP_ERROR (retryable for 5xx)", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });
      const provider = validProvider({ enableNetwork: true, fetchImpl: mockFetch as any });

      try {
        await provider.invoke(request);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err).toBeInstanceOf(ProviderError);
        expect(err.code).toBe("PROVIDER_HTTP_ERROR");
        expect(err.status).toBe(503);
        expect(err.retryable).toBe(true);
        expect(err.provider).toBe("openai-compatible");
      }
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("maps an HTTP 401 to a non-retryable PROVIDER_HTTP_ERROR", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });
      const provider = validProvider({ enableNetwork: true, fetchImpl: mockFetch as any });

      try {
        await provider.invoke(request);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.code).toBe("PROVIDER_HTTP_ERROR");
        expect(err.status).toBe(401);
        expect(err.retryable).toBe(false);
      }
    });

    it("maps an invalid response body to PROVIDER_RESPONSE_INVALID", async () => {
      // Empty model fails LLMResponseSchema validation (model must be min length 1).
      const mockJson = { model: "", choices: [{ message: { content: "invalid model response" } }] };
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => mockJson });
      const provider = validProvider({ enableNetwork: true, fetchImpl: mockFetch as any });

      try {
        await provider.invoke(request);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err).toBeInstanceOf(ProviderError);
        expect(err.code).toBe("PROVIDER_RESPONSE_INVALID");
        expect(err.provider).toBe("openai-compatible");
      }
    });
  });

  describe("error redaction (the API key never leaks)", () => {
    it("keeps the API key out of a NETWORK_DISABLED error", async () => {
      const provider = validProvider({ enableNetwork: false });
      try {
        await provider.invoke(request);
        expect.fail("Should have thrown");
      } catch (err) {
        expect(serializeError(err)).not.toContain(SECRET_KEY);
      }
    });

    it("keeps the API key out of a PROVIDER_HTTP_ERROR", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
      const provider = validProvider({ enableNetwork: true, fetchImpl: mockFetch as any });
      try {
        await provider.invoke(request);
        expect.fail("Should have thrown");
      } catch (err) {
        expect(serializeError(err)).not.toContain(SECRET_KEY);
      }
    });

    it("keeps the API key out of a PROVIDER_RESPONSE_INVALID error (message + details)", async () => {
      const mockJson = { model: "", choices: [{ message: { content: "invalid" } }] };
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => mockJson });
      const provider = validProvider({ enableNetwork: true, fetchImpl: mockFetch as any });
      try {
        await provider.invoke(request);
        expect.fail("Should have thrown");
      } catch (err) {
        expect(serializeError(err)).not.toContain(SECRET_KEY);
      }
    });

    it("keeps the API key out of a CONFIG_INVALID error", () => {
      const provider = new OpenAICompatibleProvider({ apiKey: SECRET_KEY, baseUrl: "ftp://bad", model: MODEL });
      try {
        provider.validateConfig();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(serializeError(err)).not.toContain(SECRET_KEY);
      }
    });
  });

  describe("optional non-secret header merging", () => {
    it("merges custom headers into the request without overriding Authorization or Content-Type", () => {
      const provider = validProvider({
        headers: {
          "X-Org-Id": "org-42",
          "X-Custom-Trace": "trace-abc",
          // Attempts to override the protected headers must be ignored.
          Authorization: "Bearer attacker-override",
          "Content-Type": "text/plain",
        },
      });

      const built = provider.buildRequest({ ...request, model: MODEL });

      expect(built.url).toBe("https://proxy.unit.test/v1/chat/completions");
      expect(built.init.headers).toMatchObject({
        "X-Org-Id": "org-42",
        "X-Custom-Trace": "trace-abc",
        Authorization: `Bearer ${SECRET_KEY}`,
        "Content-Type": "application/json",
      });
      // The protected headers reflect the real credential/content-type, not the override attempts.
      expect(built.init.headers.Authorization).toBe(`Bearer ${SECRET_KEY}`);
      expect(built.init.headers["Content-Type"]).toBe("application/json");
    });

    it("sends merged headers through to the injected fetch on a live invocation", async () => {
      const mockJson = {
        model: MODEL,
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => mockJson });
      const provider = validProvider({
        enableNetwork: true,
        fetchImpl: mockFetch as any,
        headers: { "X-Org-Id": "org-42" },
      });

      await provider.invoke(request);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://proxy.unit.test/v1/chat/completions",
        expect.objectContaining({
          headers: expect.objectContaining({
            "X-Org-Id": "org-42",
            Authorization: `Bearer ${SECRET_KEY}`,
            "Content-Type": "application/json",
          }),
        })
      );
    });
  });
});
