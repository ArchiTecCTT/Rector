/**
 * Task 7.6 — candidate normalization property test.
 *
 * **Feature: byok-chat-ux-and-model-discovery, Property 9: Every adapter entry normalizes to a valid Model_Candidate**
 * **Validates: Requirements 10.4, 11.1, 11.2, 11.3, 11.4, 11.5, 14.2**
 *
 * Property 9: For any raw provider model list — including entries with
 * arbitrary missing optional fields, wrong-typed fields, or outright garbage
 * (null, numbers, strings, arrays, nested objects) — every normalized entry
 * SHALL parse successfully against `ModelCandidateSchema` with all required
 * fields present, and {@link normalizeCandidate} SHALL NOT throw (Req 14.2).
 *
 * This is the exhaustive cross-input guarantee. The targeted examples and edge
 * cases (fully-populated mapping, optional-field omission, capability merging,
 * deprecated lifecycle) live in `discoveryNormalizer.test.ts` (task 7.1); this
 * test does NOT re-assert those specific mappings — it generates the widest
 * possible raw-entry space and asserts only the universal invariants the
 * normalizer must hold for every adapter.
 *
 * The normalizer is a pure function over an arbitrary `raw` value plus an
 * adapter-supplied {@link NormalizeContext}; there is ZERO disk, network, or
 * provider I/O, so every run is fully deterministic and hermetic.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { normalizeCandidate, type NormalizeContext } from "../src/providers/discovery/adapters";
import { ModelCandidateSchema } from "../src/providers/discovery/types";
import { PROVIDER_KINDS } from "../src/providers/config";

// A fixed, schema-valid ISO timestamp for the adapter-supplied context. The
// normalizer copies it onto every candidate's `lastRefreshedAt`, so it must be
// a valid `z.string().datetime()` for the required-field contract to hold.
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
 * An arbitrary raw provider entry. Each field is OPTIONAL (so any combination
 * of missing fields is exercised — Req 11.3) and INTENTIONALLY mixed-typed:
 * the "expected" string/number fields draw from correct types AND garbage so
 * the normalizer's defensive coercion is fully covered (Req 14.2, 11.4, 11.5).
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
 * Covers "not an object at all" inputs the normalizer must still survive.
 */
const arbRawEntry: fc.Arbitrary<unknown> = fc.oneof(
  { weight: 3, arbitrary: arbStructuredEntry },
  { weight: 1, arbitrary: arbAnyValue },
);

/** Arbitrary, schema-valid scope coordinates (every sub-field optional — Req 11.2). */
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

/**
 * Arbitrary adapter-supplied context. `providerId`/`source` are non-empty (the
 * normalizer requires them for the required-field contract); `kind` is a real
 * provider kind; the rest is the optional adapter context, including
 * `defaultCapabilities` fallbacks (Req 11.5).
 */
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

describe("Feature: byok-chat-ux-and-model-discovery, Property 9: Every adapter entry normalizes to a valid Model_Candidate", () => {
  // Validates: Requirements 10.4, 11.1, 11.2, 11.3, 11.4, 11.5, 14.2
  it("normalizes any raw entry to a schema-valid Model_Candidate without throwing", () => {
    fc.assert(
      fc.property(arbRawEntry, arbContext, (raw, ctx) => {
        // Req 14.2: normalization is defensive and never throws on a malformed
        // or non-object raw value.
        let candidate;
        expect(() => {
          candidate = normalizeCandidate(raw, ctx);
        }).not.toThrow();

        // Req 10.4 / 11.1: every result parses against the canonical schema with
        // all required fields present.
        const parsed = ModelCandidateSchema.safeParse(candidate);
        expect(parsed.success).toBe(true);
        if (!parsed.success) return;

        const value = parsed.data;
        // Required fields are always present and well-typed (Req 11.1).
        expect(value.providerId).toBe(ctx.providerId);
        expect(value.kind).toBe(ctx.kind);
        expect(value.source).toBe(ctx.source);
        expect(value.lastRefreshedAt).toBe(TS);
        expect(value.displayName.length).toBeGreaterThan(0);
        expect(typeof value.requiresDeployment).toBe("boolean");
        expect(typeof value.requiresRegion).toBe("boolean");

        // Capabilities are always a (possibly empty) array of non-empty,
        // de-duplicated strings (Req 11.5).
        expect(Array.isArray(value.capabilities)).toBe(true);
        for (const tag of value.capabilities) {
          expect(typeof tag).toBe("string");
          expect(tag.length).toBeGreaterThan(0);
        }
        expect(new Set(value.capabilities).size).toBe(value.capabilities.length);
      }),
      { numRuns: 300 },
    );
  });

  // Validates: Requirements 11.3
  it("emits each optional field only when a well-typed value is present, never empty or malformed", () => {
    fc.assert(
      fc.property(arbRawEntry, arbContext, (raw, ctx) => {
        const value = normalizeCandidate(raw, ctx);

        // Optional fields, when present, satisfy their own sub-contract; when
        // absent the key is omitted rather than emitted as null/empty (Req 11.3).
        if ("modelId" in value) {
          expect(typeof value.modelId).toBe("string");
        }
        if ("deploymentId" in value) {
          expect(typeof value.deploymentId).toBe("string");
        }
        if ("contextWindow" in value) {
          expect(Number.isInteger(value.contextWindow)).toBe(true);
          expect(value.contextWindow as number).toBeGreaterThan(0);
        }
        if ("lifecycle" in value) {
          expect(typeof value.lifecycle).toBe("string");
          expect((value.lifecycle as string).length).toBeGreaterThan(0);
        }
        if ("pricing" in value && value.pricing !== undefined) {
          // Pricing is only present when at least one usable sub-field exists.
          const { inputPer1k, outputPer1k, currency } = value.pricing;
          expect(inputPer1k !== undefined || outputPer1k !== undefined || currency !== undefined).toBe(true);
          if (inputPer1k !== undefined) expect(Number.isFinite(inputPer1k)).toBe(true);
          if (outputPer1k !== undefined) expect(Number.isFinite(outputPer1k)).toBe(true);
          if (currency !== undefined) expect(typeof currency).toBe("string");
        }
      }),
      { numRuns: 300 },
    );
  });
});
