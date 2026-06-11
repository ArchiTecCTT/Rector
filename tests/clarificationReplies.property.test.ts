import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  buildClarificationResponse,
  type BrainstemSynthesisInput,
} from "../src/orchestration/synthesizer";
import { triageUserMessage, TriageResultSchema, type TriageResult } from "../src/orchestration/triage";
import { createFakePlan, PlannerInputSchema } from "../src/orchestration/planner";
import { reviewPlanWithSkeptic } from "../src/orchestration/skeptic";
import { arbitratePlanWithCrucible } from "../src/orchestration/crucible";
import { makeContextPack } from "./support/byokArbitraries";

/**
 * Task 2.2 — clarification reply property test.
 *
 * **Feature: byok-chat-ux-and-model-discovery, Property 1: Clarification replies carry no internal
 * prose and stay short**
 * **Validates: Requirements 1.1, 1.4, 2.1, 2.2, 2.3, 2.4, 3.3**
 *
 * For any `BrainstemSynthesisInput` whose triage route is `NEEDS_CLARIFICATION`, the synthesized
 * clarification `response` SHALL contain none of the internal-prose substrings `"Status:"`,
 * `"Route: NEEDS_CLARIFICATION"`, `"Trace:"`, or `"Evidence:"`, and SHALL consist of at most 3
 * sentences.
 *
 * `buildClarificationResponse` is a pure function of the input and only reads `input.triage`
 * (specifically `triage.reasons`, to derive a canned missing-detail hint). To exercise the full
 * `NEEDS_CLARIFICATION` input space we fix the remaining `BrainstemSynthesisInput` fields to one
 * concrete, schema-valid run (built from the real planner/skeptic/crucible helpers, provider-free)
 * and fuzz only the triage result. The generated `reasons` deliberately mix:
 *
 *   - the canned phrases that drive the derived-hint branch (`"ambiguous request detected"`,
 *     `"too little detail to route safely"`),
 *   - the phrases that fall back to the fixed default text (`"empty user message"`,
 *     `"vague greeting detected"`), and
 *   - adversarial strings that themselves embed the forbidden substrings
 *     (`"Status:"`, `"Route: NEEDS_CLARIFICATION"`, `"Trace:"`, `"Evidence:"`),
 *
 * so the property proves the builder never echoes raw reason text into the reply.
 */

// A concrete, provider-free base input. Only `triage` is overridden per-iteration; every other
// field is held fixed because `buildClarificationResponse` does not read it.
const BASE_PROMPT = "Fix the failing test in src/index.ts and update the assertions.";
const baseTriage = triageUserMessage(BASE_PROMPT);
const baseContextPack = makeContextPack(baseTriage, BASE_PROMPT);
const basePlannerOutput = createFakePlan(
  PlannerInputSchema.parse({
    triage: baseTriage,
    contextPack: baseContextPack,
    messageContent: BASE_PROMPT,
  }),
);
const baseSkepticReview = reviewPlanWithSkeptic(basePlannerOutput, baseContextPack);
const baseCrucibleDecision = arbitratePlanWithCrucible({
  plannerOutput: basePlannerOutput,
  skepticReview: baseSkepticReview,
  now: () => "2026-01-01T00:00:00.000Z",
});

const baseInput: Omit<BrainstemSynthesisInput, "triage"> = {
  traceId: "trace-clarification-test",
  contextPack: baseContextPack,
  plannerOutput: basePlannerOutput,
  skepticReview: baseSkepticReview,
  crucibleDecision: baseCrucibleDecision,
};

// The substrings the clarification reply must never contain (Req 2.1–2.4).
const FORBIDDEN_SUBSTRINGS = ["Status:", "Route: NEEDS_CLARIFICATION", "Trace:", "Evidence:"] as const;

// Canned reasons the triage classifier emits for NEEDS_CLARIFICATION, plus adversarial strings that
// embed the forbidden substrings to prove they are never echoed into the reply.
const REASON_POOL = [
  "ambiguous request detected", // -> derived-hint branch
  "too little detail to route safely", // -> derived-hint branch
  "empty user message", // -> default text branch
  "vague greeting detected", // -> default text branch
  "Status: VALIDATED leaked into a reason",
  "Route: NEEDS_CLARIFICATION leaked into a reason",
  "Trace: trace-xyz leaked into a reason",
  "Evidence: triage NEEDS_CLARIFICATION leaked into a reason",
];

const arbReason = fc.oneof(
  fc.constantFrom(...REASON_POOL),
  fc.string({ minLength: 1, maxLength: 60 }).map((value) => {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : "reason";
  }),
);

/** Arbitrary, schema-valid `NEEDS_CLARIFICATION` triage result with fuzzed reasons. */
const arbClarificationTriage = (): fc.Arbitrary<TriageResult> =>
  fc
    .record({
      confidence: fc.double({ min: 0, max: 1, noNaN: true }),
      complexity: fc.constantFrom("low", "medium", "high"),
      reasons: fc.array(arbReason, { minLength: 1, maxLength: 5 }),
      riskFlags: fc.array(fc.constantFrom("ambiguous_request", "needs_detail"), { maxLength: 2 }),
    })
    .map((partial) =>
      TriageResultSchema.parse({
        route: "NEEDS_CLARIFICATION",
        confidence: partial.confidence,
        complexity: partial.complexity,
        reasons: partial.reasons,
        riskFlags: partial.riskFlags,
      }),
    );

/** Counts terminated sentences (segments ended by `.`, `!`, or `?`). */
function sentenceCount(text: string): number {
  return (text.match(/[.!?]+(\s|$)/g) ?? []).length;
}

describe("Clarification replies carry no internal prose and stay short (Property 1)", () => {
  // Feature: byok-chat-ux-and-model-discovery, Property 1: Clarification replies carry no internal prose and stay short
  it("excludes internal-prose substrings and stays within 3 sentences for any NEEDS_CLARIFICATION input", () => {
    fc.assert(
      fc.property(arbClarificationTriage(), (triage) => {
        const input: BrainstemSynthesisInput = { ...baseInput, triage };
        const response = buildClarificationResponse(input);

        // Req 2.1–2.4: no internal trace prose leaks into the clarification reply.
        for (const forbidden of FORBIDDEN_SUBSTRINGS) {
          expect(response.includes(forbidden)).toBe(false);
        }

        // Req 1.4: at most 3 sentences.
        expect(sentenceCount(response)).toBeLessThanOrEqual(3);

        // Req 1.1: a non-empty Clarification_Response is always produced.
        expect(response.trim().length).toBeGreaterThan(0);
      }),
      { numRuns: 100 },
    );
  });
});
