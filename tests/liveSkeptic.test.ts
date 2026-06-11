/**
 * Live skeptic property tests (ORN-35).
 *
 * Property 7: Live skeptic output always conforms to the schema or yields a
 * structured blocker.
 *
 * Validates Requirements 1.1, 1.3, 1.5, 1.6, and 9.4. For arbitrary
 * valid / malformed / schema-invalid provider output, `runLiveSkeptic` must
 * resolve without throwing and land on exactly one of two structured outcomes:
 *   - status "ok"      => a review that parses `SkepticReviewSchema`, with a
 *                         verdict RECOMPUTED from finding severities (never the
 *                         model's advisory verdict);
 *   - status "blocked" => a structured `SkepticBlocker`; for malformed output on
 *                         both attempts the code is `SKEPTIC_INVALID` with
 *                         `attempts === 2` (one initial call + exactly one
 *                         repair) and no third provider call.
 *
 * Across every path the single-repair bound holds: `provider.invoke` is called
 * at most twice. A generous budget is used so the preflight never denies a call
 * (budget denial is Property 8, task 5.4); the only reason the skeptic stops is
 * a successful review or the single-repair refusal. Everything is in-memory and
 * mock-only: no API key and no network are used.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { createFakePlan, PlannerInputSchema } from "../src/orchestration/planner";
import { arbitratePlanWithCrucible } from "../src/orchestration/crucible";
import { triageUserMessage } from "../src/orchestration/triage";
import { ProviderError, type LLMProvider, type LLMResponse } from "../src/providers/llm";
import {
  runLiveSkeptic,
  SkepticReviewSchema,
  type SkepticFinding,
  type SkepticReviewVerdict,
} from "../src/orchestration/skeptic";
import {
  DEFAULT_SPY_USAGE,
  SpyLLMProvider,
  arbMalformedSkepticJson,
  arbPlannerInput,
  arbSubThresholdBudget,
  arbValidSkepticDraft,
  generousBudget,
  makeContextPack,
  makeExternalRun,
  skepticDraftToJson,
  type ScriptedResponse,
  type SkepticReviewDraft,
} from "./support/byokArbitraries";

/**
 * The deterministic verdict oracle (Req 1.3): any `BLOCKER` finding => BLOCKED;
 * any other non-empty findings => NEEDS_REVISION; no findings => SOUND. The
 * model's advisory verdict is intentionally ignored here so the test pins the
 * control plane's recomputation, not the model's claim.
 */
function expectedVerdict(findings: SkepticFinding[]): SkepticReviewVerdict {
  if (findings.some((finding) => finding.severity === "BLOCKER")) return "BLOCKED";
  return findings.length > 0 ? "NEEDS_REVISION" : "SOUND";
}

