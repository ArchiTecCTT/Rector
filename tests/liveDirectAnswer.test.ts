/**
 * Live direct-answer unit tests (ORN-58, task 4.1).
 *
 * Example-based coverage of `runLiveDirectAnswer`, the External_Mode cheap-model step for the
 * `DIRECT_ANSWER` route. It mirrors the `runLiveSynthesizer` discipline (budget preflight → invoke →
 * redact → fallback), so these tests assert every fallback path returns the deterministic
 * Local_Mode direct-answer text with `providerCalls === 0`, and the success path returns the
 * redacted cheap-model answer:
 *   - no configured provider → `no_provider` fallback, zero calls (Req 8.2),
 *   - budget denial before any call → `denied` fallback, zero calls (Req 7.2, 7.3),
 *   - provider error → `provider_error` fallback, no raw provider body leaks (Req 8.1),
 *   - secret in the provider answer is redacted before it is returned (Req 8.3),
 *   - a clean provider answer is returned with `providerCalls === 1` and a recorded cost.
 *
 * Everything is in-memory and mock-only: the provider is a `SpyLLMProvider` scripted with content
 * or errors, and no API key or network is used.
 */
import { describe, it, expect } from "vitest";

import { triageUserMessage } from "../src/orchestration/triage";
import { createFakePlan, PlannerInputSchema } from "../src/orchestration/planner";
import { reviewPlanWithSkeptic } from "../src/orchestration/skeptic";
import { arbitratePlanWithCrucible } from "../src/orchestration/crucible";
import {
  buildDeterministicDirectAnswer,
  type BrainstemSynthesisInput,
} from "../src/orchestration/synthesizer";
import { runLiveDirectAnswer } from "../src/orchestration/liveDirectAnswer";
import {
  DEFAULT_SPY_USAGE,
  SpyLLMProvider,
  embedSecret,
  generousBudget,
  makeContextPack,
  makeExternalRun,
} from "./support/byokArbitraries";

const FIXED_TIMESTAMP = "2026-01-01T00:00:00.000Z";

/** A fixed, redactable bearer secret used to assert the secret never leaks. */
const UNIT_SECRET = "sk-DIRECTANSWERSECRET0123456789ABCDEF";

/**
 * Builds a grounded `DIRECT_ANSWER` `BrainstemSynthesisInput` from a simple prompt so every
 * dependent field (plan, skeptic review, crucible decision) is internally consistent.
 */
function makeDirectAnswerInput(prompt = "What is Rector?"): BrainstemSynthesisInput {
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
    traceId: "trace-direct-answer-unit",
    triage,
    contextPack,
    plannerOutput,
    skepticReview,
    crucibleDecision,
  };
}

