import nodePath from "node:path";
import { describe, expect, it } from "vitest";

import { executeDagThroughSandbox } from "../src/orchestration/sandboxExecutor";
import { createRunControlState, drainSteer, enqueueSteer } from "../src/orchestration/runControl";
import { DagNodeSchema, DagSchema, type Dag, type DagNode } from "../src/protocol/dag";
import { WorkspaceSandboxAdapter } from "../src/sandbox";

const FIXED_NOW = "2026-06-13T00:00:00.000Z";
const WORKSPACE_ROOT = nodePath.resolve("run-steer-fixture-root");

describe("run steer integration seam", () => {
  it("drains steer guidance into the next sandbox tool result without aborting the run", async () => {
    const runControl = createRunControlState("run-steer");
    enqueueSteer(runControl, "prefer npm:test before broader validation");
    const dag = makeDag([
      makeNode({ id: "node-a", type: "VALIDATION", input: { command: "npm:test" } }),
      makeNode({ id: "node-b", type: "VALIDATION", dependsOn: ["node-a"], input: { command: "npm:test" } }),
    ]);

    const result = await executeDagThroughSandbox(dag, {
      sandbox: new WorkspaceSandboxAdapter({
        workspaceRoot: WORKSPACE_ROOT,
        allowlistedCommands: ["npm:test"],
        commandRunner: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
        now: () => FIXED_NOW,
      }),
      runControl,
    }, { now: () => FIXED_NOW });

    expect(result.status).toBe("SUCCESS");
    expect(result.nodeResults[0].output).toMatchObject({
      steerGuidance: "prefer npm:test before broader validation",
    });
    expect(result.nodeResults[1].output).toMatchObject({
      steerGuidance: undefined,
    });
    expect(runControl.interruptRequested).toBe(false);
    expect(runControl.abortController.signal.aborted).toBe(false);
    expect(drainSteer(runControl)).toBeUndefined();
  });
});

function makeNode(overrides: Partial<DagNode> & { id: string; type: DagNode["type"] }): DagNode {
  return DagNodeSchema.parse({ dependsOn: [], toolPermissions: [], expectedOutputs: [], ...overrides });
}

function makeDag(nodes: DagNode[]): Dag {
  const edges = nodes.slice(1).map((node, index) => ({ from: nodes[index].id, to: node.id }));
  return DagSchema.parse({
    id: "dag-run-steer",
    runId: "run-steer",
    version: "1",
    nodes,
    edges,
    createdAt: FIXED_NOW,
  });
}
