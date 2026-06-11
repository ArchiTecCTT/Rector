/**
 * Feature: cloud-capable-transition, Property 27: Synthesizer failure modes yield the
 * Legacy_Status_Response.
 *
 * Validates: Requirements 7.4.
 *
 * Req 7.4: "IF the flagship model request is denied by budget, fails, returns an invalid answer, or
 * does not return within 60 seconds, THEN THE Synthesizer SHALL return the deterministic
 * Legacy_Status_Response for that route."
 *
 * `synthesizeHeavyDeveloperRoute` opens the live gate only for an external-mode Heavy_Developer_Route
 * with a valid designated flagship provider, then races `runLiveSynthesizer` against an injectable
 * deadline (defaulting to 60 000 ms). This property exercises every one of the four failure modes and
 * asserts each yields exactly the deterministic `synthesizeChatBrainstemResponse` answer — which, for
 * a Heavy_Developer_Route, is the `Status: ... Route: ... Evidence: ...` Legacy_Status_Response:
 *
 *   - budget denial   -> the budget preflight denies before any provider call (invokeCount === 0);
 *   - live failure    -> the provider throws and the error is swallowed into the fallback;
 *   - invalid answer  -> unparseable / over-length / malformed drafts fail validation through repair;
 *   - timeout         -> a provider that never resolves is beaten by the injected deadline.
 *
 * Everything is in-memory and mock-only: the provider is a scripted spy or a never-resolving double,
 * the deadline is injected (so the timeout path never waits a real minute), and no API key or network
 * is used. The gate is held open (external + heavy route + valid flagship) so the only reason a
 * fallback can occur is the failure mode under test.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  synthesizeHeavyDeveloperRoute,
  synthesizeChatBrainstemResponse,
  MAX_NARRATIVE_ANSWER_CHARS,
  type BrainstemSynthesisInput,
  type SynthesizerGateContext,
} from "../src/orchestration/synthesizer";
import {
  TRIAGE_ROUTES,
  TriageResultSchema,
  triageUserMessage,
} from "../src/orchestration/triage";
import { PlannerInputSchema, createFakePlan } from "../src/orchestration/planner";
import { reviewPlanWithSkeptic } from "../src/orchestration/skeptic";
import { arbitratePlanWithCrucible } from "../src/orchestration/crucible";
import {
  ProviderCapabilityMetadataSchema,
  type LLMProvider,
  type LLMResponse,
  type LLMUsage,
} from "../src/providers/llm";
import type { Budget } from "../src/store/schemas";
import {
  DEFAULT_SPY_USAGE,
  SpyLLMProvider,
  arbPrompt,
  arbSubThresholdBudget,
  arbValidSynthesisDraft,
  arbMalformedSynthesisJson,
  generousBudget,
  makeContextPack,
  makeExternalRun,
  synthesisDraftToJson,
  type SynthesisDraft,
} from "./support/byokArbitraries";

const FIXED_TIMESTAMP = "2026-01-01T00:00:00.000Z";

/** The four Heavy_Developer_Routes (Req 7.1) that open the live synthesizer gate. */
const HEAVY_ROUTES = [
  TRIAGE_ROUTES.RESEARCH,
  TRIAGE_ROUTES.CODE_EDIT,
  TRIAGE_ROUTES.PLAN_ONLY,
  TRIAGE_ROUTES.LONG_RUNNING,
] as const;

/**
 * Arbitrary, internally-consistent `BrainstemSynthesisInput` whose triage route is one of the four
 * Heavy_Developer_Routes. Built bottom-up from an arbitrary prompt (so plan/skeptic/crucible are
 * mutually consistent), with the route forced to a heavy one so the live gate stays open and the
 * deterministic answer is guaranteed to be the Legacy_Status_Response rather than the clarification /
 * direct-answer text.
 */
const arbHeavyRouteSynthesisInput = (): fc.Arbitrary<BrainstemSynthesisInput> =>
  fc.tuple(arbPrompt(), fc.constantFrom(...HEAVY_ROUTES)).map(([prompt, route]) => {
    const triage = TriageResultSchema.parse({ ...triageUserMessage(prompt), route });
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
      traceId: "trace-prop27",
      triage,
      contextPack,
      plannerOutput,
      skepticReview,
      crucibleDecision,
    };
  });

/**
 * An invalid Narrative_Answer payload (Req 7.7): either a malformed/unparseable/empty draft or a
 * schema-valid-shaped draft whose `response` exceeds {@link MAX_NARRATIVE_ANSWER_CHARS}. Both fail
 * `SynthesisDraftSchema`, so an answer built from one is treated as invalid and routes to fallback.
 */
const arbInvalidAnswerPayload = (): fc.Arbitrary<string> =>
  fc.oneof(
    arbMalformedSynthesisJson(),
    fc.constant(
      JSON.stringify({
        response: "x".repeat(MAX_NARRATIVE_ANSWER_CHARS + 1),
        citations: [{ kind: "file", ref: "src/over-length.ts", detail: "answer exceeds the cap" }],
      })
    )
  );

type FailureMode =
  | { kind: "budget-denial"; budget: Budget; draft: SynthesisDraft }
  | { kind: "provider-error"; message: string }
  | { kind: "invalid-answer"; first: string; second: string }
  | { kind: "timeout" };

