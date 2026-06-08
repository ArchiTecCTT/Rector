/**
 * Task 7.3 — Together AI Discovery_Adapter unit tests
 * (Requirements 13.1, 13.2, 13.3).
 *
 * These exercise {@link togetherDiscoveryAdapter} against a mocked `fetch` to
 * confirm its request-URL contract and the OpenAI-compatible fallback:
 *
 *   - it requests the native `GET {baseUrl}/models` first (Req 13.1);
 *   - when the native endpoint answers 404 it falls back to the
 *     OpenAI-compatible `GET {baseUrl}/v1/models` and parses the `{ data: [] }`
 *     shape (Req 13.2);
 *   - a non-404 error (e.g. auth) is classified directly without a fallback;
 *   - a transport failure is classified as a network error rather than thrown.
 *
 * Enumeration reads only the model catalog — no Responses API call is made
 * (Req 13.3). Tests are hermetic: every request goes through an injected
 * `fetchImpl`.
 */
import { describe, expect, it, vi } from "vitest";

import type { ProviderConfigRecord } from "../src/providers/config";
import { togetherDiscoveryAdapter } from "../src/providers/discovery/adapters/together";
import type { AdapterContext } from "../src/providers/discovery/adapters/index";

const BASE_URL = "https://api.together.xyz";

function record(overrides: Partial<ProviderConfigRecord> = {}): ProviderConfigRecord {
  return {
    id: "together:main",
    kind: "together",
    label: "Together",
    baseUrl: BASE_URL,
    secretRef: "together:main",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function ctx(fetchImpl: typeof fetch, overrides: Partial<AdapterContext> = {}): AdapterContext {
  return {
    record: record(),
    secret: "sk-test",
    fetchImpl,
    includeDeprecated: false,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("togetherDiscoveryAdapter", () => {
  it("requests the native GET /models first and normalizes the bare array", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([
        { id: "meta-llama/Llama-3-70b-chat", type: "chat", context_length: 8192 },
        { id: "togethercomputer/m2-bert", type: "embedding" },
      ]),
    ) as unknown as typeof fetch;

    const result = await togetherDiscoveryAdapter.discover(ctx(fetchImpl));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(`${BASE_URL}/models`, expect.objectContaining({ method: "GET" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candidates).toHaveLength(2);
      expect(result.candidates[0]).toMatchObject({
        providerId: "together:main",
        kind: "together",
        source: "together",
        modelId: "meta-llama/Llama-3-70b-chat",
        contextWindow: 8192,
      });
      expect(result.candidates[0].capabilities).toContain("chat");
    }
  });

  it("falls back to GET /v1/models when the native endpoint answers 404", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === `${BASE_URL}/models`) {
        return new Response(null, { status: 404 });
      }
      return jsonResponse({ object: "list", data: [{ id: "Qwen/Qwen2-72B", type: "chat" }] });
    }) as unknown as typeof fetch;

    const result = await togetherDiscoveryAdapter.discover(ctx(fetchImpl));

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenNthCalledWith(1, `${BASE_URL}/models`, expect.objectContaining({ method: "GET" }));
    expect(fetchImpl).toHaveBeenNthCalledWith(2, `${BASE_URL}/v1/models`, expect.objectContaining({ method: "GET" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0].modelId).toBe("Qwen/Qwen2-72B");
    }
  });

  it("sends the bearer secret and respects a configured baseUrl without a trailing slash issue", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([])) as unknown as typeof fetch;

    await togetherDiscoveryAdapter.discover(
      ctx(fetchImpl, { record: record({ baseUrl: "https://proxy.example.com/together/" }) }),
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://proxy.example.com/together/models",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer sk-test" }),
      }),
    );
  });

  it("classifies an auth failure directly without falling back", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 401 })) as unknown as typeof fetch;

    const result = await togetherDiscoveryAdapter.discover(ctx(fetchImpl));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("auth_invalid");
    }
  });

  it("classifies a transport failure as a network error instead of throwing", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const result = await togetherDiscoveryAdapter.discover(ctx(fetchImpl));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("network_error");
    }
  });

  it("returns an unsupported_response error for an unrecognizable body", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ unexpected: true })) as unknown as typeof fetch;

    const result = await togetherDiscoveryAdapter.discover(ctx(fetchImpl));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("unsupported_response");
    }
  });
});
