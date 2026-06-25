/**
 * Task 5.14 — Discovery_Adapter non-throwing classification property test.
 *
 * **Feature: cloud-capable-transition, Property 11: Adapters never throw and always classify failures**
 * **Validates: Requirements 2.12**
 *
 * For any Discovery_Adapter (together, cloudflare, azure-openai, or
 * openai-compatible) running against an arbitrary, hostile transport — a thrown
 * transport error (including an abort/timeout), any non-OK HTTP status, a
 * non-JSON body, or a structurally malformed-but-valid JSON payload — the
 * adapter SHALL NOT raise an exception and SHALL return a well-formed
 * {@link AdapterResult}: either a success carrying schema-valid Model_Candidates
 * or a classified, redacted {@link DiscoveryError} drawn from the closed
 * category set (Requirement 2.12).
 *
 * This is the cross-adapter property: every iteration drives all four adapters
 * with the *same* failure shape so the universal "never throw, always classify"
 * guarantee is exercised across the full registry. Each adapter is configured
 * with valid coordinates (base URL / account id / endpoint) and a non-blank
 * credential so the run reaches the transport boundary rather than
 * short-circuiting on a missing coordinate (those classified-coordinate paths
 * are Property 10's concern). The OpenAI-compatible record carries no
 * Manual_Model_List, so an unusable endpoint must classify rather than fall back
 * (the fallback path is Property 12's concern).
 *
 * Every run is hermetic: the transport is an injected `fetchImpl` double, never a
 * real network call, and the injected secret is asserted absent from every
 * returned error message.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import type { ProviderConfigRecord, ProviderKind } from "../src/providers/config";
import { azureDiscoveryAdapter } from "../src/providers/discovery/adapters/azure";
import { cloudflareDiscoveryAdapter } from "../src/providers/discovery/adapters/cloudflare";
import { openaiCompatibleDiscoveryAdapter } from "../src/providers/discovery/adapters/openaiCompatible";
import { togetherDiscoveryAdapter } from "../src/providers/discovery/adapters/together";
import type { AdapterContext, DiscoveryAdapter } from "../src/providers/discovery/adapters";
import {
  DiscoveryErrorCategorySchema,
  DiscoveryErrorSchema,
  ModelCandidateSchema,
} from "../src/providers/discovery/types";

/** A fixed, schema-valid ISO timestamp for record metadata. */
const TS = "2026-01-01T00:00:00.000Z";

/** The transient credential injected into every run; must never leak into an error. */
const SECRET = "sk-prop11-super-secret-token-value";

/** The closed set of categories an adapter may classify a failure into. */
const VALID_CATEGORIES = new Set(DiscoveryErrorCategorySchema.options);

/**
 * How the injected transport behaves for one run. Each shape models a distinct
 * failure mode an adapter must classify rather than throw on (Requirement 2.12),
 * plus a well-formed catalog so the success branch is also exercised.
 */
type FetchSpec =
  | { type: "transport-throw"; error: unknown }
  | { type: "non-ok"; status: number }
  | { type: "ok-json"; body: unknown }
  | { type: "ok-invalid-json" }
  | { type: "ok-valid-catalog" };

/** Transport errors a thrown `fetch` may surface, including an abort/timeout. */
const arbTransportError: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant(new Error("ECONNREFUSED")),
  fc.constant(new TypeError("Failed to fetch")),
  fc.constant(Object.assign(new Error("aborted"), { name: "AbortError" })),
  fc.constant("string failure"),
  fc.constant(null),
  fc.constant({ weird: "object" }),
);

/** Any non-OK HTTP status the `Response` constructor accepts (200..599, minus 2xx). */
const arbNonOkStatus: fc.Arbitrary<number> = fc
  .integer({ min: 300, max: 599 })
  .map((status) => status);

/**
 * Arbitrary JSON-serializable payloads, biased toward malformed catalog shapes
 * (bare scalars, nested objects, arrays of garbage) so normalization and the
 * "unsupported_response" classification are both exercised.
 */
const arbJsonBody: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant(null),
  fc.constant(42),
  fc.constant("plain string"),
  fc.constant({ unexpected: true }),
  fc.constant({ data: "not-an-array" }),
  fc.array(fc.oneof(fc.constant(null), fc.integer(), fc.string(), fc.constant({})), { maxLength: 6 }),
  fc.array(fc.record({ id: fc.string(), extra: fc.anything() }), { maxLength: 6 }),
  fc.object({ maxDepth: 2 }),
);

