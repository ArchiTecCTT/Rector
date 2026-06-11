/**
 * Task 7.9 — Adapter request URLs and edge branches
 * (Requirements 12.1, 13.1, 13.2, 14.1, 15.1, 15.4).
 *
 * A focused, consolidated check of the request-URL contract for every
 * Discovery_Adapter plus the two named edge branches:
 *
 *   - Cloudflare requests `GET {baseUrl}/accounts/{account_id}/ai/models/search`
 *     (Req 12.1);
 *   - Together requests the native `GET {baseUrl}/models` first (Req 13.1) and
 *     falls back to the OpenAI-compatible `GET {baseUrl}/v1/models` only when
 *     the native endpoint answers 404 (Req 13.2);
 *   - the OpenAI-compatible adapter requests `GET {baseUrl}/v1/models` (Req 14.1);
 *   - Azure requests `GET {endpoint}/openai/models?api-version=2024-10-21`
 *     (Req 15.1), and reports a `requires_management_plane` message when
 *     deployment enumeration is requested (Req 15.4).
 *
 * These assertions deliberately target only the request URL and the edge
 * branches called out by the task; per-adapter normalization, filtering, and
 * error classification are covered by the adapter-specific suites (tasks
 * 7.2–7.5) and the property tests (tasks 7.6–7.8). Every request goes through an
 * injected `fetchImpl`, so the suite stays hermetic (Requirement 29).
 */
import { describe, expect, it, vi } from "vitest";

import type { ProviderConfigRecord } from "../src/providers/config";
import type { AdapterContext } from "../src/providers/discovery/adapters/index";
import { azureDiscoveryAdapter } from "../src/providers/discovery/adapters/azure";
import { cloudflareDiscoveryAdapter } from "../src/providers/discovery/adapters/cloudflare";
import { openaiCompatibleDiscoveryAdapter } from "../src/providers/discovery/adapters/openaiCompatible";
import { togetherDiscoveryAdapter } from "../src/providers/discovery/adapters/together";

const TIMESTAMPS = { createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function ctx(record: ProviderConfigRecord, fetchImpl: typeof fetch, secret = "test-secret"): AdapterContext {
  return { record, secret, fetchImpl, includeDeprecated: false };
}

describe("discovery adapter request URLs (task 7.9)", () => {
  it("Cloudflare requests GET {baseUrl}/accounts/{account_id}/ai/models/search (Req 12.1)", async () => {
    const baseUrl = "https://api.cloudflare.com/client/v4";
    const accountId = "acct-7-9";
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ success: true, result: [] }),
    ) as unknown as typeof fetch;

    const record: ProviderConfigRecord = {
      id: "cloudflare:main",
      kind: "cloudflare",
      label: "Cloudflare",
      cloudflare: { accountId },
      secretRef: "cloudflare:main",
      ...TIMESTAMPS,
    };

    await cloudflareDiscoveryAdapter.discover(ctx(record, fetchImpl));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      `${baseUrl}/accounts/${accountId}/ai/models/search`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("Together requests the native GET {baseUrl}/models first (Req 13.1)", async () => {
    const baseUrl = "https://api.together.xyz";
    const fetchImpl = vi.fn(async () => jsonResponse([])) as unknown as typeof fetch;

    const record: ProviderConfigRecord = {
      id: "together:main",
      kind: "together",
      label: "Together",
      baseUrl,
      secretRef: "together:main",
      ...TIMESTAMPS,
    };

    await togetherDiscoveryAdapter.discover(ctx(record, fetchImpl));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(`${baseUrl}/models`, expect.objectContaining({ method: "GET" }));
  });

  it("Together falls back to GET {baseUrl}/v1/models only when the native endpoint answers 404 (Req 13.2)", async () => {
    const baseUrl = "https://api.together.xyz";
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === `${baseUrl}/models`) {
        return new Response(null, { status: 404 });
      }
      return jsonResponse({ object: "list", data: [{ id: "Qwen/Qwen2-72B" }] });
    }) as unknown as typeof fetch;

    const record: ProviderConfigRecord = {
      id: "together:main",
      kind: "together",
      label: "Together",
      baseUrl,
      secretRef: "together:main",
      ...TIMESTAMPS,
    };

    const result = await togetherDiscoveryAdapter.discover(ctx(record, fetchImpl));

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenNthCalledWith(1, `${baseUrl}/models`, expect.objectContaining({ method: "GET" }));
    expect(fetchImpl).toHaveBeenNthCalledWith(2, `${baseUrl}/v1/models`, expect.objectContaining({ method: "GET" }));
    expect(result.ok).toBe(true);
  });

  it("Together does not fall back when the native endpoint returns a non-404 error (Req 13.2)", async () => {
    const baseUrl = "https://api.together.xyz";
    const fetchImpl = vi.fn(async () => new Response(null, { status: 500 })) as unknown as typeof fetch;

    const record: ProviderConfigRecord = {
      id: "together:main",
      kind: "together",
      label: "Together",
      baseUrl,
      secretRef: "together:main",
      ...TIMESTAMPS,
    };

    await togetherDiscoveryAdapter.discover(ctx(record, fetchImpl));

    // A 500 would recur on the fallback path, so only the native list is requested.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(`${baseUrl}/models`, expect.objectContaining({ method: "GET" }));
  });

  it("OpenAI-compatible requests GET {baseUrl}/v1/models (Req 14.1)", async () => {
    const baseUrl = "https://proxy.example.com";
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ object: "list", data: [] }),
    ) as unknown as typeof fetch;

    const record: ProviderConfigRecord = {
      id: "openai-compatible:proxy",
      kind: "openai-compatible",
      label: "Proxy",
      baseUrl,
      secretRef: "openai-compatible:proxy",
      ...TIMESTAMPS,
    };

    await openaiCompatibleDiscoveryAdapter.discover(ctx(record, fetchImpl));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(`${baseUrl}/v1/models`, expect.objectContaining({ method: "GET" }));
  });

  it("Azure requests GET {endpoint}/openai/models?api-version=2024-10-21 (Req 15.1)", async () => {
    const endpoint = "https://my-resource.openai.azure.com";
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ object: "list", data: [] }),
    ) as unknown as typeof fetch;

    const record: ProviderConfigRecord = {
      id: "azure-openai:main",
      kind: "azure-openai",
      label: "Azure OpenAI",
      azure: { endpoint },
      secretRef: "azure-openai:main",
      ...TIMESTAMPS,
    };

    await azureDiscoveryAdapter.discover(ctx(record, fetchImpl));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      `${endpoint}/openai/models?api-version=2024-10-21`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("Azure reports a requires_management_plane message for deployment enumeration with no network call (Req 15.4)", async () => {
    const endpoint = "https://my-resource.openai.azure.com";
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] })) as unknown as typeof fetch;

    const record: ProviderConfigRecord = {
      id: "azure-openai:main",
      kind: "azure-openai",
      label: "Azure OpenAI",
      azure: { endpoint },
      headers: { "x-rector-azure-enumerate-deployments": "true" },
      secretRef: "azure-openai:main",
      ...TIMESTAMPS,
    };

    const result = await azureDiscoveryAdapter.discover(ctx(record, fetchImpl));

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("requires_management_plane");
      expect(result.error.message).toMatch(/management-plane/i);
    }
  });
});
