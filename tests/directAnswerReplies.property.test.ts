/**
 * Task 2.3 — Direct-answer reply property test (ORN-58).
 *
 * **Feature: byok-chat-ux-and-model-discovery, Property 2: Direct answers carry no internal prose and stay bounded**
 * **Validates: Requirements 5.1, 5.2, 5.3**
 *
 * For any `BrainstemSynthesisInput` whose triage route is `DIRECT_ANSWER`, the
 * deterministic `buildDeterministicDirectAnswer` reply SHALL:
 *   - be exactly the `response` the synthesizer selects for that route (Req 5.1),
 *   - contain none of the internal-trace substrings `"Status:"`, `"Route:"`,
 *     `"Trace:"`, or `"Evidence:"` (Req 5.2), and
 *   - consist of at most 6 sentences (Req 5.3).
 *
 * The input is built bottom-up from an arbitrary planner input so every dependent
 * field (plan, skeptic review, crucible decision) stays internally consistent; the
 * triage route is then pinned to `DIRECT_ANSWER` to satisfy the property's
 * quantifier. Everything is pure and in-memory: no API key and zero
 * provider/network calls occur.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { createFakePlan } from "../src/orchestration/planner";
import { reviewPlanWithSkeptic } from "../src/orchestration/skeptic";
import { arbitratePlanWithCrucible } from "../src/orchestration/crucible";
import {
  buildDeterministicDirectAnswer,
  synthesizeChatBrainstemResponse,
  type BrainstemSynthesisInput,
} from "../src/orchestration/synthesizer";
import { TRIAGE_ROUTES, type TriageResult } from "../src/orchestration/triage";
import { arbPlannerInput } from "./support/byokArbitraries";

const FIXED_TIMESTAMP = "2026-01-01T00:00:00.000Z";

/** Internal-trace prose that must never leak into a direct-answer reply (Req 5.2). */
const FORBIDDEN_SUBSTRINGS = ["Status:", "Route:", "Trace:", "Evidence:"] as const;

/**
 * Counts sentences by splitting on terminal punctuation (`.`, `!`, `?`) and keeping
 * non-empty, trimmed segments — the bound the property asserts against (Req 5.3).
 */
function countSentences(text: string): number {
  return text
    .split(/[.!?]+/u)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0).length;
}

/**
 * Arbitrary, internally-consistent `BrainstemSynthesisInput` whose triage route is
 * `DIRECT_ANSWER`. Built from an arbitrary planner input (plan from
 * `createFakePlan`, review from `reviewPlanWithSkeptic`, decision from
 * `arbitratePlanWithCrucible`); only the triage route is overridden so the input
 * matches Property 2's quantifier while every other field stays valid.
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
      traceId: "trace-direct-answer",
      triage,
      contextPack: plannerInput.contextPack,
      plannerOutput,
      skepticReview,
      crucibleDecision,
    };
  });

describe("Feature: byok-chat-ux-and-model-discovery, Property 2: Direct answers carry no internal prose and stay bounded", () => {
  // Validates: Requirements 5.1, 5.2, 5.3
  it("produces a bounded, internal-prose-free direct answer for any DIRECT_ANSWER input", () => {
    fc.assert(
      fc.property(arbDirectAnswerInput(), (input) => {
        const direct = buildDeterministicDirectAnswer(input);

        // Req 5.1: the synthesizer selects this builder's text for the DIRECT_ANSWER route.
        expect(synthesizeChatBrainstemResponse(input).response).toBe(direct);

        // Req 5.2: none of the internal-trace substrings leak into the reply.
        for (const forbidden of FORBIDDEN_SUBSTRINGS) {
          expect(direct).not.toContain(forbidden);
        }

        // Req 5.3: the reply is bounded to at most 6 sentences.
        expect(countSentences(direct)).toBeLessThanOrEqual(6);
      }),
      { numRuns: 200 }
    );
  });
});
