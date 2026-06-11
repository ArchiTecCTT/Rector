import { describe, it, expect } from "vitest";
import {
  createFakePlan,
  PlannerOutputSchema,
  validatePlannerOutput,
  type PlannerInput,
  type PlannerOutput,
} from "../src/orchestration/planner";
import { triageUserMessage, TRIAGE_ROUTES, type TriageResult } from "../src/orchestration/triage";
import type { ContextPack } from "../src/orchestration/contextBuilder";

function contextPackFor(triage: TriageResult, intent = "Test user intent"): ContextPack {
  return {
    id: "ctx-test",
    createdAt: "2026-01-01T00:00:00.000Z",
    userIntentSummary: intent,
    conversationRef: { id: "conv-test", title: "Planner test", workspaceId: "local" },
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
    constraints: ["No provider calls in fake planner tests"],
    availableProviders: { configured: [], unavailable: [], notes: [] },
    availableTools: { names: [], notes: [] },
    riskFlags: triage.riskFlags,
    triage,
    artifactHandles: [],
    inlineContext: [],
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

describe("planner schema and fake planner", () => {
  it("creates a valid deterministic plan", () => {
    const plan = createFakePlan(inputFor("What is Rector?"));

    expect(() => PlannerOutputSchema.parse(plan)).not.toThrow();
    expect(plan.goal).toContain("What is Rector?");
    expect(plan.validation.checks.length).toBeGreaterThan(0);
    expect(plan.tasks.length).toBe(1);
    expect(plan.tasks[0].validation.length).toBeGreaterThan(0);
  });

  it("rejects planner output with missing top-level validation", () => {
    const plan = createFakePlan(inputFor("What is Rector?"));
    const invalid = { ...plan } as Partial<PlannerOutput>;
    delete invalid.validation;

    expect(() => validatePlannerOutput(invalid)).toThrow(/validation/i);
  });

  it("rejects unsafe actions without an approval gate", () => {
    const plan = createFakePlan(inputFor("Delete obsolete files in src and update tests."));
    const invalid: PlannerOutput = {
      ...plan,
      approvalGates: [],
      tasks: plan.tasks.map((task) => ({ ...task, approvalRequired: false })),
    };

    expect(() => validatePlannerOutput(invalid)).toThrow(/approval gate/i);
  });

  it("creates route-specific outputs", () => {
    const direct = createFakePlan(inputFor("Explain the vertical slice?"));
    expect(direct.tasks.map((task) => task.id)).toEqual(["answer.synthesize"]);
    expect(direct.riskLevel).toBe("low");

    const planOnly = createFakePlan(inputFor("Create an implementation plan for adding login, but do not edit files."));
    expect(planOnly.tasks.map((task) => task.id)).toContain("plan.document");
    expect(planOnly.assumptions).toContain("User requested planning only; no file edits should be executed.");

    const codeEdit = createFakePlan(inputFor("Fix the TypeScript bug in src/api/server.ts and update tests."));
    expect(codeEdit.tasks.map((task) => task.id)).toEqual(["code.inspect", "code.edit", "code.validate"]);
    expect(codeEdit.dependencies).toContainEqual({ from: "code.inspect", to: "code.edit" });
    expect(codeEdit.dependencies).toContainEqual({ from: "code.edit", to: "code.validate" });

    const research = createFakePlan(inputFor("Research current options for vector databases and compare sources."));
    expect(research.tasks.map((task) => task.id)).toEqual(["research.gather", "research.synthesize", "research.cite"]);
    expect(research.tasks.some((task) => task.expectedArtifacts.includes("Cited source list"))).toBe(true);

    const longRunning = createFakePlan(
      inputFor("Build the entire feature end-to-end, run all tests, benchmark, iterate, and deploy.")
    );
    expect(longRunning.tasks.map((task) => task.id)).toContain("long.checkpoint");
    expect(longRunning.approvalGates.length).toBeGreaterThan(0);
    expect(longRunning.approvalGates.some((gate) => gate.required)).toBe(true);

    const clarification = createFakePlan(inputFor("Can you do the thing?"));
    expect(clarification.tasks).toEqual([]);
    expect(clarification.approvalGates.map((gate) => gate.type)).toContain("clarification");
  });

  it("rejects planner output with dangling dependency references", () => {
    const plan = createFakePlan(inputFor("Fix the TypeScript bug in src/api/server.ts and update tests."));
    // Validate that the base plan is valid first
    expect(() => validatePlannerOutput(plan)).not.toThrow();

    // 1. Dangling top-level dependency (missing source task/from)
    const invalidTopLevelFrom: PlannerOutput = {
      ...plan,
      dependencies: [{ from: "non-existent-source", to: "code.edit" }],
    };
    expect(() => validatePlannerOutput(invalidTopLevelFrom)).toThrow(
      /Planner dependency references missing source task: non-existent-source/
    );

    // 2. Dangling top-level dependency (missing target task/to)
    const invalidTopLevelTo: PlannerOutput = {
      ...plan,
      dependencies: [{ from: "code.inspect", to: "non-existent-target" }],
    };
    expect(() => validatePlannerOutput(invalidTopLevelTo)).toThrow(
      /Planner dependency references missing target task: non-existent-target/
    );

    // 3. Dangling task-level dependency (taskItem.dependencies references missing task)
    const invalidTaskLevel: PlannerOutput = {
      ...plan,
      tasks: plan.tasks.map((task) => {
        if (task.id === "code.edit") {
          return {
            ...task,
            dependencies: ["non-existent-task-dep"],
          };
        }
        return task;
      }),
    };
    expect(() => validatePlannerOutput(invalidTaskLevel)).toThrow(
      /Planner task code.edit references missing dependency: non-existent-task-dep/
    );
  });

  it("supports direct construction from explicit clarification triage", () => {
    const triage: TriageResult = {
      route: TRIAGE_ROUTES.NEEDS_CLARIFICATION,
      confidence: 0.9,
      complexity: "low",
      reasons: ["test"],
      riskFlags: ["ambiguous_request"],
    };

    const plan = createFakePlan({ triage, contextPack: contextPackFor(triage), intent: "Need user decision" });
    expect(plan.tasks).toHaveLength(0);
    expect(plan.validation.checks).toContain("Wait for explicit user clarification before execution");
  });
});