describe("Property 7: live skeptic output conforms to the schema or yields a structured blocker", () => {
  // Validates: Requirements 1.1, 1.3, 9.4.
  it("returns an ok review that parses SkepticReviewSchema with a severity-derived verdict", async () => {
    await fc.assert(
      fc.asyncProperty(arbPlannerInput(), arbValidSkepticDraft(), async (input, draft) => {
        // The provider returns a single schema-valid critique draft. The draft's
        // advisory verdict is chosen independently of its findings, so the test
        // confirms the control plane recomputes it rather than trusting it.
        const provider = new SpyLLMProvider({
          estimate: DEFAULT_SPY_USAGE,
          responses: [skepticDraftToJson(draft)],
        });
        const run = makeExternalRun(generousBudget());
        const plannerOutput = createFakePlan(input);

        // Must resolve, never throw.
        const result = await runLiveSkeptic(
          { plannerOutput, contextPack: input.contextPack, triage: input.triage },
          { provider, run }
        );

        // Req 1.1: a valid draft yields an ok review on the first attempt.
        expect(result.status).toBe("ok");
        expect(result.blocker).toBeUndefined();
        expect(result.attempts).toBe(1);
        expect(provider.invokeCount).toBe(1);
        expect(provider.invokeCount).toBeLessThanOrEqual(2);

        // Req 1.1: the assembled review conforms to the existing schema.
        expect(result.review).toBeDefined();
        expect(() => SkepticReviewSchema.parse(result.review)).not.toThrow();

        // Req 1.3: the verdict is recomputed from finding severities, never the
        // model's advisory verdict.
        expect(result.review?.verdict).toBe(expectedVerdict(draft.findings));

        // The deterministic fields are stamped from the plan, not the model.
        expect(result.review?.planGoal).toBe(plannerOutput.goal);
      }),
      { numRuns: 200 }
    );
  });

  // Validates: Requirements 1.5, 1.6, 9.4.
  it("blocks with SKEPTIC_INVALID after exactly one repair (two invokes) on persistently malformed output", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbPlannerInput(),
        arbMalformedSkepticJson(),
        arbMalformedSkepticJson(),
        async (input, firstMalformed, secondMalformed) => {
          // Both attempts return malformed/schema-invalid output; a generous
          // budget guarantees both calls are allowed, so the only stopping
          // reason is the single-repair refusal (Req 1.5/1.6).
          const provider = new SpyLLMProvider({
            estimate: DEFAULT_SPY_USAGE,
            responses: [firstMalformed, secondMalformed],
          });
          const run = makeExternalRun(generousBudget());
          const plannerOutput = createFakePlan(input);

          // Must resolve, never throw, for arbitrary malformed output (Req 9.4).
          const result = await runLiveSkeptic(
            { plannerOutput, contextPack: input.contextPack, triage: input.triage },
            { provider, run }
          );

          // Req 1.6: structured SKEPTIC_INVALID blocker, no review.
          expect(result.status).toBe("blocked");
          expect(result.blocker?.code).toBe("SKEPTIC_INVALID");
          expect(result.review).toBeUndefined();

          // Req 1.5/1.6: exactly one initial call + one repair, no third call.
          expect(result.attempts).toBe(2);
          expect(provider.invokeCount).toBe(2);
          expect(provider.invokeCount).toBeLessThanOrEqual(2);
        }
      ),
      { numRuns: 200 }
    );
  });

  // Validates: Requirements 1.1, 1.3, 1.5, 1.6, 9.4. A single property spanning
  // every outcome path (valid first try, valid after one repair, malformed
  // twice) asserts the invariant that holds across all of them: the call is
  // never made more than twice and the outcome is always a schema-valid review
  // or a structured blocker — never a throw.
  it("never throws and never invokes the provider more than twice on any outcome path", async () => {
    /**
     * Scripted responses spanning every path the live skeptic can take. The
     * spy uses `repeat-last` so a hypothetical THIRD call would return content
     * instead of throwing an overflow error — making `invokeCount <= 2` the
     * meaningful guard against a regression that adds another repair.
     */
    const arbResponseScript = (): fc.Arbitrary<{
      responses: Array<string | ScriptedResponse>;
      expectOk: boolean;
      expectedFindings?: SkepticFinding[];
    }> =>
      fc.oneof(
        // valid-first-try: one call, status "ok".
        arbValidSkepticDraft().map((draft) => ({
          responses: [skepticDraftToJson(draft)],
          expectOk: true,
          expectedFindings: draft.findings,
        })),
        // valid-after-repair: malformed then valid => two calls, status "ok".
        fc.tuple(arbMalformedSkepticJson(), arbValidSkepticDraft()).map(([malformed, draft]) => ({
          responses: [malformed, skepticDraftToJson(draft)],
          expectOk: true,
          expectedFindings: draft.findings,
        })),
        // invalid-after-repair: malformed twice => two calls, SKEPTIC_INVALID.
        fc.tuple(arbMalformedSkepticJson(), arbMalformedSkepticJson()).map(([first, second]) => ({
          responses: [first, second],
          expectOk: false,
        }))
      );

    await fc.assert(
      fc.asyncProperty(arbPlannerInput(), arbResponseScript(), async (input, script) => {
        const provider = new SpyLLMProvider({
          estimate: DEFAULT_SPY_USAGE,
          responses: script.responses,
          onOverflow: "repeat-last",
        });
        const run = makeExternalRun(generousBudget());
        const plannerOutput = createFakePlan(input);

        // Must resolve, never throw, on every scripted outcome path (Req 9.4).
        const result = await runLiveSkeptic(
          { plannerOutput, contextPack: input.contextPack, triage: input.triage },
          { provider, run }
        );

        // Req 1.5: the single-repair bound holds on every path.
        expect(provider.invokeCount).toBeLessThanOrEqual(2);
        expect(result.attempts).toBeLessThanOrEqual(2);
        expect(result.attempts).toBe(provider.invokeCount);

        if (script.expectOk) {
          // Req 1.1/1.3: schema-valid review with a severity-derived verdict.
          expect(result.status).toBe("ok");
          expect(result.blocker).toBeUndefined();
          expect(() => SkepticReviewSchema.parse(result.review)).not.toThrow();
          expect(result.review?.verdict).toBe(expectedVerdict(script.expectedFindings ?? []));
        } else {
          // Req 1.6: persistent malformity yields a structured blocker.
          expect(result.status).toBe("blocked");
          expect(result.blocker?.code).toBe("SKEPTIC_INVALID");
          expect(result.review).toBeUndefined();
          expect(result.attempts).toBe(2);
        }
      }),
      { numRuns: 200 }
    );
  });
});