/** Arbitrary failure mode covering all four Req 7.4 triggers. */
const arbFailureMode = (): fc.Arbitrary<FailureMode> =>
  fc.oneof(
    fc.record({
      kind: fc.constant("budget-denial" as const),
      budget: arbSubThresholdBudget(),
      draft: arbValidSynthesisDraft(),
    }),
    fc.record({
      kind: fc.constant("provider-error" as const),
      message: fc.constantFrom("transport failure", "connection reset by peer", "socket hang up"),
    }),
    fc.record({
      kind: fc.constant("invalid-answer" as const),
      first: arbInvalidAnswerPayload(),
      second: arbInvalidAnswerPayload(),
    }),
    fc.record({ kind: fc.constant("timeout" as const) })
  );

/**
 * An `LLMProvider` double whose `invoke` never resolves, used to exercise the deadline (timeout) path.
 * `estimateRequest` reports a positive usage so the budget preflight passes and `invoke` is actually
 * reached before the injected deadline beats it. Performs no network I/O.
 */
class HangingLLMProvider implements LLMProvider {
  readonly metadata = ProviderCapabilityMetadataSchema.parse({
    id: "hanging",
    displayName: "Hanging Provider (test double)",
    routes: ["flagship"],
    models: { flagship: "hanging-flagship-v1" },
    supportsJson: true,
    supportsStreaming: false,
    maxContextTokens: 128_000,
    estimatedUsdPer1kInputTokens: 0.001,
    estimatedUsdPer1kOutputTokens: 0.001,
  });

  invokeCount = 0;

  validateConfig(): void {
    return undefined;
  }

  estimateRequest(): LLMUsage {
    return DEFAULT_SPY_USAGE;
  }

  invoke(): Promise<LLMResponse> {
    this.invokeCount += 1;
    // Never resolves: the injected deadline must win the race and return the deterministic fallback.
    return new Promise<LLMResponse>(() => {});
  }
}

/** A short injected deadline so the timeout branch resolves promptly instead of waiting 60s. */
const TIMEOUT_DEADLINE_MS = 25;

describe("Feature: cloud-capable-transition, Property 27: Synthesizer failure modes yield the Legacy_Status_Response", () => {
  // Validates: Requirements 7.4.
  it("returns the deterministic Legacy_Status_Response for budget denial, live failure, invalid answer, or timeout", async () => {
    await fc.assert(
      fc.asyncProperty(arbHeavyRouteSynthesisInput(), arbFailureMode(), async (input, mode) => {
        // Gate held open: external mode + Heavy_Developer_Route + valid flagship. The only possible
        // reason for a fallback is therefore the failure mode under test.
        const gate: SynthesizerGateContext = { mode: "external", flagshipProviderIsValid: true };

        let provider: LLMProvider;
        let budget: Budget;
        let deadlineMs: number | undefined;

        switch (mode.kind) {
          case "budget-denial": {
            // A perfectly valid draft is scripted on purpose: the only way invokeCount stays 0 is the
            // preflight denying before the call (a leaked gate would succeed and raise invokeCount).
            provider = new SpyLLMProvider({
              estimate: DEFAULT_SPY_USAGE,
              responses: [synthesisDraftToJson(mode.draft)],
              onOverflow: "repeat-last",
            });
            budget = mode.budget;
            break;
          }
          case "provider-error": {
            provider = new SpyLLMProvider({
              estimate: DEFAULT_SPY_USAGE,
              responses: [{ error: new Error(mode.message) }],
            });
            budget = generousBudget();
            break;
          }
          case "invalid-answer": {
            // Both the first answer and the post-repair answer are invalid, forcing the fallback.
            provider = new SpyLLMProvider({
              estimate: DEFAULT_SPY_USAGE,
              responses: [mode.first, mode.second],
            });
            budget = generousBudget();
            break;
          }
          case "timeout": {
            provider = new HangingLLMProvider();
            budget = generousBudget();
            deadlineMs = TIMEOUT_DEADLINE_MS;
            break;
          }
        }

        const result = await synthesizeHeavyDeveloperRoute(input, {
          provider,
          run: makeExternalRun(budget),
          gate,
          deadlineMs,
        });

        const expected = synthesizeChatBrainstemResponse(input);

        // Sanity: for a Heavy_Developer_Route the deterministic answer IS the Legacy_Status_Response.
        expect(expected.response.startsWith("Status:")).toBe(true);

        // Req 7.4: every failure mode yields the deterministic Legacy_Status_Response for that route.
        expect(result.status).toBe("fallback");
        expect(result.synthesis).toEqual(expected);
        expect(result.synthesis.response).toBe(expected.response);
        expect(result.citations).toEqual([]);
        // The deterministic fallback always reports zero provider calls in its synthesis.
        expect(result.synthesis.providerCalls).toBe(0);

        // Mode-specific guard: a denied budget must precede any provider invocation.
        if (mode.kind === "budget-denial") {
          expect((provider as SpyLLMProvider).invokeCount).toBe(0);
          expect(result.attempts).toBe(0);
        }
      }),
      { numRuns: 150 }
    );
  });
});
