import { describe, it, expect } from "vitest";
import { createFakePlan, type PlannerInput, type PlannerOutput } from "../src/orchestration/planner";
import { reviewPlanWithSkeptic, SkepticReviewSchema } from "../src/orchestration/skeptic";
import { triageUserMessage, type TriageResult } from "../src/orchestration/triage";
import type { ContextPack } from "../src/orchestration/contextBuilder";

function contextPackFor(triage: TriageResult, intent = "Test user intent"): ContextPack {
  return {
    id: "ctx-skeptic-test",
    createdAt: "2026-01-01T00:00:00.000Z",
    userIntentSummary: intent,
    conversationRef: { id: "conv-test", title: "Skeptic test", workspaceId: "local" },
    messageRefs: [
      {
        id: "msg-test",
        role: "user",
        status: "completed",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    relevantDocs: [],
    relevantMemory: [],
    constraints: ["No provider calls in fake skeptic tests"],
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

describe("skeptic review", () => {
  it("returns SOUND for a valid low-risk plan", () => {
    const { review } = reviewed("Explain the vertical slice?");

    expect(() => SkepticReviewSchema.parse(review)).not.toThrow();
    expect(review.verdict).toBe("SOUND");
    expect(review.findings).toEqual([]);
    expect(review.planGoal).toContain("Explain the vertical slice");
  });

  it("flags missing top-level or task validation", () => {
    const { plan, contextPack } = reviewed("Explain the vertical slice?");
    const invalid = {
      ...plan,
      validation: { summary: "", checks: [] },
      tasks: plan.tasks.map((task) => ({ ...task, validation: [] })),
    };

    const review = reviewPlanWithSkeptic(invalid, contextPack);

    expect(review.verdict).toBe("NEEDS_REVISION");
    expect(review.findings.some((finding) => finding.category === "validation" && finding.taskId)).toBe(true);
    expect(review.findings.some((finding) => finding.category === "validation" && !finding.taskId)).toBe(true);
  });

  it("blocks dangling dependency references", () => {
    const { plan, contextPack } = reviewed("Create an implementation plan for adding login, but do not edit files.");
    const danglingPlanDependency: PlannerOutput = {
      ...plan,
      dependencies: [{ from: plan.tasks[0].id, to: "missing-task", reason: "Missing target should block execution" }],
    };

    const planDependencyReview = reviewPlanWithSkeptic(danglingPlanDependency, contextPack);

    expect(planDependencyReview.verdict).toBe("BLOCKED");
    expect(planDependencyReview.findings).toContainEqual(
      expect.objectContaining({ severity: "BLOCKER", category: "dependency", evidence: expect.stringContaining("missing-task") })
    );

    const danglingTaskDependency: PlannerOutput = {
      ...plan,
      tasks: plan.tasks.map((task, index) =>
        index === 0 ? { ...task, dependencies: ["missing-task-dependency"] } : task
      ),
    };

    const taskDependencyReview = reviewPlanWithSkeptic(danglingTaskDependency, contextPack);

    expect(taskDependencyReview.verdict).toBe("BLOCKED");
    expect(taskDependencyReview.findings).toContainEqual(
      expect.objectContaining({ severity: "BLOCKER", category: "dependency", evidence: expect.stringContaining("missing-task-dependency") })
    );
  });

  it("blocks unsafe high-risk tasks without an approval gate", () => {
    const { plan, contextPack } = reviewed("Build the entire feature end-to-end, run all tests, benchmark, iterate, and deploy.");
    const invalid: PlannerOutput = {
      ...plan,
      approvalGates: [],
      tasks: plan.tasks.map((task) =>
        task.risk === "high" ? { ...task, approvalRequired: false, risk: "high" } : task
      ),
    };

    const review = reviewPlanWithSkeptic(invalid, contextPack);

    expect(review.verdict).toBe("BLOCKED");
    expect(review.findings.some((finding) => finding.severity === "BLOCKER" && finding.category === "approval"))
      .toBe(true);
  });

  it("blocks empty task lists without a clarification gate", () => {
    const { plan, contextPack } = reviewed("Create an implementation plan for adding login, but do not edit files.");
    const invalid: PlannerOutput = { ...plan, tasks: [], approvalGates: [] };

    const review = reviewPlanWithSkeptic(invalid, contextPack);

    expect(review.verdict).toBe("BLOCKED");
    expect(review.findings).toContainEqual(
      expect.objectContaining({ severity: "BLOCKER", category: "clarification" })
    );
  });

  it("flags low risk plans that contain risky implementation language", () => {
    const { plan, contextPack } = reviewed("Explain the vertical slice?");
    const underestimated: PlannerOutput = {
      ...plan,
      riskLevel: "low",
      tasks: [
        {
          ...plan.tasks[0],
          description: "Edit code and deploy the change to production.",
          risk: "low",
        },
      ],
    };

    const review = reviewPlanWithSkeptic(underestimated, contextPack);

    expect(review.verdict).toBe("NEEDS_REVISION");
    expect(review.findings.some((finding) => finding.category === "risk" && finding.taskId === plan.tasks[0].id)).toBe(
      true
    );
  });

  it("flags assumed files that are absent from the context pack", () => {
    const { plan, contextPack } = reviewed("Explain the vertical slice?");
    const unsupported = {
      ...plan,
      assumptions: [...plan.assumptions, "Assume src/missing-module.ts exists and exposes MissingApi."],
    };

    const review = reviewPlanWithSkeptic(unsupported, contextPack);

    expect(review.verdict).toBe("NEEDS_REVISION");
    expect(review.findings).toContainEqual(
      expect.objectContaining({ category: "context", evidence: expect.stringContaining("src/missing-module.ts") })
    );
  });
});