/**
 * Property 8: Budget denial precedes the network call (skeptic).
 *
 * Validates Requirements 6.1 and 6.3. The control plane runs Budget_Preflight
 * BEFORE any provider invocation, so when the budget cannot afford a positive
 * estimate the live skeptic must short-circuit deterministically:
 *   - Req 6.1: the provider is invoked only after preflight returns an allow
 *     decision; a deny decision means the call never happens;
 *   - Req 6.3: the result is a structured `BUDGET_DENIED` blocker, the reported
 *     provider cost is 0 USD (no call => no spend), and zero provider calls were
 *     made.
 *
 * The spy provider is scripted with a perfectly valid review draft on purpose:
 * if the preflight gate ever leaked and the provider were invoked, the call
 * would succeed and `invokeCount` would rise above 0 — so `invokeCount === 0`
 * is a meaningful guard that the denial truly precedes the network call rather
 * than an accident of a failing provider. Everything is in-memory and mock-only:
 * no API key and no network are used.
 */
describe("Property 8: budget denial precedes the network call (skeptic)", () => {
  // Validates: Requirements 6.1, 6.3.
  it("returns a BUDGET_DENIED blocker with 0 USD cost and zero provider invocations for any sub-threshold budget", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbPlannerInput(),
        arbSubThresholdBudget(),
        arbValidSkepticDraft(),
        async (input, budget, draft) => {
          // A valid draft is scripted so that ANY provider call would succeed.
          // The only way `invokeCount` stays 0 is the preflight denying the call
          // before it is made (Req 6.1).
          const provider = new SpyLLMProvider({
            estimate: DEFAULT_SPY_USAGE,
            responses: [skepticDraftToJson(draft)],
          });
          const run = makeExternalRun(budget);
          const plannerOutput = createFakePlan(input);

          // Must resolve, never throw, on a denied budget (Req 9.4).
          const result = await runLiveSkeptic(
            { plannerOutput, contextPack: input.contextPack, triage: input.triage },
            { provider, run }
          );

          // Req 6.3: a structured BUDGET_DENIED blocker, no review.
          expect(result.status).toBe("blocked");
          expect(result.blocker?.code).toBe("BUDGET_DENIED");
          expect(result.review).toBeUndefined();

          // Req 6.1: the provider was never invoked — denial precedes the call.
          expect(provider.invokeCount).toBe(0);
          expect(result.attempts).toBe(0);

          // Req 6.3: provider cost is 0 USD (no call => no spend), and no model
          // call was counted toward usage.
          expect(result.usage.estimatedUsd).toBe(0);
          expect(result.usage.modelCalls).toBe(0);
        }
      ),
      { numRuns: 200 }
    );
  });
});

