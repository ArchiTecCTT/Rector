/**
 * Task 5.10 — OpenAI-compatible Discovery_Adapter request-shape unit test
 * (Requirements 2.6).
 *
 * Requirement 2.6 fixes the request contract for the generic OpenAI-compatible
 * adapter: when it runs with a configured base URL and credential, it SHALL
 * request `GET {baseUrl}/v1/models`. This test pins exactly that — the first
 * (and here, only) request issued goes to `{baseUrl}/v1/models` with the `GET`
 * method.
 *
 * The test is hermetic: the adapter's network access is replaced with an
 * injected `fetchImpl` double that records its arguments and returns a minimal
 * OpenAI-compatible `{ object: "list", data: [...] }` envelope, so no real
 * network call is made.
 */
import { describe, expect, it, vi } from "vitest";

import type { ProviderConfigRecord } from "../src/providers/config";
import { openaiCompatibleDiscoveryAdapter } from "../src/providers/discovery/adapters/openaiCompatible";
import type { AdapterContext } from "../src/providers/discovery/adapters";

/** A base URL that already carries the conventional `/v1` segment. */
const BASE_URL = "https://api.example.com/v1";

function record(overrides: Partial<ProviderConfigRecord> = {}): ProviderConfigRecord {
  return {
    id: "openai-compatible:main",
    kind: "openai-compatible",
    label: "OpenAI Compatible",
    baseUrl: BASE_URL,
    secretRef: "openai-compatible:main",
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

describe("openaiCompatibleDiscoveryAdapter request shape (Req 2.6)", () => {
  it("issues GET {baseUrl}/v1/models as the first request", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ object: "list", data: [{ id: "gpt-4o-mini" }] }),
    ) as unknown as typeof fetch;

    await openaiCompatibleDiscoveryAdapter.discover(ctx(fetchImpl));

    // The first request must target {baseUrl}/v1/models with the GET method.
    expect(fetchImpl).toHaveBeenCalled();
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.example.com/v1/models");
    expect(init).toMatchObject({ method: "GET" });
  });

  it("resolves {baseUrl}/v1/models even when the base URL omits the /v1 segment", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ object: "list", data: [{ id: "gpt-4o-mini" }] }),
    ) as unknown as typeof fetch;

    await openaiCompatibleDiscoveryAdapter.discover(
      ctx(fetchImpl, { record: record({ baseUrl: "https://api.example.com" }) }),
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.example.com/v1/models",
      expect.objectContaining({ method: "GET" }),
    );
  });
});
