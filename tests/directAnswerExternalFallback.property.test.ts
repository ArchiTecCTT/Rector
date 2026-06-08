/**
 * Task 4.3 — Direct-answer external-fallback property test (ORN-58).
 *
 * **Feature: byok-chat-ux-and-model-discovery, Property 6: Direct-answer external failures fall back to deterministic local text**
 * **Validates: Requirements 7.3, 8.1, 8.2**
 *
 * For any `DIRECT_ANSWER` input in External_Mode where the `Budget_Gate` denies the
 * call (Req 7.3), the provider errors (Req 8.1), or no Provider is configured for the
 * role (Req 8.2), `runLiveDirectAnswer` SHALL:
 *   - return exactly the deterministic Local_Mode `buildDeterministicDirectAnswer`
 *     text as its `response`,
 *   - report `providerCalls === 0` for that step,
 *   - tag the matching `fallback` reason and omit any `cost`, and
 *   - never leak the raw provider error body or a configured secret into the result.
 *
 * The input is built bottom-up from an arbitrary planner input so every dependent
 * field (plan, skeptic review, crucible decision) stays internally consistent; the
 * triage route is pinned to `DIRECT_ANSWER` to match the property's quantifier. The
 * failure scenario (missing provider / budget denial / provider error) is generated
 * alongside it. Everything is in-memory and mock-only: the provider is a
 * `SpyLLMProvider` scripted with a clean answer (denial case) or an error (error
 * case), so no API key and zero real provider/network calls occur. The denial case
 * scripts a clean answer specifically so the only way the provider stays un-invoked
 * is the budget preflight denying the call before it is sent.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { createFakePlan } from "../src/orchestration/planner";
import { reviewPlanWithSkeptic } from "../src/orchestration/skeptic";
import { arbitratePlanWithCrucible } from "../src/orchestration/crucible";
import {
  buildDeterministicDirectAnswer,
  type BrainstemSynthesisInput,
} from "../src/orchestration/synthesizer";
import {
  runLiveDirectAnswer,
  type LiveDirectAnswerDeps,
  type LiveDirectAnswerFallback,
} from "../src/orchestration/liveDirectAnswer";
import { TRIAGE_ROUTES, type TriageResult } from "../src/orchestration/triage";
import {
  DEFAULT_SPY_USAGE,
  SpyLLMProvider,
  arbKeyLikeSecret,
  arbPlannerInput,
  arbSubThresholdBudget,
  generousBudget,
  makeExternalRun,
} from "./support/byokArbitraries";
import type { Budget } from "../src/store/schemas";

const FIXED_TIMESTAMP = "2026-01-01T00:00:00.000Z";

/**
 * Arbitrary, internally-consistent `BrainstemSynthesisInput` whose triage route is
 * pinned to `DIRECT_ANSWER`. Built from an arbitrary planner input (plan from
 * `createFakePlan`, review from `reviewPlanWithSkeptic`, decision from
 * `arbitratePlanWithCrucible`); only the triage route is overridden so the input
 * matches Property 6's quantifier while every other field stays valid.
 */
const arbDirectAnswerInput = (): fc.Arbitrary<BrainstemSynthesisInput> =>
  arbPlannerInput().map((plannerInput) => {
    const plannerOutput = createFakePlan(plannerInput);
    const skepticReview = reviewPlanWithSkeptic(plannerOutput, plannerInput.contextPack);
    const crucibleDecision = arbitratePlanWithCrucible({
      plannerOutput,
      skepticReview,
      now: () => FIXED_TIMESTAMP,
    });
    const triage: TriageResult = { ...plannerInput.triage, route: TRIAGE_ROUTES.DIRECT_ANSWER };

    return {
      traceId: "trace-direct-answer-fallback",
      triage,
      contextPack: plannerInput.contextPack,
      plannerOutput,
      skepticReview,
      crucibleDecision,
    };
  });

/**
 * One of the three External_Mode failure modes the property quantifies over, paired
 * with the `fallback` reason it must produce and the secret/sentinel a provider error
 * carries so the test can assert no raw body or secret survives:
 *   - `no_provider`    — no Provider configured for the role (Req 8.2),
 *   - `denied`         — the Budget_Gate denies the call before it is sent (Req 7.3),
 *   - `provider_error` — the provider invocation throws (Req 8.1).
 */
