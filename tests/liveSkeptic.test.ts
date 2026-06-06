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

import { createFakePlan } from "../src/orchestration/planner";
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
  arbValidSkepticDraft,
  generousBudget,
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
