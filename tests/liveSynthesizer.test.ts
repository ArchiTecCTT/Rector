/**
 * Live synthesizer property tests (ORN-36).
 *
 * Property 8: Budget denial precedes the network call (synthesizer).
 *
 * Validates Requirements 6.2 and 6.4. The control plane runs Budget_Preflight
 * BEFORE any provider invocation, so when the budget cannot afford a positive
 * estimate the live synthesizer must short-circuit deterministically:
 *   - Req 6.2: the provider is invoked only after preflight returns an allow
 *     decision; a deny decision means the call never happens;
 *   - Req 6.4: the result sets status `fallback`, returns the deterministic
 *     `synthesizeChatBrainstemResponse` result, and reports a provider cost of
 *     0 USD for that step (no call => no spend), with zero provider calls made.
 *
 * The spy provider is scripted with a perfectly valid synthesis draft on
 * purpose: if the preflight gate ever leaked and the provider were invoked, the
 * call would succeed and `invokeCount` would rise above 0 — so `invokeCount === 0`
 * is a meaningful guard that the denial truly precedes the network call rather
 * than an accident of a failing provider. Everything is in-memory and mock-only:
 * no API key and no network are used.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { createFakePlan } from "../src/orchestration/planner";
import { reviewPlanWithSkeptic } from "../src/orchestration/skeptic";
import { arbitratePlanWithCrucible } from "../src/orchestration/crucible";
import {
  runLiveSynthesizer,
  synthesizeChatBrainstemResponse,
  type BrainstemSynthesisInput,
} from "../src/orchestration/synthesizer";
import {
  DEFAULT_SPY_USAGE,
  SpyLLMProvider,
  arbPlannerInput,
  arbSubThresholdBudget,
  arbValidSynthesisDraft,
  makeExternalRun,
  synthesisDraftToJson,
} from "./support/byokArbitraries";

const FIXED_TIMESTAMP = "2026-01-01T00:00:00.000Z";

/**
 * Arbitrary, fully-grounded `BrainstemSynthesisInput`. Built bottom-up from an
 * arbitrary planner input so every dependent field is internally consistent:
 *   - `plannerOutput` from `createFakePlan` (held to the fake planner's bar),
 *   - `skepticReview` from the deterministic `reviewPlanWithSkeptic`,
 *   - `crucibleDecision` from `arbitratePlanWithCrucible` over that review.
 *
 * No execution or validation evidence is attached, which is irrelevant to the
 * budget-preflight property: a denied budget must fall back before any provider
 * call regardless of the run's evidence.
 */
const arbSynthesisInput = (): fc.Arbitrary<BrainstemSynthesisInput> =>
  arbPlannerInput().map((plannerInput) => {
    const plannerOutput = createFakePlan(plannerInput);
    const skepticReview = reviewPlanWithSkeptic(plannerOutput, plannerInput.contextPack);
    const crucibleDecision = arbitratePlanWithCrucible({
      plannerOutput,
      skepticReview,
      now: () => FIXED_TIMESTAMP,
    });

    return {
      traceId: "trace-byok-synth",
      triage: plannerInput.triage,
      contextPack: plannerInput.contextPack,
      plannerOutput,
      skepticReview,
      crucibleDecision,
    };
  });

describe("Property 8: budget denial precedes the network call (synthesizer)", () => {
  // Validates: Requirements 6.2, 6.4.
  it("falls back to the deterministic synthesis with 0 USD cost and zero provider invocations for any sub-threshold budget", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbSynthesisInput(),
        arbSubThresholdBudget(),
        arbValidSynthesisDraft(),
        async (input, budget, draft) => {
          // A valid draft is scripted so that ANY provider call would succeed.
          // The only way `invokeCount` stays 0 is the preflight denying the call
          // before it is made (Req 6.2).
          const provider = new SpyLLMProvider({
            estimate: DEFAULT_SPY_USAGE,
            responses: [synthesisDraftToJson(draft)],
          });
          const run = makeExternalRun(budget);

          // Must resolve, never throw, on a denied budget.
          const result = await runLiveSynthesizer(input, { provider, run });

          // Req 6.4: a denied budget yields the deterministic fallback.
          expect(result.status).toBe("fallback");

          // Req 6.4: the returned synthesis is exactly the deterministic
          // `synthesizeChatBrainstemResponse` result.
          expect(result.synthesis).toEqual(synthesizeChatBrainstemResponse(input));
          expect(result.citations).toEqual([]);

          // Req 6.2: the provider was never invoked — denial precedes the call.
          expect(provider.invokeCount).toBe(0);
          expect(result.attempts).toBe(0);

          // Req 6.4: provider cost is 0 USD (no call => no spend), no model call
          // counted toward usage, and the deterministic answer reports 0 calls.
          expect(result.usage.estimatedUsd).toBe(0);
          expect(result.usage.modelCalls).toBe(0);
          expect(result.synthesis.providerCalls).toBe(0);
        }
      ),
      { numRuns: 200 }
    );
  });
});
