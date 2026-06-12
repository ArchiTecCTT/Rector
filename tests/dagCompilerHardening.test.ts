import { describe, expect, it } from "vitest";
import { compileAcceptedPlanToDag, validateCompiledDag } from "../src/orchestration/dagCompiler";
import type { CrucibleDecision } from "../src/orchestration/crucible";
import { createFakePlan, type PlannerInput, type PlannerOutput } from "../src/orchestration/planner";
import { triageUserMessage } from "../src/orchestration/triage";
import { DagSchema } from "../src/protocol/dag";
import { makeContextPack } from "./support/byokArbitraries";

const NOW = "2026-06-12T00:00:00.000Z";

function inputFor(prompt: string): PlannerInput {
  const triage = triageUserMessage(prompt);
  return { triage, contextPack: makeContextPack(triage, prompt), messageContent: prompt };
}

function acceptedDecision(plan: PlannerOutput): CrucibleDecision {
  return {
    verdict: "ACCEPTED",
    reason: "accepted for hardening test",
    acceptedPlan: plan,
    blockerFindings: [],
    round: 1,
    maxRounds: 2,
    createdAt: NOW,
  };
}

describe("DAG compiler hardening", () => {
  it("rejects cyclic planner dependencies before compilation", () => {
    const base = createFakePlan(inputFor("Create an implementation plan for adding login, but do not edit files."));
    const cyclic: PlannerOutput = {
      ...base,
      tasks: [
        { ...base.tasks[0], id: "task.a", dependencies: ["task.b"] },
        { ...base.tasks[1], id: "task.b", dependencies: ["task.a"] },
      ],
      dependencies: [
        { from: "task.a", to: "task.b" },
        { from: "task.b", to: "task.a" },
      ],
    };

    expect(() => compileAcceptedPlanToDag({ runId: "run-cycle", crucibleDecision: acceptedDecision(cyclic), now: () => NOW })).toThrow(/cycle/i);
  });

  it("rejects accepted plans with missing task validation", () => {
    const plan = createFakePlan(inputFor("Explain Rector."));
    const invalid = {
      ...plan,
      tasks: plan.tasks.map((task) => ({ ...task, validation: [] })),
    } as PlannerOutput;

    expect(() => compileAcceptedPlanToDag({ runId: "run-validation", crucibleDecision: acceptedDecision(invalid), now: () => NOW })).toThrow(/validation/i);
  });

  it("emits executable policy metadata and validates under the DAG schema", () => {
    const plan = createFakePlan(inputFor("Fix src/api/server.ts and update tests."));
    const dag = compileAcceptedPlanToDag({ runId: "run-policy", crucibleDecision: acceptedDecision(plan), now: () => NOW });

    expect(() => DagSchema.parse(dag)).not.toThrow();
    expect(validateCompiledDag(dag)).toEqual({ valid: true, errors: [] });

    const taskNode = dag.nodes.find((node) => node.id === "task:code.edit");
    const validationNode = dag.nodes.find((node) => node.id === "validate:code.edit");

    expect(taskNode?.metadata?.capabilityPolicy).toMatchObject({ default: "deny", allowShell: false });
    expect(taskNode?.metadata?.validationContract).toMatchObject({ required: true });
    expect(taskNode?.metadata?.timeoutPolicy).toBeDefined();
    expect(validationNode?.metadata?.validationContract).toMatchObject({ required: true, targetNodeId: "task:code.edit" });
  });

  it("detects missing explicit edges for node dependencies", () => {
    const plan = createFakePlan(inputFor("Fix src/api/server.ts and update tests."));
    const dag = compileAcceptedPlanToDag({ runId: "run-edge", crucibleDecision: acceptedDecision(plan), now: () => NOW });
    const withoutEdges = { ...dag, edges: [] };

    const result = validateCompiledDag(withoutEdges);

    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("lacks an explicit edge");
  });

  it("blocks unsafe shell permissions by default", () => {
    const plan = createFakePlan(inputFor("Explain Rector."));
    const dag = compileAcceptedPlanToDag({ runId: "run-shell", crucibleDecision: acceptedDecision(plan), now: () => NOW });
    const unsafe = {
      ...dag,
      nodes: [
        ...dag.nodes,
        {
          id: "task:unsafe",
          type: "SHELL_COMMAND",
          dependsOn: [],
          toolPermissions: ["shell.command"],
          retryPolicy: { maxAttempts: 1, backoffMs: 0 },
          timeoutMs: 1000,
          metadata: {
            kind: "planner-task",
            plannerTaskId: "unsafe",
            toolPolicy: { denied: ["unsafe.shell"], allowUnsafeShell: false },
            timeoutPolicy: { timeoutMs: 1000, retryPolicy: { maxAttempts: 1, backoffMs: 0 } },
            validationContract: { required: true, checks: ["no shell"], expectedArtifacts: [] },
            capabilityPolicy: { default: "deny", allowShell: false },
          },
        },
      ],
    };

    const result = validateCompiledDag(unsafe);

    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("unsafe shell permission is denied by default");
  });
});
