import { describe, it, expect } from "vitest";
import { createFakePlan, type PlannerInput, type PlannerOutput } from "../src/orchestration/planner";
import {
  arbitratePlanWithCrucible,
  CrucibleDecisionSchema,
  type CrucibleDecision,
} from "../src/orchestration/crucible";
import { reviewPlanWithSkeptic, type SkepticFinding, type SkepticReview } from "../src/orchestration/skeptic";
import { triageUserMessage, type TriageResult } from "../src/orchestration/triage";
import type { ContextPack } from "../src/orchestration/contextBuilder";

const NOW = "2026-01-01T00:00:00.000Z";

function contextPackFor(triage: TriageResult, intent = "Test user intent"): ContextPack {
  return {
    id: "ctx-crucible-test",
    createdAt: NOW,
    userIntentSummary: intent,
    conversationRef: { id: "conv-test", title: "Crucible test", workspaceId: "local" },
    messageRefs: [
      {
        id: "msg-test",
        role: "user",
        status: "completed",
        createdAt: NOW,
      },
    ],
    relevantDocs: [],
    relevantMemory: [],
    constraints: ["No provider calls in fake Crucible tests"],
    availableProviders: { configured: [], unavailable: [], notes: [] },
    availableTools: { names: [], notes: [] },
    riskFlags: triage.riskFlags,
    triage,
    artifactHandles: [],
    inlineContext: [
      {
        kind: "chat-user-message",
        summary: intent,
        content: intent,
        hash: "hash-test",
        sizeBytes: intent.length,
      },
    ],
  };
}

function inputFor(content: string): PlannerInput {
  const triage = triageUserMessage(content);
  return {
    triage,
    contextPack: contextPackFor(triage, content),
    messageContent: content,
  };
}

function reviewed(content: string) {
  const input = inputFor(content);
  const plan = createFakePlan(input);
  return { plan, review: reviewPlanWithSkeptic(plan, input.contextPack), contextPack: input.contextPack };
}

function majorFinding(overrides: Partial<SkepticFinding> = {}): SkepticFinding {
  return {
    id: "skeptic.validation.1",
    severity: "MAJOR",
    taskId: "answer.synthesize",
    category: "validation",
    message: "Task is missing validation criteria.",
    evidence: "[]",
    recommendation: "Add concrete validation checks.",
    ...overrides,
  };
}

function reviewWith(findings: SkepticFinding[], verdict: SkepticReview["verdict"] = "NEEDS_REVISION"): SkepticReview {
  return {
    verdict,
    findings,
    planGoal: "Plan for test",
    createdAt: NOW,
  };
}