type FailureScenario =
  | { kind: "no_provider" }
  | { kind: "denied"; budget: Budget }
  | { kind: "provider_error"; secret: string; sentinel: string };

const arbFailureScenario = (): fc.Arbitrary<FailureScenario> =>
  fc.oneof(
    fc.constant<FailureScenario>({ kind: "no_provider" }),
    arbSubThresholdBudget().map<FailureScenario>((budget) => ({ kind: "denied", budget })),
    fc
      .tuple(arbKeyLikeSecret(), fc.string({ minLength: 1, maxLength: 60 }))
      .map<FailureScenario>(([secret, noise]) => ({
        kind: "provider_error",
        secret,
        // A distinctive sentinel guarantees we are searching for a substring that genuinely
        // appears in the raw provider error body, so a leak would be detectable.
        sentinel: `RAW_PROVIDER_BODY_${noise.replace(/\s+/gu, "_")}`,
      }))
  );

interface PreparedScenario {
  deps: LiveDirectAnswerDeps;
  provider?: SpyLLMProvider;
  expectedFallback: LiveDirectAnswerFallback;
  /** Substrings that must never appear in the serialized result. */
  forbidden: string[];
}

/** Materializes a {@link FailureScenario} into the deps `runLiveDirectAnswer` receives. */
function prepareScenario(scenario: FailureScenario): PreparedScenario {
  switch (scenario.kind) {
    case "no_provider":
      // Req 8.2: no Provider configured for the role -> deterministic fallback, zero calls.
      return {
        deps: { provider: undefined, run: makeExternalRun(generousBudget()) },
        expectedFallback: "no_provider",
        forbidden: [],
      };
    case "denied": {
      // Req 7.3: a clean answer is scripted so ANY call would succeed; the only way the
      // provider stays un-invoked is the preflight denying the call against the sub-threshold
      // budget before it is sent.
      const provider = new SpyLLMProvider({ estimate: DEFAULT_SPY_USAGE, responses: ["A direct answer."] });
      return {
        deps: { provider, run: makeExternalRun(scenario.budget) },
        provider,
        expectedFallback: "denied",
        forbidden: [],
      };
    }
    case "provider_error": {
      // Req 8.1: the provider invocation throws; the raw body must never reach the result.
      const errorBody = `${scenario.sentinel} Authorization: Bearer ${scenario.secret}`;
      const provider = new SpyLLMProvider({
        estimate: DEFAULT_SPY_USAGE,
        responses: [{ error: new Error(errorBody) }],
      });
      return {
        deps: { provider, run: makeExternalRun(generousBudget()) },
        provider,
        expectedFallback: "provider_error",
        forbidden: [scenario.sentinel, scenario.secret],
      };
    }
  }
}

describe("Feature: byok-chat-ux-and-model-discovery, Property 6: Direct-answer external failures fall back to deterministic local text", () => {
  // Validates: Requirements 7.3, 8.1, 8.2
  it("returns the deterministic local text with providerCalls === 0 on every external failure", async () => {
    await fc.assert(
      fc.asyncProperty(arbDirectAnswerInput(), arbFailureScenario(), async (input, scenario) => {
        const prepared = prepareScenario(scenario);

        const result = await runLiveDirectAnswer(input, prepared.deps);

        // Req 7.3 / 8.1 / 8.2: the deterministic Local_Mode direct-answer text is returned.
        expect(result.response).toBe(buildDeterministicDirectAnswer(input));
        // Req 7.3 / 8.1 / 8.2: the step reports zero provider calls.
        expect(result.providerCalls).toBe(0);
        // The fallback reason matches the failure mode and no cost is surfaced.
        expect(result.fallback).toBe(prepared.expectedFallback);
        expect(result.cost).toBeUndefined();

        // A denial gates the call BEFORE it is sent; a missing/error provider makes at most
        // the single attempt that fails — never a successful, counted call.
        if (prepared.expectedFallback === "denied") {
          expect(prepared.provider?.invokeCount).toBe(0);
        }

        // Req 8.1: the raw provider error body and any configured secret never leak.
        const serialized = JSON.stringify(result);
        for (const forbidden of prepared.forbidden) {
          expect(serialized).not.toContain(forbidden);
        }
      }),
      { numRuns: 200 }
    );
  });
});
