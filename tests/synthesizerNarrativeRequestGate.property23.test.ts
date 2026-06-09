/**
 * Feature: cloud-capable-transition, Property 23: A heavy route with a valid
 * flagship requests a Narrative_Answer.
 *
 * Validates: Requirements 7.1
 *
 * Req 7.1: WHILE Orchestrator_Mode is `external` AND the Active_Route_Map
 * designates a valid configured provider for the `flagship` role, WHEN a run
 * resolves to a Heavy_Developer_Route, THE Synthesizer SHALL request a
 * Narrative_Answer from the designated flagship model.
 *
 * This property fixes the two gate conditions that must be open — external mode
 * and a valid flagship provider — and ranges over every Heavy_Developer_Route
 * (RESEARCH, CODE_EDIT, PLAN_ONLY, LONG_RUNNING) together with arbitrary,
 * internally-consistent run state. Under those conditions
 * `synthesizeHeavyDeveloperRoute` must drive the live synthesizer, which is
 * directly observable as a provider invocation on the injected counting double:
 * a requested Narrative_Answer is exactly one `provider.invoke` call.
 *
 * Everything is in-memory and mock-only: the provider is a `SpyLLMProvider`
 * scripted with a valid synthesis draft, the run carries a generous budget so
 * the budget preflight never denies the call, and no API key or network is
 * used. The spy is scripted with a valid draft on purpose — if the gate ever
 * failed to open, `invokeCount` would stay at 0, so `invokeCount >= 1` is a
 * meaningful guard that the Narrative_Answer was genuinely requested.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { createFakePlan } from "../src/orchestration/planner";
import { reviewPlanWithSkeptic } from "../src/orchestration/skeptic";
import { arbitratePlanWithCrucible } from "../src/orchestration/crucible";
import { TRIAGE_ROUTES, type TriageResult } from "../src/orchestration/triage";
import {
  synthesizeHeavyDeveloperRoute,
  type BrainstemSynthesisInput,
} from "../src/orchestration/synthesizer";
import {
  DEFAULT_SPY_USAGE,
  SpyLLMProvider,
  arbPlannerInput,
  arbValidSynthesisDraft,
  generousBudget,
  makeExternalRun,
  synthesisDraftToJson,
} from "./support/byokArbitraries";

const FIXED_TIMESTAMP = "2026-01-01T00:00:00.000Z";

/** The Heavy_Developer_Routes that warrant a provider-generated Narrative_Answer (Req 7.1). */
const HEAVY_DEVELOPER_ROUTES = [
  TRIAGE_ROUTES.RESEARCH,
  TRIAGE_ROUTES.CODE_EDIT,
  TRIAGE_ROUTES.PLAN_ONLY,
  TRIAGE_ROUTES.LONG_RUNNING,
] as const;

/**
 * Arbitrary, internally-consistent `BrainstemSynthesisInput` whose triage route
 * is forced to one of the four Heavy_Developer_Routes. The plan, skeptic review,
 * and crucible decision are derived bottom-up from an arbitrary planner input so
 * every dependent field stays consistent; only the triage `route` is overridden
 * (kept schema-valid) to pin the heavy-route gate condition.
 */
const arbHeavyRouteInput = (): fc.Arbitrary<BrainstemSynthesisInput> =>
  fc
    .tuple(arbPlannerInput(), fc.constantFrom(...HEAVY_DEVELOPER_ROUTES))
    .map(([plannerInput, route]) => {
      const triage: TriageResult = { ...plannerInput.triage, route };
      const plannerOutput = createFakePlan(plannerInput);
      const skepticReview = reviewPlanWithSkeptic(plannerOutput, plannerInput.contextPack);
      const crucibleDecision = arbitratePlanWithCrucible({
        plannerOutput,
        skepticReview,
        now: () => FIXED_TIMESTAMP,
      });

      return {
        traceId: "trace-prop23",
        triage,
        contextPack: plannerInput.contextPack,
        plannerOutput,
        skepticReview,
        crucibleDecision,
      };
    });

describe("Feature: cloud-capable-transition, Property 23: a heavy route with a valid flagship requests a Narrative_Answer", () => {
  // Validates: Requirements 7.1.
  it("invokes the live synthesizer (requests a Narrative_Answer) for any Heavy_Developer_Route in external mode with a valid flagship", async () => {
    await fc.assert(
      fc.asyncProperty(arbHeavyRouteInput(), arbValidSynthesisDraft(), async (input, draft) => {
        // A valid draft is scripted (repeat-last) so any provider call succeeds:
        // the only way `invokeCount` stays 0 is the gate failing to open, which
        // would falsify the property.
        const provider = new SpyLLMProvider({
          estimate: DEFAULT_SPY_USAGE,
          responses: [synthesisDraftToJson(draft)],
          onOverflow: "repeat-last",
        });
        const run = makeExternalRun(generousBudget());

        const result = await synthesizeHeavyDeveloperRoute(input, {
          provider,
          run,
          // Both gate conditions open: external mode + a valid designated flagship.
          gate: { mode: "external", flagshipProviderIsValid: true },
        });

        // Req 7.1: a Narrative_Answer was requested from the flagship model — the
        // live synthesizer invoked the provider at least once.
        expect(provider.invokeCount).toBeGreaterThanOrEqual(1);
        expect(result.attempts).toBeGreaterThanOrEqual(1);
        // The gate was open, so the run did not short-circuit to the zero-call
        // deterministic fallback.
        expect(result.synthesis.providerCalls).toBeGreaterThanOrEqual(1);
      }),
      { numRuns: 200 }
    );
  });
});
