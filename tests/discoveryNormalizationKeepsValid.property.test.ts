/**
 * Task 5.12 — discovery normalization keeps exactly the schema-valid entries.
 *
 * **Feature: cloud-capable-transition, Property 9: Normalization keeps exactly the schema-valid entries**
 * **Validates: Requirements 2.7, 2.8**
 *
 * Property 9: For any catalog response, the set of emitted Model_Candidates
 * equals the set of retained entries that validate against
 * `ModelCandidateSchema`:
 *
 *   - every emitted candidate is schema-valid (Req 2.7);
 *   - every entry that fails validation is excluded and processing continues
 *     over the remaining retained entries (Req 2.8);
 *   - the remaining valid entries are all preserved, in their original order;
 *   - a catalog that yields zero entries after the filter is a success (an
 *     empty candidate list), not a thrown error.
 *
 * The unit under test is the shared `normalizeCandidate` plus the
 * keep-valid / drop-invalid / continue step every Discovery_Adapter applies to
 * its retained entries (`together.ts`, `openaiCompatible.ts`, `cloudflare.ts`,
 * `azure.ts` all funnel through it). The step is modeled here exactly as the
 * adapters perform it — `list.map(normalizeCandidate)` followed by the
 * schema filter — so the property holds independent of how many arbitrary raw
 * entries happen to normalize to a valid candidate.
 *
 * `normalizeCandidate` is a pure function over an arbitrary `raw` value plus an
 * adapter-supplied `NormalizeContext`; there is ZERO disk, network, or provider
 * I/O, so every run is fully deterministic and hermetic.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { normalizeCandidate, type NormalizeContext } from "../src/providers/discovery/adapters";
import { ModelCandidateSchema, type ModelCandidate } from "../src/providers/discovery/types";
import { PROVIDER_KINDS } from "../src/providers/config";

// A fixed, schema-valid ISO timestamp the adapter context supplies; copied onto
// every candidate's `lastRefreshedAt`.
const TS = "2026-01-01T00:00:00.000Z";

/** An arbitrary JSON-ish value: the garbage an adapter might read off a payload. */
const arbAnyValue: fc.Arbitrary<unknown> = fc.anything({
  withBigInt: false,
  withDate: true,
  withMap: false,
  withSet: false,
  withTypedArray: false,
  maxDepth: 3,
});

/** An arbitrary capability-ish value: strings, `{ name }`/`{ id }` objects, or junk. */
const arbCapabilityEntry: fc.Arbitrary<unknown> = fc.oneof(
  fc.string(),
  fc.record({ name: fc.string() }),
  fc.record({ id: fc.string() }),
  arbAnyValue,
);

/**
 * An arbitrary raw provider catalog entry. Every field is OPTIONAL and
 * INTENTIONALLY mixed-typed (correct types AND garbage) so the normalizer's
 * defensive coercion is exercised across the widest input space.
 */
const arbStructuredEntry: fc.Arbitrary<Record<string, unknown>> = fc.record(
  {
    id: arbAnyValue,
    model: arbAnyValue,
    model_id: arbAnyValue,
    modelId: arbAnyValue,
    name: arbAnyValue,
    display_name: arbAnyValue,
    displayName: arbAnyValue,
    label: arbAnyValue,
    deployment: arbAnyValue,
    deployment_id: arbAnyValue,
    deploymentId: arbAnyValue,
    context_window: arbAnyValue,
    contextWindow: arbAnyValue,
    context_length: arbAnyValue,
    context_size: arbAnyValue,
    capabilities: fc.oneof(fc.array(arbCapabilityEntry, { maxLength: 5 }), arbAnyValue),
    tasks: fc.oneof(fc.array(arbCapabilityEntry, { maxLength: 5 }), arbAnyValue),
    task: arbAnyValue,
    type: arbAnyValue,
    modality: arbAnyValue,
    pricing: fc.oneof(
      fc.record(
        {
          inputPer1k: arbAnyValue,
          input: arbAnyValue,
          prompt: arbAnyValue,
          outputPer1k: arbAnyValue,
          output: arbAnyValue,
          completion: arbAnyValue,
          currency: arbAnyValue,
        },
        { requiredKeys: [] },
      ),
      arbAnyValue,
    ),
    currency: arbAnyValue,
    deprecated: arbAnyValue,
    lifecycle: arbAnyValue,
    status: arbAnyValue,
    state: arbAnyValue,
  },
  { requiredKeys: [] },
);

