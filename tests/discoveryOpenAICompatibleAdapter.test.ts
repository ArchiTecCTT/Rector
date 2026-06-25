/**
 * Task 7.4 — OpenAI-compatible Discovery_Adapter unit tests
 * (Requirements 14.1, 14.2, 14.3).
 *
 * These exercise {@link openaiCompatibleDiscoveryAdapter} against a mocked
 * `fetch` to confirm its narrow contract:
 *
 *   - it requests the model list at `GET {baseUrl}/v1/models` (Req 14.1), and
 *     does not double a `/v1` segment already present on the base URL;
 *   - it normalizes entries that omit optional fields without raising
 *     (Req 14.2);
 *   - it returns a classified error result for an unrecognizable list rather
 *     than throwing (Req 14.3).
 *
 * Property 9 (task 7.6) covers normalization broadly; these stay targeted.
 * Tests are hermetic: every request goes through an injected `fetchImpl`.
 */
import { describe, expect, it, vi } from "vitest";

import type { ProviderConfigRecord } from "../src/providers/config";
import { openaiCompatibleDiscoveryAdapter } from "../src/providers/discovery/adapters/openaiCompatible";
import type { AdapterContext } from "../src/providers/discovery/adapters";

const BASE_URL = "https://proxy.example.com";

function record(overrides: Partial<ProviderConfigRecord> = {}): ProviderConfigRecord {
  return {
    id: "openai-compatible:proxy",
    kind: "openai-compatible",
    label: "Proxy",
    baseUrl: BASE_URL,
    secretRef: "openai-compatible:proxy",
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

describe("openaiCompatibleDiscoveryAdapter", () => {
  it("requests GET {baseUrl}/v1/models with a bearer secret (Req 14.1)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ object: "list", data: [{ id: "gpt-4o-mini" }] }),
    ) as unknown as typeof fetch;

    const result = await openaiCompatibleDiscoveryAdapter.discover(ctx(fetchImpl));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      `${BASE_URL}/v1/models`,
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer sk-test" }),
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("does not double a /v1 segment already present on the base URL (Req 14.1)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ object: "list", data: [] })) as unknown as typeof fetch;

    await openaiCompatibleDiscoveryAdapter.discover(
      ctx(fetchImpl, { record: record({ baseUrl: "https://api.openai.com/v1/" }) }),
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.openai.com/v1/models",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("normalizes entries that omit optional fields without raising (Req 14.2)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        object: "list",
        // First entry is a bare id with every optional field omitted.
        data: [{ id: "minimal-model" }, { id: "rich-model", context_length: 32768 }],
      }),
    ) as unknown as typeof fetch;

    const result = await openaiCompatibleDiscoveryAdapter.discover(ctx(fetchImpl));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candidates).toHaveLength(2);

      const minimal = result.candidates[0];
      expect(minimal).toMatchObject({
        providerId: "openai-compatible:proxy",
        kind: "openai-compatible",
        source: "openai-compatible",
        modelId: "minimal-model",
        displayName: "minimal-model",
      });
      // Omitted optional fields stay omitted rather than emitted empty.
      expect(minimal.contextWindow).toBeUndefined();
      expect(minimal.pricing).toBeUndefined();
      expect(minimal.lifecycle).toBeUndefined();

      expect(result.candidates[1].contextWindow).toBe(32768);
    }
  });

  it("returns a classified error result for an unrecognizable list (Req 14.3)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ unexpected: true })) as unknown as typeof fetch;

    const result = await openaiCompatibleDiscoveryAdapter.discover(ctx(fetchImpl));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("unsupported_response");
    }
  });

  it("classifies a transport failure as a network error instead of throwing (Req 14.3)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const result = await openaiCompatibleDiscoveryAdapter.discover(ctx(fetchImpl));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("network_error");
    }
  });
});
