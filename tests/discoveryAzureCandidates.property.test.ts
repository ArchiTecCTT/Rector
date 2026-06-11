/**
 * Task 5.6 — Azure OpenAI Discovery_Adapter candidate-invariant property test.
 *
 * **Feature: cloud-capable-transition, Property 8: Azure candidates require deployment and omit deployment ids**
 * **Validates: Requirements 2.4**
 *
 * For any Azure data-plane catalog response, every emitted Model_Candidate has
 * `requiresDeployment === true` and carries no deployment identifier.
 *
 * Azure separates the data plane (endpoint + key, which lists the catalog) from
 * the management plane (ARM, the only surface that can enumerate deployments).
 * An endpoint + key therefore has no authority to know a deployment id, so the
 * adapter must (a) mark every candidate `requiresDeployment: true` and (b) never
 * emit a `deploymentId` — even when the raw catalog entry carries a
 * deployment-shaped field. This generator deliberately seeds entries with
 * `deployment` / `deployment_id` / `deploymentId` values in assorted casings to
 * prove they are stripped rather than passed through.
 *
 * Every run is hermetic: the catalog is served through an injected `fetchImpl`,
 * never a real network call.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import type { ProviderConfigRecord } from "../src/providers/config";
import { azureDiscoveryAdapter } from "../src/providers/discovery/adapters/azure";
import type { AdapterContext } from "../src/providers/discovery/adapters/index";

const ENDPOINT = "https://prop8.openai.azure.com";

/** A stable, unique model id per index so candidates are individually trackable. */
const modelId = (index: number): string => `gpt-prop8-${index}`;

/** One arbitrary catalog entry's intent, resolved to a concrete entry by index. */
interface EntrySpec {
  /** Whether to attach a (must-be-stripped) deployment-shaped field. */
  withDeploymentField: boolean;
  /** Which deployment-shaped key to use when attaching one. */
  deploymentKey: "deployment" | "deployment_id" | "deploymentId";
  /** The deployment id value the catalog tries (and fails) to leak. */
  deploymentValue: string;
  /** Optional capability tag carried by the entry. */
  capability: string;
}

const arbEntrySpec: fc.Arbitrary<EntrySpec> = fc.record({
  withDeploymentField: fc.boolean(),
  deploymentKey: fc.constantFrom("deployment", "deployment_id", "deploymentId"),
  deploymentValue: fc
    .string({ minLength: 1, maxLength: 24 })
    .map((s) => s.trim())
    .filter((s) => s.length > 0),
  capability: fc.constantFrom("chat", "completions", "embeddings", "text-generation"),
});

/** Build a single raw catalog entry from its spec. */
function buildEntry(spec: EntrySpec, index: number): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    id: modelId(index),
    capabilities: [spec.capability],
  };
  if (spec.withDeploymentField) {
    entry[spec.deploymentKey] = spec.deploymentValue;
  }
  return entry;
}

function record(): ProviderConfigRecord {
  return {
    id: "azure-openai:prop-8",
    kind: "azure-openai",
    label: "Azure OpenAI",
    azure: { endpoint: ENDPOINT },
    secretRef: "azure-openai:prop-8",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/**
 * Build an {@link AdapterContext} whose injected `fetchImpl` serves the catalog.
 * `bareArray` toggles between the `{ data: [...] }` envelope and a bare array,
 * both of which the adapter accepts, so the property holds across both shapes.
 */
function ctx(entries: readonly Record<string, unknown>[], bareArray: boolean): AdapterContext {
  const payload: unknown = bareArray ? entries : { data: entries };
  const fetchImpl = (async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  return {
    record: record(),
    secret: "azure-key",
    fetchImpl,
    includeDeprecated: false,
  };
}

describe("Feature: cloud-capable-transition, Property 8: Azure candidates require deployment and omit deployment ids", () => {
  // Validates: Requirements 2.4
  it("emits requiresDeployment === true and no deploymentId for every candidate", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbEntrySpec, { minLength: 0, maxLength: 16 }),
        fc.boolean(),
        async (specs, bareArray) => {
          const entries = specs.map((spec, index) => buildEntry(spec, index));

          const result = await azureDiscoveryAdapter.discover(ctx(entries, bareArray));

          // A well-formed catalog always discovers successfully.
          expect(result.ok).toBe(true);
          if (!result.ok) {
            return;
          }

          // One candidate is emitted per catalog entry...
          expect(result.candidates).toHaveLength(specs.length);

          for (const candidate of result.candidates) {
            // ...and every candidate requires a deployment (Req 2.4)...
            expect(candidate.requiresDeployment).toBe(true);
            // ...and carries no deployment identifier, even when the raw entry
            // tried to supply one (Req 2.4).
            expect(candidate.deploymentId).toBeUndefined();
            expect(Object.prototype.hasOwnProperty.call(candidate, "deploymentId")).toBe(false);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