const arbFetchSpec: fc.Arbitrary<FetchSpec> = fc.oneof(
  arbTransportError.map<FetchSpec>((error) => ({ type: "transport-throw", error })),
  arbNonOkStatus.map<FetchSpec>((status) => ({ type: "non-ok", status })),
  arbJsonBody.map<FetchSpec>((body) => ({ type: "ok-json", body })),
  fc.constant<FetchSpec>({ type: "ok-invalid-json" }),
  fc.constant<FetchSpec>({ type: "ok-valid-catalog" }),
);

/**
 * Build a fresh `fetchImpl` double for a spec. It ignores the URL/init (the
 * Together adapter may call it twice for its native + fallback paths) and
 * renders the same outcome for every call, so the spec fully determines the run.
 */
function buildFetch(spec: FetchSpec): typeof fetch {
  return (async () => {
    switch (spec.type) {
      case "transport-throw":
        throw spec.error;
      case "non-ok":
        return new Response("error body", { status: spec.status });
      case "ok-json":
        return new Response(JSON.stringify(spec.body ?? null), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      case "ok-invalid-json":
        return new Response("<<< not json >>>", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      case "ok-valid-catalog":
        return new Response(
          JSON.stringify({ object: "list", data: [{ id: "model-a" }, { id: "model-b" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
    }
  }) as unknown as typeof fetch;
}

/** Build a coordinate-complete record for `kind` so the run reaches the transport. */
function buildRecord(kind: ProviderKind): ProviderConfigRecord {
  const base: ProviderConfigRecord = {
    id: `${kind}:prop11`,
    kind,
    label: `label-${kind}`,
    secretRef: `secret:${kind}`,
    createdAt: TS,
    updatedAt: TS,
  };
  switch (kind) {
    case "together":
      return { ...base, baseUrl: "https://api.together.test" };
    case "cloudflare":
      return { ...base, cloudflare: { accountId: "acct-prop11" } };
    case "azure-openai":
      // No enumerate-deployments sentinel header: this is a plain catalog read.
      return { ...base, azure: { endpoint: "https://prop11.openai.azure.test" } };
    case "openai-compatible":
      // No Manual_Model_List, so an unusable endpoint must classify (not fall back).
      return { ...base, baseUrl: "https://proxy.prop11.test" };
  }
}

/** The four adapters under test, paired with a coordinate-complete record. */
const ADAPTERS: { adapter: DiscoveryAdapter; kind: ProviderKind }[] = [
  { adapter: togetherDiscoveryAdapter, kind: "together" },
  { adapter: cloudflareDiscoveryAdapter, kind: "cloudflare" },
  { adapter: azureDiscoveryAdapter, kind: "azure-openai" },
  { adapter: openaiCompatibleDiscoveryAdapter, kind: "openai-compatible" },
];

function ctx(kind: ProviderKind, spec: FetchSpec): AdapterContext {
  return {
    record: buildRecord(kind),
    secret: SECRET,
    fetchImpl: buildFetch(spec),
    includeDeprecated: false,
  };
}

describe("Feature: cloud-capable-transition, Property 11: Adapters never throw and always classify failures", () => {
  // Validates: Requirements 2.12
  it("never throws and returns a classified DiscoveryError (or schema-valid candidates) for any hostile transport, across all four adapters", async () => {
    await fc.assert(
      fc.asyncProperty(arbFetchSpec, async (spec) => {
        for (const { adapter, kind } of ADAPTERS) {
          // 1) The adapter must never throw — a rejection here fails the property
          //    with the offending (kind, spec) as the counterexample.
          let result;
          try {
            result = await adapter.discover(ctx(kind, spec));
          } catch (error) {
            throw new Error(
              `${kind} adapter threw instead of classifying (spec=${spec.type}): ${String(error)}`,
            );
          }

          // 2) The result must be a well-formed AdapterResult.
          expect(typeof result.ok).toBe("boolean");

          if (result.ok) {
            // A success carries only schema-valid candidates.
            expect(Array.isArray(result.candidates)).toBe(true);
            for (const candidate of result.candidates) {
              expect(ModelCandidateSchema.safeParse(candidate).success).toBe(true);
            }
          } else {
            // 3) A failure is a classified, redacted DiscoveryError: the shape
            //    parses, the category is from the closed set, and no credential
            //    value leaks into the message (Requirement 2.12 / 2.13).
            expect(DiscoveryErrorSchema.safeParse(result.error).success).toBe(true);
            expect(VALID_CATEGORIES.has(result.error.category)).toBe(true);
            expect(result.error.message.length).toBeGreaterThan(0);
            expect(result.error.message).not.toContain(SECRET);
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});
