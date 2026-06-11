/**
 * Task 5.7 — Azure Discovery_Adapter management-plane error unit test
 * (Validates: Requirements 2.5).
 *
 * Requirement 2.5: IF a discovery request to the Azure_Discovery_Adapter
 * requests deployment enumeration, THEN THE Azure_Discovery_Adapter SHALL
 * return a Discovery_Error with category `requires_management_plane`.
 *
 * Per the adapter implementation, a deployment-enumeration request is signaled
 * via the non-secret sentinel header `x-rector-azure-enumerate-deployments`
 * carrying a truthy value on the record's `headers` map. When present, the
 * adapter short-circuits to the classified `requires_management_plane` error
 * BEFORE any network access — an endpoint + key (the data plane) cannot
 * enumerate deployments, which is a management-plane (ARM) operation.
 *
 * These tests stay focused and hermetic: the injected `fetchImpl` is a counting
 * double, so verifying it is never invoked proves zero network access on the
 * enumeration path.
 */
import { describe, expect, it, vi } from "vitest";

import type { ProviderConfigRecord } from "../src/providers/config";
import { azureDiscoveryAdapter } from "../src/providers/discovery/adapters/azure";
import type { AdapterContext } from "../src/providers/discovery/adapters/index";

const ENUMERATE_DEPLOYMENTS_HEADER = "x-rector-azure-enumerate-deployments";

function record(overrides: Partial<ProviderConfigRecord> = {}): ProviderConfigRecord {
  return {
    id: "azure-openai:main",
    kind: "azure-openai",
    label: "Azure OpenAI",
    azure: { endpoint: "https://example.openai.azure.com" },
    secretRef: "azure-openai:main",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function ctx(fetchImpl: typeof fetch, overrides: Partial<AdapterContext> = {}): AdapterContext {
  return {
    record: record(),
    secret: "azure-key",
    fetchImpl,
    includeDeprecated: false,
    ...overrides,
  };
}

describe("azureDiscoveryAdapter — deployment-enumeration request (Req 2.5)", () => {
  it("returns a requires_management_plane Discovery_Error without any network access", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network access must not occur on the enumeration path");
    }) as unknown as typeof fetch;

    const result = await azureDiscoveryAdapter.discover(
      ctx(fetchImpl, {
        record: record({ headers: { [ENUMERATE_DEPLOYMENTS_HEADER]: "true" } }),
      }),
    );

    // No network was performed: the counting double was never invoked.
    expect(fetchImpl).not.toHaveBeenCalled();

    // The result is a classified management-plane error.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("requires_management_plane");
      // The message is non-empty and leaks no secret value.
      expect(result.error.message.length).toBeGreaterThan(0);
      expect(result.error.message).not.toContain("azure-key");
    }
  });

  it("treats the sentinel header case-insensitively as an enumeration request", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network access must not occur on the enumeration path");
    }) as unknown as typeof fetch;

    const result = await azureDiscoveryAdapter.discover(
      ctx(fetchImpl, {
        record: record({ headers: { "X-Rector-Azure-Enumerate-Deployments": "yes" } }),
      }),
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("requires_management_plane");
    }
  });

  it("does not treat a falsy sentinel header as an enumeration request", async () => {
    // With the sentinel explicitly disabled, the adapter proceeds to the
    // data-plane catalog read instead of short-circuiting; the counting double
    // observes exactly one request, confirming the enumeration guard did not fire.
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "gpt-4o" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    const result = await azureDiscoveryAdapter.discover(
      ctx(fetchImpl, {
        record: record({ headers: { [ENUMERATE_DEPLOYMENTS_HEADER]: "false" } }),
      }),
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });
});
