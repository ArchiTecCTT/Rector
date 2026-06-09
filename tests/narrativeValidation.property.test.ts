/**
 * Feature: cloud-capable-transition, Property 26: Narrative validation rejects
 * empty, unparseable, or over-length answers.
 *
 * Validates: Requirements 7.7.
 *
 * For any model response that is empty, not parseable as the expected answer
 * shape, or exceeds the maximum answer length, the Synthesizer must treat the
 * Narrative_Answer as invalid. Invalidity is observed through the live
 * synthesizer's behavior: an invalid answer (even after the single repair
 * attempt) routes to the deterministic Legacy_Status_Response fallback, never
 * accepting the malformed answer as an `ok` result.
 *
 * The synthesizer validates the answer via `SynthesisDraftSchema`
 * (`response: z.string().min(1).max(MAX_NARRATIVE_ANSWER_CHARS)`) after a
 * `JSON.parse`, so:
 *   - empty           -> empty content fails JSON.parse, or `{response:""}` fails `.min(1)`;
 *   - unparseable     -> fails `JSON.parse`;
 *   - over-length     -> parses but fails `.max(MAX_NARRATIVE_ANSWER_CHARS)`.
 *
 * Each generated answer is invalid SOLELY because of its empty/unparseable/
 * over-length condition: the grounded input carries no execution/validation
 * evidence, so a citation-free draft is otherwise acceptable and cannot be the
 * reason for rejection. Everything is in-memory and mock-only: a generous
 * budget guarantees the provider IS reached (so a fallback proves rejection,
 * not budget denial), and no API key or network call is used.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { createFakePlan } from "../src/orchestration/planner";
import { reviewPlanWithSkeptic } from "../src/orchestration/skeptic";
import { arbitratePlanWithCrucible } from "../src/orchestration/crucible";
import {
  MAX_NARRATIVE_ANSWER_CHARS,
  runLiveSynthesizer,
  synthesizeChatBrainstemResponse,
  type BrainstemSynthesisInput,
} from "../src/orchestration/synthesizer";
import {
  SpyLLMProvider,
  arbPlannerInput,
  generousBudget,
  makeExternalRun,
} from "./support/byokArbitraries";

const FIXED_TIMESTAMP = "2026-01-01T00:00:00.000Z";

/**
 * Arbitrary, fully-grounded `BrainstemSynthesisInput` with NO execution or
 * validation evidence attached. Built bottom-up from an arbitrary planner input
 * so every dependent field is internally consistent. The absence of evidence is
 * deliberate: it means a citation-free draft is acceptable, so the only thing
 * that can make a generated answer invalid is its empty/unparseable/over-length
 * shape (the focus of Property 26).
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
      traceId: "trace-narrative-validation",
      triage: plannerInput.triage,
      contextPack: plannerInput.contextPack,
      plannerOutput,
      skepticReview,
      crucibleDecision,
    };
  });

type InvalidKind = "empty" | "unparseable" | "over-length";

/**
 * An invalid model response paired with the rejection category it exercises.
 * Each value is invalid ONLY because of its empty/unparseable/over-length
 * condition (citations are valid-or-absent so they never confound the reason).
 */
interface InvalidNarrative {
  kind: InvalidKind;
  content: string;
}

/** Empty answers: an empty/whitespace body, or a parseable draft whose response is empty. */
const arbEmptyNarrative = (): fc.Arbitrary<InvalidNarrative> =>
  fc
    .oneof(
      // Empty/whitespace content is not parseable as the expected JSON shape.
      fc.constantFrom("", "   ", "\n", "\t  "),
      // Parseable JSON whose `response` is empty/whitespace -> fails `.min(1)` (after the
      // schema's string validation) or is otherwise an empty narrative.
      fc.constantFrom(
        JSON.stringify({ response: "", citations: [] }),
        JSON.stringify({ response: "", citations: [] })
      )
    )
    .map((content) => ({ kind: "empty" as const, content }));

/** Unparseable answers: strings that are not valid JSON at all. */
const arbUnparseableNarrative = (): fc.Arbitrary<InvalidNarrative> =>
  fc
    .oneof(
      fc.string({ maxLength: 80 }).map((noise) => `<<<NOT_JSON ${noise}`),
      fc.constantFrom("{ response: 'unquoted' }", "{\"response\":", "not json", "}{"),
    )
    .map((content) => ({ kind: "unparseable" as const, content }));

/** Over-length answers: parseable drafts whose response exceeds the hard cap. */
const arbOverLengthNarrative = (): fc.Arbitrary<InvalidNarrative> =>
  fc
    .integer({ min: 1, max: 600 })
    .map((extra) => {
      const response = "x".repeat(MAX_NARRATIVE_ANSWER_CHARS + extra);
      return {
        kind: "over-length" as const,
        content: JSON.stringify({
          response,
          citations: [{ kind: "file", ref: "src/api/server.ts", detail: "evidence detail" }],
        }),
      };
    });

/** Any answer that must be rejected by narrative validation (Req 7.7). */
const arbInvalidNarrative = (): fc.Arbitrary<InvalidNarrative> =>
  fc.oneof(arbEmptyNarrative(), arbUnparseableNarrative(), arbOverLengthNarrative());

describe("Property 26: narrative validation rejects empty, unparseable, or over-length answers", () => {
  // Validates: Requirements 7.7.
  it("treats every empty, unparseable, or over-length answer as invalid and falls back to the deterministic synthesis", async () => {
    await fc.assert(
      fc.asyncProperty(arbSynthesisInput(), arbInvalidNarrative(), async (input, invalid) => {
        // The provider returns the SAME invalid content on the first call AND the
        // single repair call, so the only valid outcome is the deterministic fallback.
        const provider = new SpyLLMProvider({
          responses: [invalid.content],
          onOverflow: "repeat-last",
        });

        // A generous budget guarantees the provider IS reached, so a fallback
        // proves the answer was rejected by validation rather than denied by budget.
        const result = await runLiveSynthesizer(input, {
          provider,
          run: makeExternalRun(generousBudget()),
        });

        // The invalid answer is never accepted: it routes to the deterministic
        // Legacy_Status_Response fallback (Req 7.7).
        expect(result.status).toBe("fallback");
        expect(result.synthesis).toEqual(synthesizeChatBrainstemResponse(input));
        expect(result.citations).toEqual([]);

        // The provider was actually invoked (1 initial + 1 repair), so the
        // fallback is a rejection of the answer, not a short-circuit before any call.
        expect(provider.invokeCount).toBeGreaterThanOrEqual(1);

        // The malformed/over-length response content never survives into the answer.
        expect(result.synthesis.response).not.toContain("x".repeat(MAX_NARRATIVE_ANSWER_CHARS + 1));
      }),
      { numRuns: 200 }
    );
  });
});
