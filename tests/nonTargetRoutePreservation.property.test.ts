/**
 * Task 2.5 — Non-target route preservation property test (ORN-57).
 *
 * **Feature: byok-chat-ux-and-model-discovery, Property 4: Non-target routes preserve legacy output**
 * **Validates: Requirements 27.3**
 *
 * For any `BrainstemSynthesisInput` whose triage route is neither
 * `NEEDS_CLARIFICATION` nor `DIRECT_ANSWER`, the synthesized `response` SHALL equal
 * the existing legacy `"Status: … Route: … Trace: … Evidence: …"` text byte-for-byte
 * (Req 27.3). The route-aware selector only changes the two target routes; every
 * other route must keep the pre-productization Local_Mode string untouched.
 *
 * The input is built bottom-up from an arbitrary planner input so every dependent
 * field (plan, skeptic review, crucible decision) stays internally consistent; the
 * triage route is then pinned to one of the four non-target routes to satisfy the
 * property's quantifier. An optional `observabilitySummary` is generated to exercise
 * both branches of the legacy `Observed:` segment. The expected legacy text is
 * reconstructed from the synthesizer's own public output fields (`status`, `route`,
 * `traceId`, `evidence`, `observability`) in the exact legacy format, so the
 * assertion is a true byte-for-byte regression check independent of the route-aware
 * code path. Everything is pure and in-memory: no API key and zero provider/network
 * calls occur.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { createFakePlan } from "../src/orchestration/planner";
import { reviewPlanWithSkeptic } from "../src/orchestration/skeptic";
import { arbitratePlanWithCrucible } from "../src/orchestration/crucible";
import {
  synthesizeChatBrainstemResponse,
  type BrainstemSynthesis,
  type BrainstemSynthesisInput,
} from "../src/orchestration/synthesizer";
import { TRIAGE_ROUTES, type TriageResult, type TriageRoute } from "../src/orchestration/triage";
import { ObservabilitySummarySchema, type ObservabilitySummary } from "../src/observability";
import { arbPlannerInput } from "./support/byokArbitraries";

const FIXED_TIMESTAMP = "2026-01-01T00:00:00.000Z";
const FIXED_TRACE_ID = "trace-non-target-route";

/**
 * Every triage route other than the two target routes the route-aware selector
 * rewrites (`NEEDS_CLARIFICATION`, `DIRECT_ANSWER`). These must all keep the legacy
 * status string byte-for-byte (Req 27.3).
 */
const NON_TARGET_ROUTES: TriageRoute[] = [
  TRIAGE_ROUTES.PLAN_ONLY,
  TRIAGE_ROUTES.CODE_EDIT,
  TRIAGE_ROUTES.RESEARCH,
  TRIAGE_ROUTES.LONG_RUNNING,
];

/**
 * Reconstructs the legacy `"Status: … Route: … Trace: … Evidence: …"` text in its
 * exact original format from the synthesizer's public output fields. The legacy
 * builder derives the string from precisely these values (`status`, `route`,
 * `traceId`, `evidence`, `observability`), so comparing the selected `response`
 * against this reconstruction is a byte-for-byte preservation check.
 */
function expectedLegacyResponse(result: BrainstemSynthesis): string {
  const observed = result.observability
    ? `Observed: ${result.observability.spanCount} spans, ${result.observability.durationMs}ms, provider calls: ${result.observability.modelCallCount}, provider cost: $${result.observability.estimatedCostUsd}.`
    : "Observed: pending.";
  return [
    `Status: ${result.status}.`,
    `Route: ${result.route}.`,
    `Trace: ${result.traceId}.`,
    `Evidence: ${result.evidence.join("; ")}.`,
    observed,
    "Local mode: provider calls: 0, API keys: not required.",
  ].join(" ");
}

/** Arbitrary, schema-valid `ObservabilitySummary` (or `undefined`) to cover both `Observed:` branches. */
const arbObservabilitySummary = (): fc.Arbitrary<ObservabilitySummary | undefined> =>
  fc.option(
    fc
      .record({
        spanCount: fc.integer({ min: 0, max: 12 }),
        durationMs: fc.integer({ min: 0, max: 60_000 }),
        modelCallCount: fc.integer({ min: 0, max: 8 }),
        estimatedCostUsd: fc.double({ min: 0, max: 5, noNaN: true }),
        status: fc.constantFrom("OK" as const, "ERROR" as const),
        providers: fc.array(fc.constantFrom("local", "openai", "together"), { maxLength: 3 }),
      })
      .map((partial) =>
        ObservabilitySummarySchema.parse({
          traceId: FIXED_TRACE_ID,
          spans: [],
          ...partial,
        })
      ),
    { nil: undefined }
  );

/**
 * Arbitrary, internally-consistent `BrainstemSynthesisInput` whose triage route is a
 * non-target route. Built from an arbitrary planner input (plan from
 * `createFakePlan`, review from `reviewPlanWithSkeptic`, decision from
 * `arbitratePlanWithCrucible`); only the triage route is overridden so the input
 * matches Property 4's quantifier while every other field stays valid.
 */
const arbNonTargetRouteInput = (): fc.Arbitrary<BrainstemSynthesisInput> =>
  fc
    .tuple(arbPlannerInput(), fc.constantFrom(...NON_TARGET_ROUTES), arbObservabilitySummary())
    .map(([plannerInput, route, observabilitySummary]) => {
      const plannerOutput = createFakePlan(plannerInput);
      const skepticReview = reviewPlanWithSkeptic(plannerOutput, plannerInput.contextPack);
      const crucibleDecision = arbitratePlanWithCrucible({
        plannerOutput,
        skepticReview,
        now: () => FIXED_TIMESTAMP,
      });
      const triage: TriageResult = { ...plannerInput.triage, route };

      return {
        traceId: FIXED_TRACE_ID,
        triage,
        contextPack: plannerInput.contextPack,
        plannerOutput,
        skepticReview,
        crucibleDecision,
        observabilitySummary,
      };
    });

describe("Feature: byok-chat-ux-and-model-discovery, Property 4: Non-target routes preserve legacy output", () => {
  // Validates: Requirements 27.3
  it("emits the legacy status string byte-for-byte for any non-target route", () => {
    fc.assert(
      fc.property(arbNonTargetRouteInput(), (input) => {
        const result = synthesizeChatBrainstemResponse(input);

        // Sanity: the generated route is genuinely outside the two rewritten target routes.
        expect(result.route).not.toBe(TRIAGE_ROUTES.NEEDS_CLARIFICATION);
        expect(result.route).not.toBe(TRIAGE_ROUTES.DIRECT_ANSWER);

        // Req 27.3: the response equals the legacy status string byte-for-byte.
        expect(result.response).toBe(expectedLegacyResponse(result));

        // Provider-free Local_Mode invariant carried by the legacy string.
        expect(result.providerCalls).toBe(0);
      }),
      { numRuns: 200 }
    );
  });
});
