import { describe, expect, it } from "vitest";
import {
  compileAcceptedPlanToDag,
  validateCompiledDag,
  type DagCompilerInput,
} from "../src/orchestration/dagCompiler";
import { createFakePlan, type PlannerInput } from "../src/orchestration/planner";
import { type CrucibleDecision } from "../src/orchestration/crucible";
import { triageUserMessage, type TriageResult } from "../src/orchestration/triage";
import type { ContextPack } from "../src/orchestration/contextBuilder";

const NOW = "2026-01-01T00:00:00.000Z";

function contextPackFor(triage: TriageResult, intent = "Test user intent"): ContextPack {
  return {
    id: "ctx-dag-test",
    createdAt: NOW,
    userIntentSummary: intent,
    conversationRef: { id: "conv-test", title: "DAG test", workspaceId: "local" },
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
    constraints: ["No provider calls in DAG compiler tests"],
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

function acceptedDecisionFor(content: string): DagCompilerInput {
  const plan = createFakePlan(inputFor(content));
  const decision: CrucibleDecision = {
    verdict: "ACCEPTED",
    reason: "accepted for DAG compiler test",
    acceptedPlan: plan,
    blockerFindings: [],
    round: 1,
    maxRounds: 2,
    createdAt: NOW,
  };

  return { runId: "run-dag-test", crucibleDecision: decision, now: () => NOW };
}

describe("DAG compiler", () => {
  it("compiles an accepted CODE_EDIT plan into task nodes and dependency edges", () => {
    const compiledDag = compileAcceptedPlanToDag(
      acceptedDecisionFor("Fix the TypeScript bug in src/api/server.ts and update tests.")
    );

    expect(compiledDag.runId).toBe("run-dag-test");
    expect(compiledDag.nodes.map((node) => node.id)).toEqual(expect.arrayContaining([
      "task:code.inspect",
      "task:code.edit",
      "task:code.validate",
    ]));
    expect(compiledDag.edges).toEqual(expect.arrayContaining([
      { from: "task:code.inspect", to: "task:code.edit" },
      { from: "task:code.edit", to: "task:code.validate" },
    ]));
    expect(compiledDag.metadata?.plannerTaskToDagNode).toEqual({
      "code.inspect": "task:code.inspect",
      "code.edit": "task:code.edit",
      "code.validate": "task:code.validate",
    });
    expect(compiledDag.budgetPolicy).toMatchObject({ mode: "local-fake", riskLevel: "medium" });
    expect(validateCompiledDag(compiledDag)).toEqual({ valid: true, errors: [] });
  });

  it("compiles an accepted PLAN_ONLY plan into a safe local DAG", () => {
    const compiledDag = compileAcceptedPlanToDag(
      acceptedDecisionFor("Create an implementation plan for adding login, but do not edit files.")
    );

    expect(compiledDag.nodes.map((node) => node.id)).toEqual(expect.arrayContaining([
      "task:plan.inspect",
      "task:plan.document",
    ]));
    expect(compiledDag.edges).toContainEqual({ from: "task:plan.inspect", to: "task:plan.document" });
    expect(compiledDag.nodes.every((node) => node.type !== "SHELL_COMMAND")).toBe(true);
    expect(compiledDag.nodes.every((node) => !node.toolPermissions.includes("unsafe.shell"))).toBe(true);
    expect(validateCompiledDag(compiledDag).valid).toBe(true);
  });

  it("appends validation nodes and links them after task nodes", () => {
    const compiledDag = compileAcceptedPlanToDag(
      acceptedDecisionFor("Create an implementation plan for adding login, but do not edit files.")
    );

    const taskNode = compiledDag.nodes.find((node) => node.id === "task:plan.document");
    const validationNode = compiledDag.nodes.find((node) => node.id === "validate:plan.document");

    expect(taskNode).toBeDefined();
    expect(validationNode?.type).toBe("VALIDATION");
    expect(validationNode?.dependsOn).toContain("task:plan.document");
    expect(compiledDag.edges).toContainEqual({ from: "task:plan.document", to: "validate:plan.document" });
    expect(validationNode?.input?.checks).toEqual(expect.arrayContaining([
      "Plan includes ordered steps",
      "Plan includes validation and risk notes",
    ]));
  });

  it("rejects non-ACCEPTED Crucible decisions", () => {
    const input = acceptedDecisionFor("Explain the vertical slice?");
    const rejected: DagCompilerInput = {
      ...input,
      crucibleDecision: {
        verdict: "BLOCKED",
        reason: "blocked for test",
        blockerFindings: [],
        round: 1,
        maxRounds: 2,
        createdAt: NOW,
      },
    };

    expect(() => compileAcceptedPlanToDag(rejected)).toThrow(/ACCEPTED/);
  });

  it("validates duplicate, dangling, and cycle errors", () => {
    const compiledDag = compileAcceptedPlanToDag(acceptedDecisionFor("Explain the vertical slice?"));

    const duplicate = validateCompiledDag({
      ...compiledDag,
      nodes: [compiledDag.nodes[0], { ...compiledDag.nodes[0] }],
      edges: [],
    });
    expect(duplicate.valid).toBe(false);
    expect(duplicate.errors.join("\n")).toContain("Duplicate node id");

    const dangling = validateCompiledDag({
      ...compiledDag,
      nodes: [{ ...compiledDag.nodes[0], dependsOn: ["missing-node"] }],
      edges: [],
    });
    expect(dangling.valid).toBe(false);
    expect(dangling.errors.join("\n")).toContain("missing dependency: missing-node");

    const cycle = validateCompiledDag({
      ...compiledDag,
      nodes: [
        { ...compiledDag.nodes[0], id: "task:a", dependsOn: ["task:b"], metadata: { kind: "planner-task", plannerTaskId: "a" } },
        { ...compiledDag.nodes[0], id: "task:b", dependsOn: ["task:a"], metadata: { kind: "planner-task", plannerTaskId: "b" } },
      ],
      edges: [],
    });
    expect(cycle.valid).toBe(false);
    expect(cycle.errors.join("\n")).toContain("Cycle detected");
  });

  it("requires validation coverage for every task node", () => {
    const compiledDag = compileAcceptedPlanToDag(acceptedDecisionFor("Explain the vertical slice?"));
    const withoutValidationNodes = {
      ...compiledDag,
      nodes: compiledDag.nodes.filter((node) => node.type !== "VALIDATION"),
      edges: compiledDag.edges.filter((edge) => !edge.to.startsWith("validate:")),
    };

    const result = validateCompiledDag(withoutValidationNodes);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("lacks validation coverage");
  });

  it("denies unsafe shell by default", () => {
    const compiledDag = compileAcceptedPlanToDag(
      acceptedDecisionFor("Fix the TypeScript bug in src/api/server.ts and update tests.")
    );
    const unsafe = {
      ...compiledDag,
      nodes: [
        ...compiledDag.nodes,
        {
          id: "task:unsafe-shell",
          type: "SHELL_COMMAND",
          label: "Unsafe shell",
          dependsOn: [],
          toolPermissions: ["unsafe.shell"],
          retryPolicy: { maxAttempts: 1, backoffMs: 0 },
          timeoutMs: 1000,
          metadata: { kind: "planner-task", plannerTaskId: "unsafe-shell" },
        },
      ],
    };

    expect(compiledDag.nodes.flatMap((node) => node.toolPermissions)).not.toContain("unsafe.shell");
    const result = validateCompiledDag(unsafe);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("unsafe shell permission is denied by default");
  });
});
