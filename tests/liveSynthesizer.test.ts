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

import { createFakePlan, PlannerInputSchema } from "../src/orchestration/planner";
import { reviewPlanWithSkeptic } from "../src/orchestration/skeptic";
import { arbitratePlanWithCrucible } from "../src/orchestration/crucible";
import { triageUserMessage } from "../src/orchestration/triage";
import {
  runLiveSynthesizer,
  synthesizeChatBrainstemResponse,
  type BrainstemSynthesisInput,
} from "../src/orchestration/synthesizer";
import type { HealingLoopResult } from "../src/orchestration/validationHealing";
import {
  DEFAULT_SPY_USAGE,
  SpyLLMProvider,
  arbCitationFreeSynthesisDraft,
  arbFailingDag,
  arbMalformedSynthesisJson,
  arbPlannerInput,
  arbSubThresholdBudget,
  arbValidSynthesisDraft,
  embedSecret,
  generousBudget,
  makeContextPack,
  makeExternalRun,
  synthesisDraftToJson,
  type SynthesisDraft,
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

// ===========================================================================
// Unit tests for runLiveSynthesizer (task 6.4)
// ===========================================================================
//
// Example-based coverage that complements the budget-preflight property above:
//   - valid first try with citations (Req 2.1/2.2),
//   - a citation-free answer rejected -> repair -> recovery, and
//     citation-free -> repair -> fallback (Req 2.3),
//   - fallback on a provider error and on post-repair non-conformance (Req 2.5),
//   - redaction of the input before prompt construction and of the assembled
//     response/citations before returning (Req 2.6/2.7),
//   - failed validation output preserved in the returned answer (Req 2.8).
//
// Everything is in-memory and mock-only: the provider is a `SpyLLMProvider`
// scripted with content or errors, and no API key or network is used.

/** A fixed, redactable key-like secret used to assert the secret never leaks. */
const UNIT_SECRET = "sk-UNITTESTSECRET0123456789ABCDEFGH";

/** A unique marker embedded in a failure message to prove it is preserved. */
const FAILURE_MARKER = "UNIQUE_FAILURE_MARKER_7F3A";

/**
 * A deterministic failing execution result (>=1 node result) used to ground the
 * inputs that carry execution/validation evidence. Sampled once with a fixed
 * seed so the fixture is stable across runs.
 */
const FAILING_SAMPLE = fc.sample(arbFailingDag(), { numRuns: 1, seed: 4242 })[0];

/**
 * Builds a grounded `BrainstemSynthesisInput` from a fixed prompt so every
 * dependent field (plan, skeptic review, crucible decision) is internally
 * consistent. `overrides` attaches execution/validation evidence per test.
 */
function makeGroundedInput(overrides: Partial<BrainstemSynthesisInput> = {}): BrainstemSynthesisInput {
  const prompt = "Fix the TypeScript bug in src/api/server.ts and update tests.";
  const triage = triageUserMessage(prompt);
  const contextPack = makeContextPack(triage, prompt);
  const plannerInput = PlannerInputSchema.parse({ triage, contextPack, messageContent: prompt });
  const plannerOutput = createFakePlan(plannerInput);
  const skepticReview = reviewPlanWithSkeptic(plannerOutput, contextPack);
  const crucibleDecision = arbitratePlanWithCrucible({
    plannerOutput,
    skepticReview,
    now: () => FIXED_TIMESTAMP,
  });

  return {
    traceId: "trace-byok-synth-unit",
    triage,
    contextPack,
    plannerOutput,
    skepticReview,
    crucibleDecision,
    ...overrides,
  };
}

/**
 * Builds a `HealingLoopResult` whose single failure carries `message`, reusing
 * the deterministic failing execution result as the final execution result. The
 * presence of a `validationHealingResult` makes the run carry validation
 * evidence (so non-empty citations are required).
 */
function makeValidationHealingResult(message: string): HealingLoopResult {
  return {
    status: "FAILED",
    attempts: 1,
    failures: [
      {
        nodeId: "node-1",
        classification: "VALIDATION",
        errorCode: "E_VALIDATION",
        message,
      },
    ],
    actions: [{ type: "FAIL_RUN", reason: "validation failed after exhausting healing" }],
    finalExecutionResult: FAILING_SAMPLE.executionResult,
    rounds: [],
  };
}

/** A schema-valid synthesis draft (>=1 citation) whose fields carry `text`. */
function draftWithText(text: string): SynthesisDraft {
  return {
    response: text,
    citations: [{ kind: "file", ref: "src/api/server.ts", detail: text }],
  };
}

describe("runLiveSynthesizer unit tests (task 6.4)", () => {
  // Validates: Requirements 2.1, 2.2.
  it("returns an ok, evidence-cited answer on a valid first try", async () => {
    const input = makeGroundedInput({
      executionResult: FAILING_SAMPLE.executionResult,
      validationHealingResult: makeValidationHealingResult("node-1 failed validation"),
    });
    const draft: SynthesisDraft = {
      response: "Applied the fix; the failing node is documented below.",
      citations: [
        { kind: "file", ref: "src/api/server.ts", detail: "patched the off-by-one in the handler" },
        { kind: "failure", ref: "node-1", detail: "validation failure recorded in the run state" },
      ],
    };
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [synthesisDraftToJson(draft)],
    });

    const result = await runLiveSynthesizer(input, { provider, run: makeExternalRun(generousBudget()) });

    expect(result.status).toBe("ok");
    expect(provider.invokeCount).toBe(1);
    expect(result.attempts).toBe(1);
    // Req 2.2: at least one citation referencing run-state evidence.
    expect(result.citations.length).toBeGreaterThanOrEqual(1);
    expect(result.synthesis.providerCalls).toBe(1);
    expect(result.usage.modelCalls).toBe(1);
  });

  // Validates: Requirement 2.3.
  it("rejects a citation-free answer, repairs once, and recovers on the repaired draft", async () => {
    const input = makeGroundedInput({
      validationHealingResult: makeValidationHealingResult("node-1 failed validation"),
    });
    const [citationFree] = fc.sample(arbCitationFreeSynthesisDraft(), { numRuns: 1, seed: 7 });
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      // First reply is citation-free (invalid because evidence exists); the
      // repaired reply carries a citation and is accepted.
      responses: [
        synthesisDraftToJson(citationFree),
        synthesisDraftToJson(draftWithText("Repaired: cited the failing node.")),
      ],
    });

    const result = await runLiveSynthesizer(input, { provider, run: makeExternalRun(generousBudget()) });

    expect(provider.invokeCount).toBe(2);
    expect(result.status).toBe("ok");
    expect(result.attempts).toBe(2);
    expect(result.citations.length).toBeGreaterThanOrEqual(1);
  });

  // Validates: Requirements 2.3, 2.5.
  it("falls back to the deterministic synthesis when the repaired answer is still citation-free", async () => {
    const input = makeGroundedInput({
      validationHealingResult: makeValidationHealingResult("node-1 failed validation"),
    });
    const [citationFreeA] = fc.sample(arbCitationFreeSynthesisDraft(), { numRuns: 1, seed: 11 });
    const [citationFreeB] = fc.sample(arbCitationFreeSynthesisDraft(), { numRuns: 1, seed: 13 });
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [synthesisDraftToJson(citationFreeA), synthesisDraftToJson(citationFreeB)],
    });

    const result = await runLiveSynthesizer(input, { provider, run: makeExternalRun(generousBudget()) });

    // Req 2.3/2.5: at most two calls, then the deterministic fallback.
    expect(provider.invokeCount).toBe(2);
    expect(result.status).toBe("fallback");
    expect(result.synthesis).toEqual(synthesizeChatBrainstemResponse(input));
    expect(result.citations).toEqual([]);
  });

  // Validates: Requirement 2.5.
  it("falls back without throwing when the provider errors on the first call", async () => {
    const input = makeGroundedInput({
      validationHealingResult: makeValidationHealingResult("node-1 failed validation"),
    });
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [{ error: new Error("transport failure: connection reset") }],
    });

    const result = await runLiveSynthesizer(input, { provider, run: makeExternalRun(generousBudget()) });

    // The provider was reached once and threw; the synthesizer must not rethrow.
    expect(provider.invokeCount).toBe(1);
    expect(result.status).toBe("fallback");
    expect(result.synthesis).toEqual(synthesizeChatBrainstemResponse(input));
    expect(result.citations).toEqual([]);
    // No raw provider body survives: the error is swallowed into the fallback.
    expect(JSON.stringify(result)).not.toContain("connection reset");
  });

  // Validates: Requirements 2.4, 2.5.
  it("falls back after exactly one repair when the output never conforms to the schema", async () => {
    const input = makeGroundedInput({
      validationHealingResult: makeValidationHealingResult("node-1 failed validation"),
    });
    const [malformedA] = fc.sample(arbMalformedSynthesisJson(), { numRuns: 1, seed: 17 });
    const [malformedB] = fc.sample(arbMalformedSynthesisJson(), { numRuns: 1, seed: 19 });
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [malformedA, malformedB],
    });

    const result = await runLiveSynthesizer(input, { provider, run: makeExternalRun(generousBudget()) });

    // Req 2.4: one repair prompt, at most two total calls; then fallback (Req 2.5).
    expect(provider.invokeCount).toBe(2);
    expect(result.status).toBe("fallback");
    expect(result.synthesis).toEqual(synthesizeChatBrainstemResponse(input));
  });

  // Validates: Requirement 2.6.
  it("redacts every input field before prompt construction so no secret reaches the provider", async () => {
    const leakingFailure = embedSecret(UNIT_SECRET, "failure-message");
    const input = makeGroundedInput({
      validationHealingResult: makeValidationHealingResult(leakingFailure),
    });
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [synthesisDraftToJson(draftWithText("Answer grounded in the run state."))],
    });

    // Sanity: the un-redacted input genuinely carries the secret, so the
    // assertion below is meaningful rather than vacuous.
    expect(JSON.stringify(input)).toContain(UNIT_SECRET);

    const result = await runLiveSynthesizer(input, { provider, run: makeExternalRun(generousBudget()) });

    expect(result.status).toBe("ok");
    expect(provider.invokeCount).toBe(1);
    // Req 2.6: the constructed prompt the provider received carries no secret.
    expect(JSON.stringify(provider.requests)).not.toContain(UNIT_SECRET);
  });

  // Validates: Requirement 2.7.
  it("redacts the assembled response and citations before returning", async () => {
    const input = makeGroundedInput({
      validationHealingResult: makeValidationHealingResult("node-1 failed validation"),
    });
    const leakingText = `Authorization: Bearer ${UNIT_SECRET}`;
    const draft: SynthesisDraft = {
      response: `Here is the result. ${leakingText}`,
      citations: [{ kind: "command", ref: "npm test", detail: `ran with ${leakingText}` }],
    };
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [synthesisDraftToJson(draft)],
    });

    const result = await runLiveSynthesizer(input, { provider, run: makeExternalRun(generousBudget()) });

    expect(result.status).toBe("ok");
    // Req 2.7: no configured secret survives in the assembled answer or citations.
    expect(result.synthesis.response).not.toContain(UNIT_SECRET);
    expect(JSON.stringify(result.citations)).not.toContain(UNIT_SECRET);
    expect(JSON.stringify(result)).not.toContain(UNIT_SECRET);
  });

  // Validates: Requirement 2.8.
  it("preserves failed validation output in the returned answer rather than omitting it", async () => {
    const input = makeGroundedInput({
      executionResult: FAILING_SAMPLE.executionResult,
      validationHealingResult: makeValidationHealingResult(`compilation error ${FAILURE_MARKER}`),
    });
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [synthesisDraftToJson(draftWithText("Summary of the run with the failure cited."))],
    });

    const result = await runLiveSynthesizer(input, { provider, run: makeExternalRun(generousBudget()) });

    expect(result.status).toBe("ok");
    // Req 2.8: the failed validation output is surfaced in the answer evidence.
    expect(result.synthesis.evidence.some((entry) => entry.includes(FAILURE_MARKER))).toBe(true);
  });
});
