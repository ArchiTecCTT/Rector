/**
 * Task 7.8 — Azure OpenAI Discovery_Adapter deployment-safety property test.
 *
 * **Feature: byok-chat-ux-and-model-discovery, Property 11: Azure candidates always require a deployment and never expose deployment ids**
 * **Validates: Requirements 15.2, 15.3**
 *
 * Property 11: *For any* Azure data-plane model list discovered from an
 * endpoint plus API key, every returned `Model_Candidate` SHALL have
 * `requiresDeployment === true` (Req 15.2) and SHALL carry no `deploymentId`
 * (Req 15.3) — even when the raw data-plane entry carries a deployment-shaped
 * field that the adapter must strip.
 *
 * The targeted, example-based behaviors (the data-plane request URL, the
 * management-plane short-circuit, error classification) live in
 * `discoveryAzureAdapter.test.ts` (task 7.5). This is the exhaustive
 * cross-input guarantee: it generates the widest plausible data-plane catalog —
 * entries with arbitrary id shapes, arbitrary extra fields, and a random subset
 * carrying `deployment` / `deployment_id` / `deploymentId` with arbitrary
 * values — and asserts only the two universal invariants the adapter must hold.
 *
 * Every run is hermetic: the catalog is served through an injected `fetchImpl`,
 * never a real network call.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import type { ProviderConfigRecord } from "../src/providers/config";
import { azureDiscoveryAdapter } from "../src/providers/discovery/adapters/azure";
import type { AdapterContext } from "../src/providers/discovery/adapters";

const ENDPOINT = "https://prop-resource.openai.azure.com";

/**
 * An arbitrary deployment-shaped value an adapter might find on a raw entry:
 * a non-empty string (the dangerous case the normalizer would otherwise emit),
 * or junk the normalizer would ignore. Either way no `deploymentId` may leak.
 */
const arbDeploymentValue: fc.Arbitrary<unknown> = fc.oneof(
  fc.string({ minLength: 1 }),
  fc.string(),
  fc.integer(),
  fc.constant(null),
  fc.record({ id: fc.string({ minLength: 1 }) }),
);

/** One arbitrary Azure data-plane entry's intent, resolved to a concrete entry by index. */
interface EntrySpec {
  /** Which id-shaped key carries the model id (Azure data-plane uses `id`). */
  idKey: "id" | "model" | "model_id" | "modelId";
  /** Whether the raw entry carries a `deployment` field. */
  hasDeployment: boolean;
  /** Whether the raw entry carries a `deployment_id` field. */
  hasDeploymentId: boolean;
  /** Whether the raw entry carries a `deploymentId` field. */
  hasDeploymentIdCamel: boolean;
  deploymentValue: unknown;
  deploymentIdValue: unknown;
  deploymentIdCamelValue: unknown;
  /** Optional capability-ish tags so the entry resembles a real catalog row. */
  capabilities: string[];
}

const arbEntrySpec: fc.Arbitrary<EntrySpec> = fc.record({
  idKey: fc.constantFrom("id", "model", "model_id", "modelId"),
  hasDeployment: fc.boolean(),
  hasDeploymentId: fc.boolean(),
  hasDeploymentIdCamel: fc.boolean(),
  deploymentValue: arbDeploymentValue,
  deploymentIdValue: arbDeploymentValue,
  deploymentIdCamelValue: arbDeploymentValue,
  capabilities: fc.array(fc.constantFrom("chat", "completions", "embeddings", "text generation"), { maxLength: 3 }),
});

/** A stable, unique model id per index so candidates are individually trackable. */
const modelId = (index: number): string => `gpt-prop-${index}`;

/** Build a single raw data-plane entry from its spec. */
function buildEntry(spec: EntrySpec, index: number): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    [spec.idKey]: modelId(index),
    capabilities: spec.capabilities,
  };
  if (spec.hasDeployment) {
    entry.deployment = spec.deploymentValue;
  }
  if (spec.hasDeploymentId) {
    entry.deployment_id = spec.deploymentIdValue;
  }
  if (spec.hasDeploymentIdCamel) {
    entry.deploymentId = spec.deploymentIdCamelValue;
  }
  return entry;
}

/** Build the Azure data-plane envelope (`{ object, data }`) from the specs. */
function buildCatalog(specs: readonly EntrySpec[]): unknown {
  return { object: "list", data: specs.map(buildEntry) };
}

function record(overrides: Partial<ProviderConfigRecord> = {}): ProviderConfigRecord {
  return {
    id: "azure-openai:prop",
    kind: "azure-openai",
    label: "Azure OpenAI",
    azure: { endpoint: ENDPOINT },
    secretRef: "azure-openai:prop",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function ctx(catalog: unknown, includeDeprecated: boolean): AdapterContext {
  const fetchImpl = (async () =>
    new Response(JSON.stringify(catalog), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  return {
    record: record(),
    secret: "az-prop-key",
    fetchImpl,
    includeDeprecated,
  };
}

describe("Feature: byok-chat-ux-and-model-discovery, Property 11: Azure candidates always require a deployment and never expose deployment ids", () => {
  // Validates: Requirements 15.2, 15.3
  it("sets requiresDeployment true and never emits a deploymentId for any data-plane catalog", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbEntrySpec, { minLength: 0, maxLength: 16 }),
        fc.boolean(),
        async (specs, includeDeprecated) => {
          const catalog = buildCatalog(specs);
          const result = await azureDiscoveryAdapter.discover(ctx(catalog, includeDeprecated));

          // The adapter never throws on a well-formed data-plane payload.
          expect(result.ok).toBe(true);
          if (!result.ok) {
            return;
          }

          // One candidate per data-plane entry — the adapter does not invent or
          // drop rows on the deployment-safety path.
          expect(result.candidates).toHaveLength(specs.length);

          for (const candidate of result.candidates) {
            // Req 15.2: every Azure candidate requires a deployment to be usable.
            expect(candidate.requiresDeployment).toBe(true);
            // Req 15.3: an endpoint + key cannot enumerate deployments, so no
            // deploymentId is ever emitted, even when the raw entry carried one.
            expect(candidate.deploymentId).toBeUndefined();
            expect(Object.prototype.hasOwnProperty.call(candidate, "deploymentId")).toBe(false);
            // The candidate stays scoped to the data-plane endpoint it came from.
            expect(candidate.scope).toMatchObject({ endpoint: ENDPOINT });
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
