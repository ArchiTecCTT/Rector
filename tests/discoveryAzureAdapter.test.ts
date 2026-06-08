/**
 * Task 7.5 — Azure OpenAI Discovery_Adapter unit tests
 * (Requirements 15.1, 15.2, 15.3, 15.4).
 *
 * These exercise {@link azureDiscoveryAdapter} against a mocked `fetch` to
 * confirm its data-plane request-URL contract and its honest handling of
 * deployments:
 *
 *   - it requests the data-plane list at
 *     `GET {endpoint}/openai/models?api-version=2024-10-21` (Req 15.1);
 *   - every returned candidate has `requiresDeployment === true` and carries no
 *     `deploymentId`, even when the raw entry contains a deployment-shaped
 *     field (Req 15.2, 15.3);
 *   - when deployment enumeration is requested (sentinel header) it returns a
 *     `requires_management_plane` error explaining ARM authentication is
 *     required, without any network call (Req 15.4);
 *   - transport and HTTP failures are classified rather than thrown.
 *
 * Property 11 (task 7.8) covers the deployment-safety invariant broadly; these
 * are targeted examples. Tests are hermetic: every request goes through an
 * injected `fetchImpl`.
 */
import { describe, expect, it, vi } from "vitest";

import type { ProviderConfigRecord } from "../src/providers/config";
import { azureDiscoveryAdapter } from "../src/providers/discovery/adapters/azure";
import type { AdapterContext } from "../src/providers/discovery/adapters/index";

const ENDPOINT = "https://my-resource.openai.azure.com";

function record(overrides: Partial<ProviderConfigRecord> = {}): ProviderConfigRecord {
  return {
    id: "azure-openai:main",
    kind: "azure-openai",
    label: "Azure OpenAI",
    azure: { endpoint: ENDPOINT },
    secretRef: "azure-openai:main",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function ctx(fetchImpl: typeof fetch, overrides: Partial<AdapterContext> = {}): AdapterContext {
  return {
    record: record(),
    secret: "az-test-key",
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

describe("azureDiscoveryAdapter", () => {
  it("requests the data-plane model list at {endpoint}/openai/models?api-version=2024-10-21 (Req 15.1)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ object: "list", data: [{ id: "gpt-4o", capabilities: ["chat"] }] }),
    ) as unknown as typeof fetch;

    const result = await azureDiscoveryAdapter.discover(ctx(fetchImpl));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      `${ENDPOINT}/openai/models?api-version=2024-10-21`,
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ "api-key": "az-test-key" }),
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("sets requiresDeployment true and never emits a deploymentId, even when the raw entry carries one (Req 15.2, 15.3)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        object: "list",
        data: [
          { id: "gpt-4o", deployment: "should-be-ignored", deployment_id: "dep-123", deploymentId: "dep-456" },
          { id: "text-embedding-3-large" },
        ],
      }),
    ) as unknown as typeof fetch;

    const result = await azureDiscoveryAdapter.discover(ctx(fetchImpl));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candidates).toHaveLength(2);
      for (const candidate of result.candidates) {
        expect(candidate.requiresDeployment).toBe(true);
        expect(candidate.deploymentId).toBeUndefined();
        expect(candidate).not.toHaveProperty("deploymentId");
        expect(candidate.scope).toMatchObject({ endpoint: ENDPOINT });
      }
      expect(result.candidates[0].modelId).toBe("gpt-4o");
    }
  });

  it("reports requires_management_plane when deployment enumeration is requested, with no network call (Req 15.4)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] })) as unknown as typeof fetch;

    const result = await azureDiscoveryAdapter.discover(
      ctx(fetchImpl, {
        record: record({ headers: { "x-rector-azure-enumerate-deployments": "true" } }),
      }),
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("requires_management_plane");
      expect(result.error.message).toMatch(/management-plane/i);
    }
  });

  it("returns endpoint_invalid when no endpoint is configured", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] })) as unknown as typeof fetch;

    const result = await azureDiscoveryAdapter.discover(
      ctx(fetchImpl, { record: record({ azure: {}, baseUrl: undefined }) }),
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("endpoint_invalid");
    }
  });

  it("classifies an auth failure rather than throwing", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 401 })) as unknown as typeof fetch;

    const result = await azureDiscoveryAdapter.discover(ctx(fetchImpl));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("auth_invalid");
    }
  });

  it("classifies a transport failure as a network error instead of throwing", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const result = await azureDiscoveryAdapter.discover(ctx(fetchImpl));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("network_error");
    }
  });
});
