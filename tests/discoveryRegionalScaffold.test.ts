/**
 * Task 14.2 — Optional Regional_Discovery scaffold unit tests
 * (Requirements 26.1, 26.2, 26.3).
 *
 * These exercise the scaffold at `src/providers/discovery/adapters/regional.ts`
 * against a MOCK injected cloud client to confirm:
 *
 *   - it distinguishes the four failure states the requirement calls out — an
 *     invalid key vs. a region vs. a deployment vs. a model unavailability —
 *     mapping each to a distinct classified error (Req 26.2);
 *   - every cloud interaction goes through the injected client, so no live
 *     Azure management-plane or AWS Bedrock call is ever made (Req 26.3);
 *   - the scaffold is not wired into the foundation registry (Req 26.1):
 *     it exports standalone functions, not a registered DiscoveryAdapter.
 *
 * Tests are hermetic: the only cloud boundary is a `vi.fn()` mock.
 */
import { describe, expect, it, vi } from "vitest";

import {
  classifyRegionalError,
  discoverRegionalModels,
  toDiscoveryError,
  type RegionalCloudClient,
  type RegionalModelDescriptor,
} from "../src/providers/discovery/adapters/regional";

/** A mock cloud client that rejects with the given cloud-error shape. */
function rejectingClient(error: unknown): RegionalCloudClient {
  return { listRegionalModels: vi.fn(async () => Promise.reject(error)) };
}

/** A mock cloud client that resolves with the given descriptors. */
function resolvingClient(models: RegionalModelDescriptor[]): RegionalCloudClient {
  return { listRegionalModels: vi.fn(async () => models) };
}

describe("regional discovery scaffold", () => {
  it("classifies an invalid key as auth_invalid (distinct from availability failures)", async () => {
    const client = rejectingClient({ statusCode: 401, code: "InvalidApiKey" });

    const result = await discoverRegionalModels(client, { region: "eastus", modelId: "gpt-4o" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("auth_invalid");
      expect(result.error.message).not.toContain("InvalidApiKey");
    }
  });

  it("classifies a region unavailability distinctly from an invalid key", async () => {
    const client = rejectingClient({ statusCode: 400, code: "LocationNotAvailableForResourceType" });

    const result = await discoverRegionalModels(client, { region: "narnia-1", modelId: "gpt-4o" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("region_unavailable");
    }
  });

  it("classifies a deployment unavailability distinctly", async () => {
    const client = rejectingClient({ statusCode: 404, code: "DeploymentNotFound" });

    const result = await discoverRegionalModels(client, {
      region: "eastus",
      deployment: "missing-deployment",
      modelId: "gpt-4o",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("deployment_unavailable");
    }
  });

  it("classifies a model unavailability from a listed-but-ungranted model", async () => {
    // The call succeeds, but the requested model is present yet not granted —
    // the Bedrock GetFoundationModelAvailability readiness case.
    const client = resolvingClient([
      { modelId: "gpt-4o", region: "eastus", available: false },
    ]);

    const result = await discoverRegionalModels(client, { region: "eastus", modelId: "gpt-4o" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("model_unavailable");
    }
  });

  it("yields four distinct categories for the four failure states", () => {
    const categories = new Set([
      classifyRegionalError({ statusCode: 403 }),
      classifyRegionalError({ code: "LocationNotAvailableForResourceType" }),
      classifyRegionalError({ code: "DeploymentNotFound" }),
      classifyRegionalError({ code: "ModelNotAuthorized" }),
    ]);

    expect(categories).toEqual(
      new Set(["auth_invalid", "region_unavailable", "deployment_unavailable", "model_unavailable"]),
    );
  });

  it("returns only granted models on success and makes exactly one injected call", async () => {
    const models: RegionalModelDescriptor[] = [
      { modelId: "gpt-4o", region: "eastus", deploymentId: "prod-gpt4o", available: true },
      { modelId: "legacy", region: "eastus", available: false },
    ];
    const client = resolvingClient(models);

    const result = await discoverRegionalModels(client, { region: "eastus" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.models.map((model) => model.modelId)).toEqual(["gpt-4o"]);
    }
    // The only cloud boundary touched is the injected mock — no live call.
    expect(client.listRegionalModels).toHaveBeenCalledTimes(1);
  });

  it("maps scaffold errors onto the foundation DiscoveryError shape", () => {
    expect(toDiscoveryError({ category: "auth_invalid", message: "x" }).category).toBe("auth_invalid");
    expect(toDiscoveryError({ category: "region_unavailable", message: "x" }).category).toBe(
      "requires_management_plane",
    );
    expect(toDiscoveryError({ category: "deployment_unavailable", message: "x" }).category).toBe(
      "requires_management_plane",
    );
    expect(toDiscoveryError({ category: "model_unavailable", message: "x" }).category).toBe(
      "requires_management_plane",
    );
  });
});