describe("runLiveDirectAnswer unit tests (task 4.1)", () => {
  // Validates: Requirement 8.2.
  it("returns the deterministic local text with zero calls when no provider is configured", async () => {
    const input = makeDirectAnswerInput();

    const result = await runLiveDirectAnswer(input, { provider: undefined, run: makeExternalRun(generousBudget()) });

    expect(result.fallback).toBe("no_provider");
    expect(result.providerCalls).toBe(0);
    expect(result.response).toBe(buildDeterministicDirectAnswer(input));
    expect(result.cost).toBeUndefined();
  });

  // Validates: Requirements 7.2, 7.3.
  it("denies before any provider call and falls back when the budget is sub-threshold", async () => {
    const input = makeDirectAnswerInput();
    // A clean answer is scripted so ANY call would succeed; the only way the provider stays
    // un-invoked is the preflight denying the call before it is made (Req 7.2).
    const provider = new SpyLLMProvider({ estimate: DEFAULT_SPY_USAGE, responses: ["A direct answer."] });
    // Zero the model-call ceiling so the positive estimate is denied by the budget gate.
    const run = makeExternalRun(generousBudget({ maxModelCalls: 0 }));

    const result = await runLiveDirectAnswer(input, { provider, run });

    expect(provider.invokeCount).toBe(0);
    expect(result.fallback).toBe("denied");
    expect(result.providerCalls).toBe(0);
    expect(result.response).toBe(buildDeterministicDirectAnswer(input));
  });

  // Validates: Requirement 8.1.
  it("falls back without throwing and leaks no raw body when the provider errors", async () => {
    const input = makeDirectAnswerInput();
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [{ error: new Error("transport failure: connection reset xyz") }],
    });

    const result = await runLiveDirectAnswer(input, { provider, run: makeExternalRun(generousBudget()) });

    expect(provider.invokeCount).toBe(1);
    expect(result.fallback).toBe("provider_error");
    expect(result.providerCalls).toBe(0);
    expect(result.response).toBe(buildDeterministicDirectAnswer(input));
    // No raw provider body survives: the error is swallowed into the fallback.
    expect(JSON.stringify(result)).not.toContain("connection reset");
  });

  // Validates: Requirement 8.3.
  it("redacts a secret in the provider answer before returning it", async () => {
    const input = makeDirectAnswerInput();
    const leakingText = `Here is the answer. Authorization: Bearer ${UNIT_SECRET}`;
    const provider = new SpyLLMProvider({ estimate: DEFAULT_SPY_USAGE, responses: [leakingText] });

    const result = await runLiveDirectAnswer(input, { provider, run: makeExternalRun(generousBudget()) });

    expect(result.fallback).toBeUndefined();
    expect(result.providerCalls).toBe(1);
    // Req 8.3: no configured secret survives in the assembled answer.
    expect(result.response).not.toContain(UNIT_SECRET);
    expect(JSON.stringify(result)).not.toContain(UNIT_SECRET);
  });

  it("returns the redacted cheap-model answer with a recorded cost on success", async () => {
    const input = makeDirectAnswerInput();
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [{ content: "Rector is a local-first BYOK agent.", usage: { estimatedUsd: 0.02, modelCalls: 1 } }],
    });

    const result = await runLiveDirectAnswer(input, { provider, run: makeExternalRun(generousBudget()) });

    expect(provider.invokeCount).toBe(1);
    expect(result.fallback).toBeUndefined();
    expect(result.providerCalls).toBe(1);
    expect(result.response).toBe("Rector is a local-first BYOK agent.");
    expect(result.cost).toEqual({ estimatedUsd: 0.02, modelCalls: 1 });
    // The cheap-model request targets the slm/cheap route and never carries a configured secret.
    expect(provider.requests[0]?.modelRoute).toBe("cheap");
    expect(JSON.stringify(provider.requests)).not.toContain(UNIT_SECRET);
  });

  // Validates: Requirement 8.1 (empty answer is not usable).
  it("falls back when the provider returns an empty answer", async () => {
    const input = makeDirectAnswerInput();
    const provider = new SpyLLMProvider({ estimate: DEFAULT_SPY_USAGE, responses: [{ content: "   " }] });

    const result = await runLiveDirectAnswer(input, { provider, run: makeExternalRun(generousBudget()) });

    expect(result.fallback).toBe("provider_error");
    expect(result.providerCalls).toBe(0);
    expect(result.response).toBe(buildDeterministicDirectAnswer(input));
  });

  it("redacts a secret echoed in the user intent before it reaches the provider", async () => {
    const leakingPrompt = embedSecret(UNIT_SECRET, "prompt");
    const input = makeDirectAnswerInput(leakingPrompt);
    const provider = new SpyLLMProvider({ estimate: DEFAULT_SPY_USAGE, responses: ["A direct answer."] });

    // Sanity: the un-redacted intent genuinely carries the secret.
    expect(JSON.stringify(input)).toContain(UNIT_SECRET);

    const result = await runLiveDirectAnswer(input, { provider, run: makeExternalRun(generousBudget()) });

    expect(result.providerCalls).toBe(1);
    // Req 8.3: the constructed prompt the provider received carries no secret.
    expect(JSON.stringify(provider.requests)).not.toContain(UNIT_SECRET);
  });
});
