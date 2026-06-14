import { describe, expect, it } from "vitest";

import {
  decomposeIntoTasks,
  executeDecomposedSubGoals,
  runLiveTaskDecomposer,
  stitchResults,
  type SubGoalGraph,
} from "../src/orchestration/taskDecomposer";
import { DEFAULT_SPY_USAGE, makeContextPack, SpyLLMProvider } from "./support/byokArbitraries";
import { triageUserMessage } from "../src/orchestration/triage";
import { WorkspaceSandboxAdapter } from "../src/sandbox";
import type { Run } from "../src/store/schemas";

function makeContext(prompt = "complex task") {
  const triage = triageUserMessage(prompt);
  return makeContextPack(triage, prompt);
}

function makeRun(): Run {
  return {
    id: "run-decompose-hardening",
    conversationId: "conv-1",
    userMessageId: "msg-1",
    status: "running",
    phase: "EXECUTING",
    route: "code",
    complexity: "high",
    budget: {
      maxUsd: 1,
      maxInputTokens: 1000,
      maxOutputTokens: 1000,
      maxModelCalls: 2,
      maxRuntimeMs: 30_000,
      maxHealingAttempts: 0,
      allowedProviders: [],
      approvalRequiredAboveUsd: 0,
    },
    costEstimate: { usd: 0 },
    actualCost: { usd: 0 },
    tokenEstimate: { input: 0, output: 0 },
    actualTokens: { input: 0, output: 0 },
    traceId: "trace-decompose-hardening",
    attempts: 1,
    healingAttempts: 0,
    validationAttempts: 0,
    createdAt: "2026-06-12T00:00:00.000Z",
    updatedAt: "2026-06-12T00:00:00.000Z",
  };
}

function makeSandbox(): WorkspaceSandboxAdapter {
  return new WorkspaceSandboxAdapter({
    workspaceRoot: process.cwd(),
    allowlistedCommands: [],
    approvals: [],
  });
}

describe("task decomposer hardening", () => {
  it("parses bullets before sentence splitting and preserves order", () => {
    const { subGoals, subGoalGraph } = decomposeIntoTasks(
      [
        "- Inspect the API handlers for the existing pagination pattern",
        "- Update the user endpoint implementation with bounded changes",
        "- Add focused tests for pagination behavior",
      ].join("\n"),
      makeContext("Add pagination"),
    );

    expect(subGoals).toEqual([
      "Inspect the API handlers for the existing pagination pattern",
      "Update the user endpoint implementation with bounded changes",
      "Add focused tests for pagination behavior",
    ]);
    expect(subGoalGraph.trace).toContain("parsed explicit bullet/numbered list");
  });

  it("does not parallelize dependent goals", async () => {
    const { subGoalGraph } = decomposeIntoTasks(
      [
        "Inspect the existing authentication flow carefully.",
        "Then update the login handler with the smallest safe change.",
        "After that validate the login tests and report failures.",
      ].join("\n"),
      makeContext("Fix login"),
      { maxConcurrency: 4 },
    );
    expect(subGoalGraph.dependencies.map((edge) => `${edge.from}->${edge.to}`)).toEqual(["sub-0->sub-1", "sub-1->sub-2"]);

    let active = 0;
    let maxActive = 0;
    const results = await executeDecomposedSubGoals(subGoalGraph, {
      sandbox: makeSandbox(),
      run: makeRun(),
      maxConcurrency: 4,
      executeSubGoal: async (goal, index) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return { subGoal: goal.goal, artifact: `sub-goal-${index}`, summary: "ok", status: "SUCCESS" };
      },
    });

    expect(results.map((result) => result.status)).toEqual(["SUCCESS", "SUCCESS", "SUCCESS"]);
    expect(maxActive).toBe(1);
  });

  it("honors max concurrency for independent goals", async () => {
    const graph: SubGoalGraph = {
      subGoals: Array.from({ length: 5 }, (_, index) => ({
        id: `sub-${index}`,
        goal: `Independent goal ${index} with enough detail`,
        dependencies: [],
        expectedArtifacts: ["Sub-goal result"],
        validation: ["Done"],
        parallelizable: true,
      })),
      dependencies: [],
      maxConcurrency: 2,
      trace: [],
    };
    let active = 0;
    let maxActive = 0;

    const results = await executeDecomposedSubGoals(graph, {
      sandbox: makeSandbox(),
      run: makeRun(),
      executeSubGoal: async (goal, index) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 3));
        active -= 1;
        return { subGoal: goal.goal, artifact: `sub-goal-${index}`, summary: "ok", status: "SUCCESS" };
      },
    });

    expect(results).toHaveLength(5);
    expect(results.every((result) => result.status === "SUCCESS")).toBe(true);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("stitches partial failures without hiding successful sub-goals", async () => {
    const graph: SubGoalGraph = {
      subGoals: [
        {
          id: "sub-0",
          goal: "Independent success goal with useful detail",
          dependencies: [],
          expectedArtifacts: ["Success artifact"],
          validation: ["Done"],
          parallelizable: true,
        },
        {
          id: "sub-1",
          goal: "Independent failing goal with useful detail",
          dependencies: [],
          expectedArtifacts: ["Failure artifact"],
          validation: ["Done"],
          parallelizable: true,
        },
      ],
      dependencies: [],
      maxConcurrency: 2,
      trace: [],
    };

    const results = await executeDecomposedSubGoals(graph, {
      sandbox: makeSandbox(),
      run: makeRun(),
      executeSubGoal: async (goal, index) => {
        if (index === 1) throw new Error("simulated sub-goal failure");
        return { subGoal: goal.goal, artifact: `sub-goal-${index}`, summary: "completed", status: "SUCCESS" };
      },
    });

    expect(results.map((result) => result.status)).toEqual(["SUCCESS", "FAILED"]);
    const stitched = stitchResults(results);
    expect(stitched).toContain("sub-goal-0 [SUCCESS]");
    expect(stitched).toContain("sub-goal-1 [FAILED]");
    expect(stitched).toContain("simulated sub-goal failure");
  });

  it("applies the risk-based sub-goal cap to live decomposer output", async () => {
    const context = makeContext("Delete generated files, update code, and validate the destructive change");
    expect(context.triage.riskFlags).toContain("destructive_change");
    const liveGraph: SubGoalGraph = {
      subGoals: Array.from({ length: 5 }, (_, index) => ({
        id: `sub-${index}`,
        goal: `Live destructive goal ${index} with enough detail`,
        dependencies: [],
        expectedArtifacts: ["Sub-goal result"],
        validation: ["Done"],
        parallelizable: true,
      })),
      dependencies: [],
      maxConcurrency: 4,
      trace: [],
    };
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [{ content: JSON.stringify(liveGraph) }],
    });

    const result = await runLiveTaskDecomposer(
      { distilled: "delete generated files, update code, validate", context, maxSubGoals: 5 },
      { provider, run: makeRun() },
    );

    expect(result.status).toBe("ok");
    expect(result.subGoalGraph.subGoals).toHaveLength(3);
    expect(result.subGoalGraph.trace).toContain("capped sub-goals at 3");
  });
});