// ===========================================================================
// runLiveSkeptic unit tests (task 5.5)
// ===========================================================================
//
// Deterministic, example-based coverage that pins the concrete behaviours the
// property tests above only sample: stamping the deterministic fields from the
// clock and plan (Req 1.2), recomputing the verdict over a dishonest model
// claim (Req 1.3), the crucible consuming an `ok` review unchanged (Req 1.4),
// usage accumulation across attempts (Req 1.7), the 60s timeout counted as one
// attempt (Req 1.8), and mapping a provider error to a redacted PROVIDER_ERROR
// blocker that carries no raw response body (Req 1.9, 6.5, 7.1). Everything is
// in-memory and mock-only: no API key and no network are used.

/** A fixed, schema-valid planner input for the deterministic unit cases. */
function fixedPlannerInput(prompt = "Fix the TypeScript bug in src/api/server.ts and update tests.") {
  const triage = triageUserMessage(prompt);
  return PlannerInputSchema.parse({
    triage,
    contextPack: makeContextPack(triage, prompt),
    messageContent: prompt,
  });
}

/** Builds a single schema-valid `SkepticFinding` of the requested severity. */
function makeFinding(severity: SkepticFinding["severity"], index = 1): SkepticFinding {
  return {
    id: `finding-${index}`,
    severity,
    category: "safety",
    message: `${severity} concern #${index}`,
    evidence: `Evidence for ${severity} concern #${index}`,
    recommendation: `Address the ${severity} concern #${index}`,
  };
}

/**
 * A hanging provider whose `invoke` never resolves, so the live skeptic's
 * per-invocation timeout always wins the race. Exposes an invoke counter so the
 * test can assert the timed-out call was counted as exactly one attempt.
 */
function makeHangingProvider(): { provider: LLMProvider; readonly invokeCount: number } {
  const base = new SpyLLMProvider({ estimate: DEFAULT_SPY_USAGE });
  const state = { invokeCount: 0 };
  const provider: LLMProvider = {
    metadata: base.metadata,
    validateConfig: () => base.validateConfig(),
    estimateRequest: (request) => base.estimateRequest(request),
    invoke: () => {
      state.invokeCount += 1;
      // Never resolves and never rejects: no timer, so it does not hold the
      // event loop open once the timeout race resolves.
      return new Promise<LLMResponse>(() => {});
    },
  };
  return {
    provider,
    get invokeCount() {
      return state.invokeCount;
    },
  };
}

