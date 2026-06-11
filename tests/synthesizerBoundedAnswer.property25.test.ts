/**
 * Feature: cloud-capable-transition, Property 25: An accepted Narrative_Answer
 * is bounded and references the trace drawer.
 *
 * Validates: Requirements 7.3
 *
 * Req 7.3: WHEN the flagship model returns a valid Narrative_Answer, THE
 * Synthesizer SHALL return a summary of at most 2000 characters stating what was
 * attempted, what was fixed, and which files changed, and SHALL reference the
 * trace drawer for raw data.
 *
 * This property ranges over every valid Narrative_Answer the flagship model can
 * return: a schema-valid `{ response, citations }` draft whose `response`
 * references the trace drawer and whose length straddles the full legal range up
 * to the 2000-character cap. For each one, `runLiveSynthesizer` (driven through a
 * scripted provider double) must accept the answer (`status === "ok"`) and the
 * assembled `BrainstemSynthesis.response` must (a) be at most
 * {@link MAX_NARRATIVE_ANSWER_CHARS} characters and (b) still reference the trace
 * drawer for raw run data.
 *
 * Everything is in-memory and mock-only: the provider is a `SpyLLMProvider`
 * scripted with the generated draft, the run carries a generous budget so the
 * preflight never denies the call, and no API key or network is used.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { createFakePlan } from "../src/orchestration/planner";
import { reviewPlanWithSkeptic } from "../src/orchestration/skeptic";
import { arbitratePlanWithCrucible } from "../src/orchestration/crucible";
import {
  runLiveSynthesizer,
  MAX_NARRATIVE_ANSWER_CHARS,
  type BrainstemSynthesisInput,
} from "../src/orchestration/synthesizer";
import {
  DEFAULT_SPY_USAGE,
  SpyLLMProvider,
  arbPlannerInput,
  arbSynthesisCitation,
  generousBudget,
  makeExternalRun,
  synthesisDraftToJson,
  type SynthesisDraft,
} from "./support/byokArbitraries";

const FIXED_TIMESTAMP = "2026-01-01T00:00:00.000Z";

/** The canonical trace-drawer references a valid Narrative_Answer may carry (Req 7.3). */
const TRACE_DRAWER_PHRASES = [
  "See the trace drawer for the raw run data.",
  "Full raw details are available in the trace drawer.",
  "Refer to the trace drawer for the raw logs and evidence.",
  "Raw run data is captured in the trace drawer for review.",
] as const;

/** A redaction-safe filler alphabet (lowercase letters + spaces only): no token can match
 * `redactString`'s Bearer/Basic/credential-URI/`key=value` patterns, so the assembled answer is
 * the model's text unchanged and the trace-drawer reference survives. */
const SAFE_FILLER_CHARS = "abcdefghijklmnopqrstuvwxyz ".split("");

/** Case-insensitive trace-drawer reference check. */
function referencesTraceDrawer(text: string): boolean {
  return text.toLowerCase().includes("trace drawer");
}

/**
 * Arbitrary, fully-grounded `BrainstemSynthesisInput`. Built bottom-up from an
 * arbitrary planner input so every dependent field stays internally consistent
 * (plan -> skeptic review -> crucible decision). No execution/validation
 * evidence is attached, so a cited draft is always valid regardless of the run.
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
      traceId: "trace-prop25",
      triage: plannerInput.triage,
      contextPack: plannerInput.contextPack,
      plannerOutput,
      skepticReview,
      crucibleDecision,
    };
  });

/**
 * Arbitrary valid Narrative_Answer draft. The `response` always references the
 * trace drawer and its length straddles the full legal range up to the 2000-char
 * cap: a safe filler body (bounded so `body + " " + phrase` never exceeds the
 * cap) is paired with one of the canonical trace-drawer phrases. At least one
 * schema-valid citation is attached so the draft passes validation even when the
 * run carries evidence.
 */
const arbTraceDrawerDraft = (): fc.Arbitrary<SynthesisDraft> =>
  fc
    .constantFrom(...TRACE_DRAWER_PHRASES)
    .chain((phrase) => {
      // Reserve room for the phrase and the joining space so the total is always <= the cap; also
      // exercise the boundary by allowing the body to fill the remaining budget.
      const maxBodyLength = MAX_NARRATIVE_ANSWER_CHARS - phrase.length - 1;
      return fc.record({
        phrase: fc.constant(phrase),
        body: fc
          .array(fc.constantFrom(...SAFE_FILLER_CHARS), { minLength: 0, maxLength: maxBodyLength })
          .map((chars) => chars.join("")),
        citations: fc.array(arbSynthesisCitation(), { minLength: 1, maxLength: 4 }),
      });
    })
    .map(({ phrase, body, citations }) => ({
      // Body first, trace-drawer reference last; both kept intact and within the cap.
      response: `${body} ${phrase}`,
      citations,
    }));

describe("Feature: cloud-capable-transition, Property 25: an accepted Narrative_Answer is bounded and references the trace drawer", () => {
  // Validates: Requirements 7.3.
  it("returns a summary of at most 2000 characters that references the trace drawer for any valid Narrative_Answer", async () => {
    await fc.assert(
      fc.asyncProperty(arbSynthesisInput(), arbTraceDrawerDraft(), async (input, draft) => {
        // Sanity: the generated answer is itself a valid, bounded, trace-drawer-referencing draft.
        expect(draft.response.length).toBeLessThanOrEqual(MAX_NARRATIVE_ANSWER_CHARS);
        expect(referencesTraceDrawer(draft.response)).toBe(true);

        const provider = new SpyLLMProvider({
          estimate: DEFAULT_SPY_USAGE,
          responses: [synthesisDraftToJson(draft)],
        });
        const run = makeExternalRun(generousBudget());

        const result = await runLiveSynthesizer(input, { provider, run });

        // The valid Narrative_Answer is accepted on the first try.
        expect(result.status).toBe("ok");
        expect(result.synthesis.providerCalls).toBeGreaterThanOrEqual(1);

        // Req 7.3: the returned summary is at most 2000 characters...
        expect(result.synthesis.response.length).toBeLessThanOrEqual(MAX_NARRATIVE_ANSWER_CHARS);
        // ...and still references the trace drawer for raw data.
        expect(referencesTraceDrawer(result.synthesis.response)).toBe(true);
      }),
      { numRuns: 200 }
    );
  });
});