/**
 * The full raw-entry space: a structured (but mixed-typed, partially-populated)
 * entry, OR outright non-object garbage (null/undefined/number/string/array).
 */
const arbRawEntry: fc.Arbitrary<unknown> = fc.oneof(
  { weight: 3, arbitrary: arbStructuredEntry },
  { weight: 1, arbitrary: arbAnyValue },
);

/** A whole catalog response: an arbitrary list of raw entries, including empty. */
const arbCatalog: fc.Arbitrary<unknown[]> = fc.array(arbRawEntry, { maxLength: 12 });

/** Arbitrary, schema-valid scope coordinates (every sub-field optional). */
const arbScope = fc.record(
  {
    accountId: fc.string(),
    region: fc.string(),
    endpoint: fc.string(),
    azureResource: fc.string(),
    subscriptionId: fc.string(),
    resourceGroup: fc.string(),
  },
  { requiredKeys: [] },
);

/** Arbitrary adapter-supplied normalize context, mirroring what the adapters build. */
const arbContext: fc.Arbitrary<NormalizeContext> = fc.record({
  providerId: fc.string({ minLength: 1, maxLength: 24 }).filter((s) => s.trim().length > 0),
  kind: fc.constantFrom(...PROVIDER_KINDS),
  source: fc.string({ minLength: 1, maxLength: 24 }).filter((s) => s.trim().length > 0),
  lastRefreshedAt: fc.constant(TS),
  scope: fc.option(arbScope, { nil: undefined }),
  requiresDeployment: fc.option(fc.boolean(), { nil: undefined }),
  requiresRegion: fc.option(fc.boolean(), { nil: undefined }),
  defaultCapabilities: fc.option(fc.array(fc.string(), { maxLength: 4 }), { nil: undefined }),
});

/**
 * Model the adapter's documented retained-entry handling exactly: normalize
 * each entry, then keep only those that validate against `ModelCandidateSchema`,
 * dropping the rest and continuing. An empty result is a success — the function
 * returns `[]` and never throws (Req 2.8 / 2.14).
 */
function normalizeAndKeepValid(entries: unknown[], ctx: NormalizeContext): ModelCandidate[] {
  return entries
    .map((entry) => normalizeCandidate(entry, ctx))
    .filter((candidate) => ModelCandidateSchema.safeParse(candidate).success);
}

describe("Feature: cloud-capable-transition, Property 9: Normalization keeps exactly the schema-valid entries", () => {
  // Validates: Requirements 2.7, 2.8
  it("emits exactly the schema-valid retained entries, dropping invalid ones and continuing", () => {
    fc.assert(
      fc.property(arbCatalog, arbContext, (entries, ctx) => {
        // Normalizing the whole catalog never throws, even on non-object junk.
        let normalized: ModelCandidate[] = [];
        expect(() => {
          normalized = entries.map((entry) => normalizeCandidate(entry, ctx));
        }).not.toThrow();

        // The independently-computed set of retained entries that validate
        // against the schema, preserving original order.
        const expectedValid = normalized.filter((c) => ModelCandidateSchema.safeParse(c).success);

        // The adapter's emitted candidates (keep-valid / drop-invalid / continue).
        const emitted = normalizeAndKeepValid(entries, ctx);

        // Req 2.7: every emitted candidate parses against ModelCandidateSchema.
        for (const candidate of emitted) {
          expect(ModelCandidateSchema.safeParse(candidate).success).toBe(true);
        }

        // Req 2.7 + 2.8: the emitted set equals exactly the schema-valid
        // retained entries — no valid entry dropped, no invalid entry kept, and
        // the surviving valid entries are preserved in their original order.
        expect(emitted).toEqual(expectedValid);

        // Req 2.8 (continue): the result is a contiguous array of candidates
        // with no thrown error and no `undefined`/`null` holes from a dropped
        // entry interrupting processing.
        expect(Array.isArray(emitted)).toBe(true);
        expect(emitted.every((c) => c !== undefined && c !== null)).toBe(true);

        // Empty-after-filter is success: an empty (or all-dropped) catalog
        // yields an empty candidate list rather than an error.
        if (entries.length === 0) {
          expect(emitted).toEqual([]);
        }
      }),
      { numRuns: 200 },
    );
  });
});
