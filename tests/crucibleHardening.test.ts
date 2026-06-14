import { describe, expect, it } from "vitest";
import { arbitratePlanWithCrucible } from "../src/orchestration/crucible";
import { createFakePlan, type PlannerInput } from "../src/orchestration/planner";
import type { SkepticFinding, SkepticReview } from "../src/orchestration/skeptic";
import { triageUserMessage } from "../src/orchestration/triage";
import { makeContextPack } from "./support/byokArbitraries";

const NOW = "2026-06-12T00:00:00.000Z";

function inputFor(prompt: string): PlannerInput {
  const triage = triageUserMessage(prompt);
  return { triage, contextPack: makeContextPack(triage, prompt), messageContent: prompt };
}

function finding(overrides: Partial<SkepticFinding> = {}): SkepticFinding {
  return {
    id: "finding-1",
    severity: "MAJOR",
    category: "validation",
    message: "Validation gap.",
    evidence: "missing validation",
    recommendation: "Add validation.",
    ...overrides,
  };
}

function review(findings: SkepticFinding[], verdict: SkepticReview["verdict"] = "NEEDS_REVISION"): SkepticReview {
  return { verdict, findings, planGoal: "Plan for test", createdAt: NOW };
}

describe("crucible hardening", () => {
  it("accepted decisions include a policy trace and accepted plan", () => {
    const plan = createFakePlan(inputFor("Explain Rector."));

    const decision = arbitratePlanWithCrucible({
      plannerOutput: plan,
      skepticReview: review([], "SOUND"),
      now: () => NOW,
    });

    expect(decision.verdict).toBe("ACCEPTED");
    expect(decision.acceptedPlan).toEqual(plan);
    expect(decision.trace?.reasonCode).toBe("SOUND_REVIEW_ACCEPTED");
    expect(decision.trace?.policy).toContain("accepted only without blockers");
  });

  it("routes repairable major findings to targeted revision before max rounds", () => {
    const plan = createFakePlan(inputFor("Explain Rector."));
    const major = finding();

    const decision = arbitratePlanWithCrucible({ plannerOutput: plan, skepticReview: review([major]), round: 1, now: () => NOW });

    expect(decision.verdict).toBe("NEEDS_REVISION");
    expect(decision.revisionRequest?.targetedFindings).toEqual([major]);
    expect(decision.trace?.reasonCode).toBe("REPAIRABLE_FINDINGS_REVISION");
    expect(decision.trace?.targetedFindingIds).toEqual(["finding-1"]);
  });

  it("escalates findings that require an explicit human decision", () => {
    const plan = createFakePlan(inputFor("Explain Rector."));
    const approval = finding({
      id: "approval-1",
      category: "approval",
      message: "Approval decision is required.",
      recommendation: "Ask the operator for approval.",
    });

    const decision = arbitratePlanWithCrucible({ plannerOutput: plan, skepticReview: review([approval]), round: 1, now: () => NOW });

    expect(decision.verdict).toBe("ESCALATED");
    expect(decision.escalation?.findings).toEqual([approval]);
    expect(decision.trace?.reasonCode).toBe("HUMAN_DECISION_ESCALATED");
    expect(decision.trace?.humanDecisionRequired).toBe(true);
  });

  it("never accepts blocker findings", () => {
    const plan = createFakePlan(inputFor("Explain Rector."));
    const blocker = finding({ id: "blocker-1", severity: "BLOCKER", category: "dependency" });

    const decision = arbitratePlanWithCrucible({ plannerOutput: plan, skepticReview: review([blocker], "NEEDS_REVISION"), now: () => NOW });

    expect(decision.verdict).toBe("BLOCKED");
    expect(decision.acceptedPlan).toBeUndefined();
    expect(decision.trace?.reasonCode).toBe("BLOCKER_FINDINGS_BLOCKED");
  });
});
