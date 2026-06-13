import nodePath from "node:path";
import { describe, expect, it, vi } from "vitest";

import { executeDagThroughSandbox } from "../src/orchestration/sandboxExecutor";
import { createAbortSignal, createRunControlState, requestInterrupt } from "../src/orchestration/runControl";
import { IterationBudget } from "../src/orchestration/turnBudget";
import { DagNodeSchema, DagSchema, type Dag, type DagNode } from "../src/protocol/dag";
import { FakeLLMProvider, invokeWithBudget } from "../src/providers";
import { WorkspaceSandboxAdapter, type CommandRunner } from "../src/sandbox";
import type { Budget, Run } from "../src/store";
import type { ToolEventSinkInput } from "../src/tools";

const FIXED_NOW = "2026-06-13T00:00:00.000Z";
const WORKSPACE_ROOT = nodePath.resolve("run-interrupt-fixture-root");

describe("run interrupt integration seams", () => {
  it("maps an interrupted run control signal to skipped DAG nodes without throwing", async () => {
    const runControl = createRunControlState("run-interrupt");
    requestInterrupt(runControl, "test stop");
    const dag = makeDag([
      makeNode({ id: "node-a", type: "VALIDATION", input: { command: "npm:test" } }),
      makeNode({ id: "node-b", type: "VALIDATION", dependsOn: ["node-a"], input: { command: "npm:test" } }),
    ]);

    const result = await executeDagThroughSandbox(dag, {
      sandbox: makeSandbox(),
      runControl,
      abortSignal: createAbortSignal(runControl),
    }, { now: () => FIXED_NOW });

    expect(result.status).toBe("SKIPPED");
    expect(result.nodeResults.map((node) => node.status)).toEqual(["SKIPPED", "SKIPPED"]);
    expect(result.nodeResults.every((node) => node.error?.code === "ABORTED")).toBe(true);
  });

  it("emits RUN_BUDGET_EXHAUSTED when the turn tool-call budget is exhausted", async () => {
    const events: ToolEventSinkInput[] = [];
    const turnBudget = new IterationBudget({ maxToolCalls: 1 });
    const dag = makeDag([
      makeNode({ id: "node-a", type: "VALIDATION", input: { command: "npm:test" } }),
      makeNode({ id: "node-b", type: "VALIDATION", input: { command: "npm:test" } }),
    ]);

    const result = await executeDagThroughSandbox(dag, {
      sandbox: makeSandbox(),
      turnBudget,
      appendRunEvent: (event) => events.push(event),
    }, { now: () => FIXED_NOW });

    expect(result.status).toBe("PARTIAL");
    expect(result.nodeResults.map((node) => node.status)).toEqual(["SUCCESS", "FAILED"]);
    expect(events.find((event) => event.type === "RUN_BUDGET_EXHAUSTED")).toMatchObject({
      phase: "EXECUTING",
      payload: {
        reason: "tool_call_budget_exhausted",
        toolCallsUsed: 1,
        toolCallsRemaining: 0,
      },
    });
  });

  it("passes abort signals to sandbox command execution and returns COMMAND_ABORTED", async () => {
    const commandRunner = vi.fn<CommandRunner>(async () => ({ exitCode: 0, stdout: "should not run", stderr: "" }));
    const sandbox = makeSandbox(commandRunner);
    const controller = new AbortController();
    controller.abort();

    const result = await sandbox.operate(
      { kind: "RUN_COMMAND", command: "npm:test", args: [] },
      { runId: "run-interrupt", nodeId: "node-a", abortSignal: controller.signal },
    );

    expect(result.status).toBe("DENIED");
    expect(result.denialReason).toBe("COMMAND_ABORTED");
    expect(commandRunner).not.toHaveBeenCalled();
  });

  it("invokeWithBudget accepts abortSignal and maps provider abort without network", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      invokeWithBudget(new FakeLLMProvider(), {
        messages: [{ role: "user", content: "stop before invoke" }],
        route: "DIRECT_ANSWER",
        task: "abort test",
        maxOutputTokens: 32,
      }, makeRun(), { abortSignal: controller.signal }),
    ).rejects.toMatchObject({
      code: "ABORTED",
      provider: "fake",
    });
  });
});

function makeSandbox(commandRunner?: CommandRunner): WorkspaceSandboxAdapter {
  return new WorkspaceSandboxAdapter({
    workspaceRoot: WORKSPACE_ROOT,
    allowlistedCommands: ["npm:test"],
    commandRunner: commandRunner ?? (async () => ({ exitCode: 0, stdout: "ok", stderr: "" })),
    now: () => FIXED_NOW,
  });
}

function makeNode(overrides: Partial<DagNode> & { id: string; type: DagNode["type"] }): DagNode {
  return DagNodeSchema.parse({ dependsOn: [], toolPermissions: [], expectedOutputs: [], ...overrides });
}

function makeDag(nodes: DagNode[]): Dag {
  const edges = nodes.slice(1).map((node, index) => ({ from: nodes[index].id, to: node.id }));
  return DagSchema.parse({
    id: "dag-run-interrupt",
    runId: "run-interrupt",
    version: "1",
    nodes,
    edges,
    createdAt: FIXED_NOW,
  });
}

function makeRun(): Run {
  return {
    id: "run-provider-abort",
    conversationId: "conv-provider-abort",
    userMessageId: "msg-provider-abort",
    status: "running",
    phase: "PLANNING",
    route: "DIRECT_ANSWER",
    complexity: "simple",
    budget: makeBudget(),
    costEstimate: { usd: 0, modelCalls: 0 },
    tokenEstimate: { input: 0, output: 0 },
    traceId: "trace-provider-abort",
    attempts: 0,
    healingAttempts: 0,
    validationAttempts: 0,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  };
}

function makeBudget(): Budget {
  return {
    maxUsd: 1,
    maxInputTokens: 10_000,
    maxOutputTokens: 5_000,
    maxModelCalls: 8,
    maxRuntimeMs: 60_000,
    maxHealingAttempts: 2,
    allowedProviders: [],
    approvalRequiredAboveUsd: 0,
  };
}