describe("crucible arbitration", () => {
  it("accepts a sound skeptic review and returns the original plan", () => {
    const { plan, review } = reviewed("Explain the vertical slice?");

    const decision = arbitratePlanWithCrucible({ plannerOutput: plan, skepticReview: review, now: () => NOW });

    expect(() => CrucibleDecisionSchema.parse(decision)).not.toThrow();
    expect(decision.verdict).toBe("ACCEPTED");
    expect(decision.acceptedPlan).toEqual(plan);
    expect(decision.revisionRequest).toBeUndefined();
    expect(decision.blockerFindings).toEqual([]);
    expect(decision.round).toBe(1);
    expect(decision.maxRounds).toBe(2);
    expect(decision.createdAt).toBe(NOW);
  });

  it("blocks when skeptic verdict is blocked or findings include blockers", () => {
    const { plan } = reviewed("Explain the vertical slice?");
    const blocker = majorFinding({
      id: "skeptic.dependency.1",
      severity: "BLOCKER",
      category: "dependency",
      message: "Plan dependency references a missing target task.",
      evidence: "missing-task",
      recommendation: "Remove the dangling dependency or add the referenced target task.",
    });

    const decision = arbitratePlanWithCrucible({
      plannerOutput: plan,
      skepticReview: reviewWith([blocker], "NEEDS_REVISION"),
      now: () => NOW,
    });

    expect(decision.verdict).toBe("BLOCKED");
    expect(decision.reason).toContain("BLOCKER");
    expect(decision.blockerFindings).toEqual([blocker]);
    expect(decision.acceptedPlan).toBeUndefined();
    expect(decision.revisionRequest).toBeUndefined();
  });

  it("requests revision for major or minor findings during round 1", () => {
    const { plan } = reviewed("Explain the vertical slice?");
    const major = majorFinding();
    const minor = majorFinding({
      id: "skeptic.context.2",
      severity: "MINOR",
      category: "context",
      message: "Plan could cite context more precisely.",
      evidence: "context note",
      recommendation: "Reference the exact context artifact.",
    });

    const decision = arbitratePlanWithCrucible({
      plannerOutput: plan,
      skepticReview: reviewWith([major, minor]),
      round: 1,
      now: () => NOW,
    });

    expect(decision.verdict).toBe("NEEDS_REVISION");
    expect(decision.revisionRequest?.targetedFindings).toEqual([major, minor]);
    expect(decision.revisionRequest?.requiredChanges).toEqual([
      "Add concrete validation checks.",
      "Reference the exact context artifact.",
    ]);
    expect(decision.acceptedPlan).toBeUndefined();
  });

  it("escalates major or minor findings after the second round is exhausted", () => {
    const { plan } = reviewed("Explain the vertical slice?");
    const finding = majorFinding({ severity: "MINOR", recommendation: "Clarify the validation wording." });

    const decision = arbitratePlanWithCrucible({
      plannerOutput: plan,
      skepticReview: reviewWith([finding]),
      round: 2,
      now: () => NOW,
    });

    expect(decision.verdict).toBe("ESCALATED");
    expect(decision.reason).toContain("max revision rounds");
    expect(decision.escalation?.findings).toEqual([finding]);
    expect(decision.escalation?.exhaustedRounds).toBe(true);
    expect(decision.revisionRequest).toBeUndefined();
  });

  it("bounds max rounds and clamps requested rounds to the two-round limit", () => {
    const { plan } = reviewed("Explain the vertical slice?");

    const decision: CrucibleDecision = arbitratePlanWithCrucible({
      plannerOutput: plan,
      skepticReview: reviewWith([majorFinding()]),
      round: 99,
      now: () => NOW,
    });

    expect(decision.maxRounds).toBe(2);
    expect(decision.round).toBe(2);
    expect(decision.verdict).toBe("ESCALATED");
  });

  it("derives the next bounded round from priorRounds", () => {
    const { plan } = reviewed("Explain the vertical slice?");

    const decision = arbitratePlanWithCrucible({
      plannerOutput: plan,
      skepticReview: reviewWith([majorFinding()]),
      priorRounds: 9,
      now: () => NOW,
    });

    expect(decision.round).toBe(2);
    expect(decision.maxRounds).toBe(2);
    expect(decision.verdict).toBe("ESCALATED");
  });

  it("does not mutate the planner output while preparing a revision request", () => {
    const { plan } = reviewed("Explain the vertical slice?");
    const before: PlannerOutput = structuredClone(plan);

    arbitratePlanWithCrucible({ plannerOutput: plan, skepticReview: reviewWith([majorFinding()]), now: () => NOW });

    expect(plan).toEqual(before);
  });

  it("blocks when skeptic verdict is BLOCKED but has no BLOCKER findings, returning BLOCKED with empty blockerFindings", () => {
    const { plan } = reviewed("Explain the vertical slice?");

    const decision = arbitratePlanWithCrucible({
      plannerOutput: plan,
      skepticReview: reviewWith([], "BLOCKED"),
      now: () => NOW,
    });

    expect(() => CrucibleDecisionSchema.parse(decision)).not.toThrow();
    expect(decision.verdict).toBe("BLOCKED");
    expect(decision.reason).toBe("Crucible blocked execution because the skeptic review verdict is BLOCKED.");
    expect(decision.blockerFindings).toEqual([]);
    expect(decision.acceptedPlan).toBeUndefined();
    expect(decision.revisionRequest).toBeUndefined();
    expect(decision.escalation).toBeUndefined();
  });

  describe("CrucibleDecisionSchema validation with superRefine", () => {
    it("fails validation if ACCEPTED lacks acceptedPlan", () => {
      const invalidDecision = {
        verdict: "ACCEPTED",
        reason: "Crucible accepted",
        blockerFindings: [],
        round: 1,
        maxRounds: 2,
        createdAt: NOW,
      };
      expect(() => CrucibleDecisionSchema.parse(invalidDecision)).toThrow("acceptedPlan is required when verdict is ACCEPTED");
    });

    it("fails validation if NEEDS_REVISION lacks revisionRequest", () => {
      const invalidDecision = {
        verdict: "NEEDS_REVISION",
        reason: "Crucible needs revision",
        blockerFindings: [],
        round: 1,
        maxRounds: 2,
        createdAt: NOW,
      };
      expect(() => CrucibleDecisionSchema.parse(invalidDecision)).toThrow("revisionRequest is required when verdict is NEEDS_REVISION");
    });

    it("fails validation if ESCALATED lacks escalation", () => {
      const invalidDecision = {
        verdict: "ESCALATED",
        reason: "Crucible escalated",
        blockerFindings: [],
        round: 1,
        maxRounds: 2,
        createdAt: NOW,
      };
      expect(() => CrucibleDecisionSchema.parse(invalidDecision)).toThrow("escalation is required when verdict is ESCALATED");
    });

    it("fails validation if BLOCKED lacks reason", () => {
      const invalidDecision = {
        verdict: "BLOCKED",
        reason: "",
        blockerFindings: [],
        round: 1,
        maxRounds: 2,
        createdAt: NOW,
      };
      expect(() => CrucibleDecisionSchema.parse(invalidDecision)).toThrow();
    });
  });
});
