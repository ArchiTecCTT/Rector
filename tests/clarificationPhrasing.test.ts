/**
 * Clarification phrasing unit tests (task 2.6, ORN-57).
 *
 * Example-based coverage for the deterministic `buildClarificationResponse`
 * builder in `src/orchestration/synthesizer.ts`:
 *   - the fixed default Clarification_Response text used when no specific
 *     missing detail can be derived from the triaged message (Req 1.3), and
 *   - the missing-detail phrasing branch that derives a short hint from the
 *     triage `reasons` and then asks for the task, repo area, or goal (Req 1.2).
 *
 * Everything is pure and in-memory: the builder reads only `input.triage`, and
 * the grounded `BrainstemSynthesisInput` is assembled from the deterministic
 * planner → skeptic → crucible pipeline. No provider, network, or API key is
 * used.
 */
import { describe, it, expect } from "vitest";

import { createFakePlan, PlannerInputSchema } from "../src/orchestration/planner";
import { reviewPlanWithSkeptic } from "../src/orchestration/skeptic";
import { arbitratePlanWithCrucible } from "../src/orchestration/crucible";
import { triageUserMessage, TriageResultSchema, type TriageResult } from "../src/orchestration/triage";
import {
  buildClarificationResponse,
  synthesizeChatBrainstemResponse,
  DEFAULT_CLARIFICATION_RESPONSE,
  type BrainstemSynthesisInput,
} from "../src/orchestration/synthesizer";
import { makeContextPack } from "./support/byokArbitraries";

const FIXED_TIMESTAMP = "2026-01-01T00:00:00.000Z";

/** Canned hint phrasings emitted by the missing-detail branch (Req 1.2). */
const AMBIGUOUS_HINT = "That request is a little ambiguous, so I want to point my workflow at the right thing.";
const TOO_LITTLE_DETAIL_HINT = "I need a bit more detail before I can route this safely.";
/** The shared ask appended after a derived hint (Req 1.2). */
const ASK_SUFFIX = "Tell me the task, repo area, or goal, and I'll route it through the right Rector workflow.";

/** Internal-prose substrings the Clarification_Response must never contain (Req 2). */
const FORBIDDEN_SUBSTRINGS = ["Status:", "Route: NEEDS_CLARIFICATION", "Trace:", "Evidence:"];

/** Counts sentences by terminal punctuation, used to assert the <= 3 bound (Req 1.4). */
function countSentences(text: string): number {
  return (text.match(/[.!?]+(\s|$)/g) ?? []).length;
}

/**
 * Builds a grounded `BrainstemSynthesisInput` carrying the supplied triage
 * result. The planner/skeptic/crucible fields are derived deterministically so
 * the input is internally consistent and schema-valid; only `triage` varies
 * between cases, which is the sole field `buildClarificationResponse` reads.
 */
function makeInput(triage: TriageResult, prompt = "placeholder prompt for grounding"): BrainstemSynthesisInput {
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
    traceId: "trace-clarification-unit",
    triage,
    contextPack,
    plannerOutput,
    skepticReview,
    crucibleDecision,
  };
}

/** A `NEEDS_CLARIFICATION` triage result carrying the supplied reasons. */
function clarificationTriage(reasons: string[]): TriageResult {
  return TriageResultSchema.parse({
    route: "NEEDS_CLARIFICATION",
    confidence: 0.82,
    complexity: "low",
    reasons,
    riskFlags: ["ambiguous_request"],
  });
}

describe("buildClarificationResponse — fixed default text (Req 1.3)", () => {
  it("returns the verbatim default text when no specific missing detail can be derived", () => {
    const response = buildClarificationResponse(makeInput(clarificationTriage(["empty user message"])));
    expect(response).toBe(DEFAULT_CLARIFICATION_RESPONSE);
  });

  it("uses the default text for a vague-greeting triage with no derivable hint", () => {
    const response = buildClarificationResponse(makeInput(clarificationTriage(["vague greeting detected"])));
    expect(response).toBe(DEFAULT_CLARIFICATION_RESPONSE);
  });

  it("falls back to the default text for unrecognized reasons", () => {
    const response = buildClarificationResponse(makeInput(clarificationTriage(["some unrelated reason"])));
    expect(response).toBe(DEFAULT_CLARIFICATION_RESPONSE);
  });

  it("matches the default returned for a real empty-message triage", () => {
    const triage = triageUserMessage("   ");
    expect(triage.route).toBe("NEEDS_CLARIFICATION");
    expect(buildClarificationResponse(makeInput(triage))).toBe(DEFAULT_CLARIFICATION_RESPONSE);
  });

  it("matches the default returned for a real vague greeting", () => {
    const triage = triageUserMessage("Hello");
    expect(triage.route).toBe("NEEDS_CLARIFICATION");
    expect(buildClarificationResponse(makeInput(triage))).toBe(DEFAULT_CLARIFICATION_RESPONSE);
  });
});

describe("buildClarificationResponse — missing-detail phrasing branch (Req 1.2)", () => {
  it("derives the ambiguous-request hint and asks for the task, repo area, or goal", () => {
    const response = buildClarificationResponse(makeInput(clarificationTriage(["ambiguous request detected"])));
    expect(response).toBe(`${AMBIGUOUS_HINT} ${ASK_SUFFIX}`);
    expect(response).not.toBe(DEFAULT_CLARIFICATION_RESPONSE);
    // Req 1.2: the reply asks for the missing task details.
    expect(response).toContain("the task, repo area, or goal");
  });

  it("derives the too-little-detail hint and asks for the task, repo area, or goal", () => {
    const response = buildClarificationResponse(makeInput(clarificationTriage(["too little detail to route safely"])));
    expect(response).toBe(`${TOO_LITTLE_DETAIL_HINT} ${ASK_SUFFIX}`);
    expect(response).not.toBe(DEFAULT_CLARIFICATION_RESPONSE);
    expect(response).toContain("the task, repo area, or goal");
  });

  it("prefers the ambiguous hint when both ambiguous and too-little-detail reasons are present", () => {
    const response = buildClarificationResponse(
      makeInput(clarificationTriage(["too little detail", "ambiguous request detected"]))
    );
    expect(response).toBe(`${AMBIGUOUS_HINT} ${ASK_SUFFIX}`);
  });

  it("matches the ambiguous phrasing for a real ambiguous-request triage end to end", () => {
    const triage = triageUserMessage("Can you do the thing?");
    expect(triage.route).toBe("NEEDS_CLARIFICATION");
    expect(triage.reasons.some((reason) => reason.toLowerCase().includes("ambiguous"))).toBe(true);
    const response = synthesizeChatBrainstemResponse(makeInput(triage)).response;
    expect(response).toBe(`${AMBIGUOUS_HINT} ${ASK_SUFFIX}`);
  });
});

describe("buildClarificationResponse — shared constraints (Req 1.4, 2)", () => {
  const cases: Array<{ name: string; reasons: string[] }> = [
    { name: "default branch", reasons: ["empty user message"] },
    { name: "ambiguous branch", reasons: ["ambiguous request detected"] },
    { name: "too-little-detail branch", reasons: ["too little detail to route safely"] },
  ];

  for (const { name, reasons } of cases) {
    it(`stays within 3 sentences and carries no internal prose (${name})`, () => {
      const response = buildClarificationResponse(makeInput(clarificationTriage(reasons)));
      expect(countSentences(response)).toBeLessThanOrEqual(3);
      for (const forbidden of FORBIDDEN_SUBSTRINGS) {
        expect(response).not.toContain(forbidden);
      }
    });
  }
});
