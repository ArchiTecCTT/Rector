/**
 * Task 12.2 — Model_Picker rendered-candidate-detail property test.
 *
 * **Feature: byok-chat-ux-and-model-discovery, Property 16: Rendered candidates include their present detail**
 * **Validates: Requirements 20.1, 20.2, 20.3, 20.4**
 *
 * Property 16: *For any* `Model_Candidate`, the DOM element produced by the pure
 * `buildCandidateElement` helper in `src/public/app.js` SHALL include the candidate's
 * present detail:
 *   - every capability tag the candidate carries (Req 20.1);
 *   - the lifecycle status when present, with an explicit deprecated indicator
 *     when the lifecycle is `deprecated` (Req 20.2);
 *   - the context window and/or pricing when present (Req 20.3);
 *   - the region/deployment note when the candidate requires one (Req 20.4).
 *
 * `app.js` is a plain browser script with no module exports, so `buildCandidateElement`
 * (and the helper `formatCandidatePricing` it composes) is reached through the same
 * `vm` sandbox harness the Provider_Config_UI DOM tests use. The harness is built once
 * and the pure render helper is exercised across every generated candidate. No network,
 * no provider calls.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { PROVIDER_KINDS, type ProviderKind } from "../src/providers/config";
import { ModelCandidateSchema, type ModelCandidate } from "../src/providers/discovery/types";
import { createProviderPanelHarness } from "./support/providerPanelHarness";

// Build the sandbox once; `buildCandidateElement` is pure so it is safe to reuse the
// same loaded script across every property run.
const harness = createProviderPanelHarness();
const buildCandidateElement = harness.sandbox.buildCandidateElement as (candidate: unknown) => Element;
const formatCandidatePricing = harness.sandbox.formatCandidatePricing as (pricing: unknown) => string;

const ISO = "2026-01-01T00:00:00.000Z";

/** A non-empty string that may contain HTML-significant characters to exercise escaping. */
const arbNonEmpty: fc.Arbitrary<string> = fc.string({ minLength: 1, maxLength: 20 });

const arbKind: fc.Arbitrary<ProviderKind> = fc.constantFrom(...PROVIDER_KINDS);

/** Lifecycle: a well-known value, an arbitrary provider string, or absent. */
const arbLifecycle: fc.Arbitrary<string | undefined> = fc.option(
  fc.oneof(fc.constantFrom("active", "preview", "deprecated"), arbNonEmpty),
  { nil: undefined },
);

const arbPricing: fc.Arbitrary<ModelCandidate["pricing"]> = fc.option(
  fc.record(
    {
      inputPer1k: fc.option(fc.float({ min: 0, max: 1000, noNaN: true }), { nil: undefined }),
      outputPer1k: fc.option(fc.float({ min: 0, max: 1000, noNaN: true }), { nil: undefined }),
      currency: fc.option(fc.constantFrom("USD", "EUR", "GBP"), { nil: undefined }),
    },
    { requiredKeys: [] },
  ),
  { nil: undefined },
);

const arbCandidate: fc.Arbitrary<ModelCandidate> = fc
  .record({
    providerId: arbNonEmpty,
    kind: arbKind,
    region: fc.option(arbNonEmpty, { nil: undefined }),
    displayName: arbNonEmpty,
    capabilities: fc.array(arbNonEmpty, { minLength: 0, maxLength: 5 }),
    requiresDeployment: fc.boolean(),
    requiresRegion: fc.boolean(),
    source: arbNonEmpty,
    modelId: fc.option(arbNonEmpty, { nil: undefined }),
    contextWindow: fc.option(fc.integer({ min: 1, max: 2_000_000 }), { nil: undefined }),
    pricing: arbPricing,
    lifecycle: arbLifecycle,
  })
  .map((raw) => {
    const candidate: ModelCandidate = {
      providerId: raw.providerId,
      kind: raw.kind,
      scope: raw.region === undefined ? {} : { region: raw.region },
      displayName: raw.displayName,
      capabilities: raw.capabilities,
      requiresDeployment: raw.requiresDeployment,
      requiresRegion: raw.requiresRegion,
      source: raw.source,
      lastRefreshedAt: ISO,
      ...(raw.modelId === undefined ? {} : { modelId: raw.modelId }),
      ...(raw.contextWindow === undefined ? {} : { contextWindow: raw.contextWindow }),
      ...(raw.pricing === undefined ? {} : { pricing: raw.pricing }),
      ...(raw.lifecycle === undefined ? {} : { lifecycle: raw.lifecycle }),
    };
    return candidate;
  });

describe("Feature: byok-chat-ux-and-model-discovery, Property 16: Rendered candidates include their present detail", () => {
  // Validates: Requirements 20.1, 20.2, 20.3, 20.4
  it("renders every present capability, lifecycle, context/pricing, and region/deployment detail", () => {
    fc.assert(
      fc.property(arbCandidate, (candidate) => {
        // The generator stays within the Model_Candidate input space.
        expect(ModelCandidateSchema.safeParse(candidate).success).toBe(true);

        const el = buildCandidateElement(candidate);

        // Req 20.1: every capability tag the candidate carries is rendered.
        const capSpans = el.querySelectorAll(".model-candidate__cap");
        const capTexts = Array.from(capSpans).map((s) => s.textContent ?? "");
        for (const tag of candidate.capabilities) {
          expect(capTexts).toContain(tag);
        }

        // Req 20.2: lifecycle status is shown when present, with a deprecated
        // indicator (is-deprecated marker + ⚠ glyph) when the lifecycle is
        // `deprecated`.
        if (candidate.lifecycle != null && String(candidate.lifecycle).length > 0) {
          const life = String(candidate.lifecycle);
          const lifeSpan = el.querySelector(".model-candidate__lifecycle");
          expect(lifeSpan).not.toBeNull();
          expect(lifeSpan!.getAttribute("data-lifecycle")).toBe(life);
          if (life === "deprecated") {
            expect(lifeSpan!.classList.contains("is-deprecated")).toBe(true);
            expect(lifeSpan!.textContent).toContain(`⚠ ${life}`);
          } else {
            expect(lifeSpan!.textContent).toBe(life);
          }
        }

        // Req 20.3: context window and/or pricing are shown when present.
        const metaDiv = el.querySelector(".model-candidate__meta");
        if (typeof candidate.contextWindow === "number" && candidate.contextWindow > 0) {
          expect(metaDiv).not.toBeNull();
          expect(metaDiv!.textContent).toContain(`Context: ${String(candidate.contextWindow)} tokens`);
        }
        const pricing = formatCandidatePricing(candidate.pricing);
        if (pricing) {
          expect(metaDiv).not.toBeNull();
          expect(metaDiv!.textContent).toContain(`Pricing: ${pricing}`);
        }

        // Req 20.4: region/deployment note is shown when the candidate requires one.
        const notes: string[] = [];
        if (candidate.requiresDeployment === true) notes.push("Requires a deployment name");
        if (candidate.requiresRegion === true) {
          const region = candidate.scope && candidate.scope.region ? ` (${String(candidate.scope.region)})` : "";
          notes.push(`Requires a region${region}`);
        }
        if (notes.length) {
          const noteDiv = el.querySelector(".model-candidate__note");
          expect(noteDiv).not.toBeNull();
          expect(noteDiv!.textContent).toBe(notes.join("; "));
        }
      }),
      { numRuns: 200 },
    );
  });
});