describe("runLiveSkeptic unit tests (task 5.5)", () => {
  // Validates: Requirements 1.1, 1.2.
  it("returns an ok review on a valid first try and stamps reviewedPlanId/planGoal/createdAt", async () => {
    const draft: SkepticReviewDraft = { verdict: "NEEDS_REVISION", findings: [makeFinding("MINOR")] };
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [skepticDraftToJson(draft)],
    });
    const run = makeExternalRun(generousBudget());
    const input = fixedPlannerInput();
    const plannerOutput = createFakePlan(input);
    const createdAt = "2026-02-02T03:04:05.000Z";

    const result = await runLiveSkeptic(
      { plannerOutput, contextPack: input.contextPack, triage: input.triage, now: () => createdAt },
      { provider, run }
    );

    expect(result.status).toBe("ok");
    expect(result.attempts).toBe(1);
    expect(provider.invokeCount).toBe(1);
    expect(result.blocker).toBeUndefined();

    // Req 1.1: the assembled review conforms to the existing schema.
    expect(() => SkepticReviewSchema.parse(result.review)).not.toThrow();

    // Req 1.2: deterministic fields are stamped from the plan and the clock.
    expect(result.review?.planGoal).toBe(plannerOutput.goal);
    expect(result.review?.createdAt).toBe(createdAt);
    expect(result.review?.reviewedPlanId).toBe((plannerOutput as { id?: string }).id);
  });

  // Validates: Requirements 1.5.
  it("returns an ok review after exactly one repair when the first response is malformed", async () => {
    const draft: SkepticReviewDraft = { verdict: "SOUND", findings: [] };
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: ["<<<NOT_JSON at all", skepticDraftToJson(draft)],
    });
    const run = makeExternalRun(generousBudget());
    const input = fixedPlannerInput();
    const plannerOutput = createFakePlan(input);

    const result = await runLiveSkeptic(
      { plannerOutput, contextPack: input.contextPack, triage: input.triage },
      { provider, run }
    );

    // Req 1.5: one initial call + exactly one repair, then a valid review.
    expect(result.status).toBe("ok");
    expect(result.attempts).toBe(2);
    expect(provider.invokeCount).toBe(2);
    expect(() => SkepticReviewSchema.parse(result.review)).not.toThrow();
  });

  // Validates: Requirements 1.3. The model's advisory verdict is never trusted;
  // the control plane recomputes it from the finding severities.
  it("recomputes the verdict from finding severities, overriding a dishonest model verdict", async () => {
    const run = makeExternalRun(generousBudget());
    const input = fixedPlannerInput();
    const plannerOutput = createFakePlan(input);

    const cases: Array<{ draft: SkepticReviewDraft; expected: SkepticReviewVerdict }> = [
      // Model claims SOUND while emitting a BLOCKER => recomputed BLOCKED.
      { draft: { verdict: "SOUND", findings: [makeFinding("BLOCKER")] }, expected: "BLOCKED" },
      // Model claims BLOCKED with no findings => recomputed SOUND.
      { draft: { verdict: "BLOCKED", findings: [] }, expected: "SOUND" },
      // Model claims SOUND with a MINOR finding => recomputed NEEDS_REVISION.
      { draft: { verdict: "SOUND", findings: [makeFinding("MINOR")] }, expected: "NEEDS_REVISION" },
    ];

    for (const { draft, expected } of cases) {
      const provider = new SpyLLMProvider({
        estimate: DEFAULT_SPY_USAGE,
        responses: [skepticDraftToJson(draft)],
      });

      const result = await runLiveSkeptic(
        { plannerOutput, contextPack: input.contextPack, triage: input.triage },
        { provider, run }
      );

      expect(result.status).toBe("ok");
      expect(result.review?.verdict).toBe(expected);
    }
  });

  // Validates: Requirements 1.9, 6.5, 7.1. A provider transport error maps to a
  // redacted PROVIDER_ERROR blocker whose message carries no secret and which
  // never echoes the raw provider response body.
  it("maps a provider error to a redacted PROVIDER_ERROR blocker with no raw response body", async () => {
    const secret = "sk-AABBCCDDEEFF00112233445566778899";
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [
        {
          error: new ProviderError({
            code: "PROVIDER_HTTP_ERROR",
            provider: "spy",
            status: 401,
            message: `Upstream rejected Authorization: Bearer ${secret}`,
            details: { rawBody: `{"error":"invalid key ${secret}"}` },
          }),
        },
      ],
    });
    const run = makeExternalRun(generousBudget());
    const input = fixedPlannerInput();
    const plannerOutput = createFakePlan(input);

    const result = await runLiveSkeptic(
      { plannerOutput, contextPack: input.contextPack, triage: input.triage },
      { provider, run }
    );

    // Req 1.9: a structured PROVIDER_ERROR blocker, no review, no further call.
    expect(result.status).toBe("blocked");
    expect(result.blocker?.code).toBe("PROVIDER_ERROR");
    expect(result.review).toBeUndefined();
    expect(result.attempts).toBe(1);
    expect(provider.invokeCount).toBe(1);

    // Req 6.5/7.1: the secret is redacted out of the blocker message and the
    // raw provider response body is excluded entirely.
    expect(result.blocker?.message).not.toContain(secret);
    expect(result.blocker?.message).toContain("[REDACTED]");
    expect(result.blocker?.details).toBeUndefined();

    // Belt-and-suspenders: no secret survives anywhere in the serialized result.
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  // Validates: Requirements 1.7, 1.9. A provider error on the repair call still
  // preserves the usage accumulated from the first (successful) call.
  it("preserves accumulated usage when the repair call errors", async () => {
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [
        {
          content: "<<<NOT_JSON garbage",
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, estimatedUsd: 0.01, modelCalls: 1 },
        },
        {
          error: new ProviderError({ code: "PROVIDER_HTTP_ERROR", provider: "spy", message: "transient upstream failure" }),
        },
      ],
    });
    const run = makeExternalRun(generousBudget());
    const input = fixedPlannerInput();
    const plannerOutput = createFakePlan(input);

    const result = await runLiveSkeptic(
      { plannerOutput, contextPack: input.contextPack, triage: input.triage },
      { provider, run }
    );

    expect(result.status).toBe("blocked");
    expect(result.blocker?.code).toBe("PROVIDER_ERROR");
    expect(result.attempts).toBe(2);
    expect(provider.invokeCount).toBe(2);

    // Req 1.9/1.7: the first call's usage is preserved in the returned result.
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(50);
    expect(result.usage.modelCalls).toBe(1);
    expect(result.usage.estimatedUsd).toBeCloseTo(0.01, 5);
  });

  // Validates: Requirements 1.8. A bounded invocation that never returns is
  // counted as a single attempt and yields a PROVIDER_ERROR blocker.
  it("counts a timed-out invocation as one attempt and returns a PROVIDER_ERROR blocker", async () => {
    const hanging = makeHangingProvider();
    const run = makeExternalRun(generousBudget());
    const input = fixedPlannerInput();
    const plannerOutput = createFakePlan(input);

    const result = await runLiveSkeptic(
      { plannerOutput, contextPack: input.contextPack, triage: input.triage },
      { provider: hanging.provider, run, timeoutMs: 20 }
    );

    // Req 1.8: the timeout counts as exactly one attempt; no second/third call.
    expect(result.status).toBe("blocked");
    expect(result.blocker?.code).toBe("PROVIDER_ERROR");
    expect(result.attempts).toBe(1);
    expect(hanging.invokeCount).toBe(1);
    expect(result.blocker?.message).toContain("timed out");
  });

  // Validates: Requirements 1.7. Usage is the sum across every provider attempt.
  it("accumulates LLMUsage across all provider attempts", async () => {
    const draft: SkepticReviewDraft = { verdict: "SOUND", findings: [] };
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [
        {
          content: "<<<NOT_JSON garbage",
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, estimatedUsd: 0.01, modelCalls: 1 },
        },
        {
          content: skepticDraftToJson(draft),
          usage: { inputTokens: 200, outputTokens: 40, totalTokens: 240, estimatedUsd: 0.02, modelCalls: 1 },
        },
      ],
    });
    const run = makeExternalRun(generousBudget());
    const input = fixedPlannerInput();
    const plannerOutput = createFakePlan(input);

    const result = await runLiveSkeptic(
      { plannerOutput, contextPack: input.contextPack, triage: input.triage },
      { provider, run }
    );

    expect(result.status).toBe("ok");
    expect(result.attempts).toBe(2);

    // Req 1.7: usage is the sum of both attempts.
    expect(result.usage.inputTokens).toBe(300);
    expect(result.usage.outputTokens).toBe(90);
    expect(result.usage.totalTokens).toBe(390);
    expect(result.usage.modelCalls).toBe(2);
    expect(result.usage.estimatedUsd).toBeCloseTo(0.03, 5);
  });

  // Validates: Requirements 1.4. The `ok` review is consumed by
  // `arbitratePlanWithCrucible` with no special-casing.
  it("produces an ok review that the crucible accepts unchanged", async () => {
    const draft: SkepticReviewDraft = { verdict: "SOUND", findings: [] };
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [skepticDraftToJson(draft)],
    });
    const run = makeExternalRun(generousBudget());
    const input = fixedPlannerInput();
    const plannerOutput = createFakePlan(input);

    const result = await runLiveSkeptic(
      { plannerOutput, contextPack: input.contextPack, triage: input.triage },
      { provider, run }
    );

    expect(result.status).toBe("ok");
    expect(result.review).toBeDefined();

    // Req 1.4: the crucible consumes the live review exactly like a heuristic one.
    const decision = arbitratePlanWithCrucible({ plannerOutput, skepticReview: result.review! });
    expect(decision.verdict).toBe("ACCEPTED");
    expect(decision.acceptedPlan?.goal).toBe(plannerOutput.goal);
  });
});
