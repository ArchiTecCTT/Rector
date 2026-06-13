import nodePath from "node:path";
import { describe, expect, it, vi } from "vitest";

import { executeCompiledDag } from "../src/orchestration/executorSimulator";
import { executeDagThroughSandbox } from "../src/orchestration/sandboxExecutor";
import { DagNodeSchema, DagSchema, type Dag, type DagNode } from "../src/protocol/dag";
import {
  SandboxOperationResultSchema,
  WorkspaceSandboxAdapter,
  type WorkspaceFs,
} from "../src/sandbox";
import { ToolRegistry, type ToolRegistryEntry } from "../src/tools";
import { createWorkspaceFs, type InMemoryWorkspaceFs } from "./support/byokArbitraries";

const NOW = "2026-01-01T00:00:00.000Z";
const ROOT = nodePath.resolve("sandbox-executor-registry-root");

function bindFs(fs: InMemoryWorkspaceFs): WorkspaceFs {
  return {
    realpathSync: (p) => fs.realpathSync(p),
    readFileSync: (p) => fs.readFileSync(p),
    readdirSync: (p) => fs.readdirSync(p),
    writeFileSync: (p, data) => fs.writeFileSync(p, data),
  };
}

function node(overrides: Partial<DagNode> & { id: string; type: DagNode["type"] }): DagNode {
  return DagNodeSchema.parse({ dependsOn: [], toolPermissions: [], expectedOutputs: [], ...overrides });
}

function dag(nodes: DagNode[]): Dag {
  return DagSchema.parse({
    id: "dag-registry",
    runId: "run-registry",
    version: "1",
    nodes,
    edges: [],
    createdAt: NOW,
  });
}

function sandbox(): WorkspaceSandboxAdapter {
  const fs = createWorkspaceFs({ root: ROOT });
  return new WorkspaceSandboxAdapter({
    workspaceRoot: ROOT,
    fsImpl: bindFs(fs),
    allowlistedCommands: ["npm:test"],
    now: () => NOW,
  });
}

function registryWithSandboxExecute(handler = vi.fn(async () => ({
  ok: true,
  toolName: "sandbox.execute",
  output: {
    sandboxResult: SandboxOperationResultSchema.parse({
      kind: "RUN_COMMAND",
      status: "SUCCEEDED",
      stdout: "ok",
      stderr: "",
      networkCalls: 0,
      startedAt: NOW,
      completedAt: NOW,
    }),
  },
}))) {
  const registry = new ToolRegistry();
  registry.register({
    definition: {
      name: "sandbox.execute",
      description: "test execute",
      inputSchema: {},
      risk: "high",
      requiresApproval: false,
      requiresSandbox: true,
    },
    source: "builtin",
    handler,
  } satisfies ToolRegistryEntry);
  return { registry, handler };
}

describe("sandbox executor registry integration", () => {
  it("dispatches a mapped command node through sandbox.execute", async () => {
    const { registry, handler } = registryWithSandboxExecute();
    const events: unknown[] = [];
    const result = await executeDagThroughSandbox(
      dag([node({ id: "validate:test", type: "VALIDATION", input: { command: "npm:test" } })]),
      {
        sandbox: sandbox(),
        toolRegistry: registry,
        conversationId: "conversation-registry",
        appendRunEvent: (event) => events.push(event),
      },
      { now: () => NOW },
    );

    expect(result.status).toBe("SUCCESS");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.nodeResults[0].output).toMatchObject({ toolName: "sandbox.execute", sandboxStatus: "SUCCEEDED" });
    expect(events.map((event: any) => event.type)).toEqual(["TOOL_INVOKED", "TOOL_COMPLETED"]);
  });

  it("halts a branch with PERMISSION_DENIED when node policy denies the mapped tool", async () => {
    const { registry, handler } = registryWithSandboxExecute();
    const result = await executeDagThroughSandbox(
      dag([
        node({
          id: "validate:denied",
          type: "VALIDATION",
          input: { command: "npm:test" },
          metadata: { toolPolicy: { allowed: ["workspace.read_file"] } },
        }),
      ]),
      { sandbox: sandbox(), toolRegistry: registry, conversationId: "conversation-registry" },
      { now: () => NOW },
    );

    expect(result.status).toBe("FAILED");
    expect(result.nodeResults[0].error?.code).toBe("PERMISSION_DENIED");
    expect(result.nodeResults[0].output).toMatchObject({
      toolName: "sandbox.execute",
      toolResult: { middlewareHalt: true },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("aligns simulator and sandbox outputs with registry tool names", async () => {
    const compiled = dag([
      node({
        id: "validate:shape",
        type: "VALIDATION",
        input: { sandboxOperation: { kind: "RUN_COMMAND", command: "npm:test" } },
      }),
    ]);
    const { registry } = registryWithSandboxExecute();

    const simulated = await executeCompiledDag(compiled, { now: () => NOW });
    const executed = await executeDagThroughSandbox(
      compiled,
      { sandbox: sandbox(), toolRegistry: registry, conversationId: "conversation-registry" },
      { now: () => NOW },
    );

    expect(simulated.nodeResults[0].output).toMatchObject({ toolName: "sandbox.execute" });
    expect(executed.nodeResults[0].output).toMatchObject({ toolName: "sandbox.execute" });
  });
});
