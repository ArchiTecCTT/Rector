import { describe, it, expect } from "vitest";

import {
  decomposeIntoTasks,
  executeDecomposedSubGoals,
  stitchResults,
} from "../src/orchestration/taskDecomposer";
import { makeContextPack } from "./support/byokArbitraries";
import { triageUserMessage } from "../src/orchestration/triage";
import { WorkspaceSandboxAdapter } from "../src/sandbox";
import type { Run } from "../src/store/schemas";

describe("taskDecomposer", () => {
  it("decomposeIntoTasks splits distilled text and caps at four sub-goals", () => {
    const triage = triageUserMessage("complex task");
    const context = makeContextPack(triage);
    const distilled = [
      "First sub goal is to inspect the repository layout carefully.",
      "Second sub goal is to run the unit test suite for regressions.",
      "Third sub goal is to update the documentation for the API surface.",
      "Fourth sub goal is to prepare a deployment checklist for staging.",
      "Fifth sub goal should be dropped because only four are kept.",
    ].join("\n");

    const { subGoals } = decomposeIntoTasks(distilled, context);

    expect(subGoals).toHaveLength(4);
    expect(subGoals[0]).toContain("inspect the repository");
    expect(subGoals[3]).toContain("deployment checklist");
  });

  it("stitchResults formats concurrent sub-goal summaries", () => {
    const stitched = stitchResults([
      { subGoal: "a", artifact: "sub-goal-0", summary: "completed (SUCCESS)", status: "SUCCESS" },
      { subGoal: "b", artifact: "sub-goal-1", summary: "completed (SUCCESS)", status: "SUCCESS" },
    ]);

    expect(stitched).toContain("sub-goal-0");
    expect(stitched).toContain("sub-goal-1");
    expect(stitched.split("\n")).toHaveLength(2);
  });

  it("executeDecomposedSubGoals runs each sub-goal through the sandbox concurrently", async () => {
    const sandbox = new WorkspaceSandboxAdapter({
      workspaceRoot: process.cwd(),
      allowlistedCommands: [],
      approvals: [],
    });

    const run: Run = {
      id: "run-decompose-test",
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
      traceId: "trace-decompose",
      attempts: 1,
      healingAttempts: 0,
      validationAttempts: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const subGoals = [
      "Inspect the workspace for pending migrations.",
      "Validate the sandbox executor artifact shape.",
    ];

    const results = await executeDecomposedSubGoals(subGoals, { sandbox, run, now: () => "2026-06-10T00:00:00.000Z" });

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === "SUCCESS")).toBe(true);
    expect(stitchResults(results)).toContain("sub-goal-0");
  });
});