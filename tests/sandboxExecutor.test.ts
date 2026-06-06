/**
 * DAG-to-sandbox execution bridge unit tests (ORN-37, task 4.2).
 *
 * Validates: Requirements 4.7, 4.8
 *
 * `src/orchestration/sandboxExecutor.ts` is the only bridge between the executor
 * phase and real file/command I/O. These unit tests exercise:
 *
 *  - `mapDagNodeToOperation`: node -> SandboxOperationInput mapping for each
 *    operation kind (READ_FILE, LIST_DIR, PROPOSE_PATCH, RUN_COMMAND), the
 *    node-type defaults, explicit input/metadata hints, hint precedence, and the
 *    no-op (undefined) cases for nodes that carry no workspace I/O.
 *  - `executeDagThroughSandbox`: the recorded `ExecutionArtifact` shape (Req 4.7
 *    captured stdout/stderr artifacts, patch artifact id, redacted+bounded
 *    previews), `networkCalls`-free execution (Req 4.8 — no out-of-root I/O),
 *    and that denied / needs-approval / failed operations surface as STRUCTURED
 *    node results rather than thrown errors.
 *
 * The workspace filesystem is injected via the in-memory `WorkspaceFs` double
 * and the command runner is a deterministic stub, so no real disk, API key, or
 * network is used.
 */
import nodePath from "node:path";
import { describe, it, expect } from "vitest";

import {
  DagSchema,
  DagNodeSchema,
  type Dag,
  type DagNode,
} from "../src/protocol/dag";
import {
  EXECUTION_ARTIFACT_PREVIEW_MAX_LENGTH,
  ExecutionArtifactSchema,
  executeDagThroughSandbox,
  mapDagNodeToOperation,
  type ExecutionArtifact,
} from "../src/orchestration/sandboxExecutor";
import {
  WorkspaceSandboxAdapter,
  type CommandRunResult,
  type CommandRunner,
  type SandboxApproval,
  type WorkspaceFs,
} from "../src/sandbox";
import { createWorkspaceFs, embedSecret, type InMemoryWorkspaceFs } from "./support/byokArbitraries";

const FIXED_NOW = "2026-01-01T00:00:00.000Z";
const now = () => FIXED_NOW;
const WORKSPACE_ROOT = nodePath.resolve("sandbox-executor-fixture-root");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a schema-valid DagNode with the supplied overrides. */
function makeNode(overrides: Partial<DagNode> & { id: string; type: DagNode["type"] }): DagNode {
  return DagNodeSchema.parse({ dependsOn: [], toolPermissions: [], expectedOutputs: [], ...overrides });
}

/** Wraps nodes in a schema-valid, single-chain DAG. */
function makeDag(nodes: DagNode[]): Dag {
  const edges = nodes.slice(1).map((node, index) => ({ from: nodes[index].id, to: node.id }));
  return DagSchema.parse({
    id: "dag-sandbox-bridge-test",
    runId: "run-sandbox-bridge-test",
    version: "1",
    nodes,
    edges,
    createdAt: FIXED_NOW,
  });
}

/**
 * `resolveWithinWorkspace` destructures `fsImpl.realpathSync` as a standalone
 * reference, so the in-memory double's methods are forwarded through bound
 * closures to preserve `this`. The same `fs` instance is returned for
 * access-tracking assertions.
 */
function bindFs(fs: InMemoryWorkspaceFs): WorkspaceFs {
  return {
    realpathSync: (p) => fs.realpathSync(p),
    readFileSync: (p) => fs.readFileSync(p),
    readdirSync: (p) => fs.readdirSync(p),
    writeFileSync: (p, data) => fs.writeFileSync(p, data),
  };
}

interface SandboxFixtureOptions {
  files?: Record<string, string>;
  dirs?: Record<string, string[]>;
  allowlistedCommands?: string[];
  approvals?: SandboxApproval[];
  commandRunner?: CommandRunner;
}

function buildSandbox(options: SandboxFixtureOptions = {}) {
  const fs = createWorkspaceFs({ root: WORKSPACE_ROOT, files: options.files, dirs: options.dirs });
  const commandRunner: CommandRunner =
    options.commandRunner ??
    (async ({ command, args }): Promise<CommandRunResult> => ({
      exitCode: 0,
      stdout: `${[command, ...args].join(" ").trim()} stdout`,
      stderr: "",
    }));
  const sandbox = new WorkspaceSandboxAdapter({
    workspaceRoot: WORKSPACE_ROOT,
    allowlistedCommands: options.allowlistedCommands ?? ["npm:test", "npm:build"],
    approvals: options.approvals ?? [],
    fsImpl: bindFs(fs),
    commandRunner,
    now,
  });
  return { fs, sandbox, commandRunner };
}

function artifactsFor(artifacts: ExecutionArtifact[], source: ExecutionArtifact["source"]): ExecutionArtifact[] {
  return artifacts.filter((artifact) => artifact.source === source);
}

// ===========================================================================
// mapDagNodeToOperation — node -> operation mapping for each kind
// ===========================================================================

describe("mapDagNodeToOperation: node-type defaults", () => {
  it("maps a FILE_OPERATION node to a PROPOSE_PATCH using the first safe expected output", () => {
    const node = makeNode({ id: "n1", type: "FILE_OPERATION", expectedOutputs: ["src/app.ts"] });
    expect(mapDagNodeToOperation(node)).toEqual({
      kind: "PROPOSE_PATCH",
      path: "src/app.ts",
      operation: "update",
      content: "",
      approvalId: undefined,
    });
  });

  it("maps a VALIDATION node with a command hint to RUN_COMMAND", () => {
    const node = makeNode({ id: "n1", type: "VALIDATION", input: { command: "npm:test", args: ["--run"] } });
    expect(mapDagNodeToOperation(node)).toEqual({
      kind: "RUN_COMMAND",
      command: "npm:test",
      args: ["--run"],
      timeoutMs: undefined,
      approvalId: undefined,
      metadata: {},
    });
  });

  it("flags a SHELL_COMMAND node as a shell invocation in the operation metadata", () => {
    const node = makeNode({ id: "n1", type: "SHELL_COMMAND", input: { command: "npm:build" } });
    const operation = mapDagNodeToOperation(node);
    expect(operation?.kind).toBe("RUN_COMMAND");
    expect(operation?.metadata).toEqual({ kind: "shell" });
  });

  it("carries the node timeout onto a RUN_COMMAND operation", () => {
    const node = makeNode({ id: "n1", type: "VALIDATION", timeoutMs: 5_000, input: { command: "npm:test" } });
    expect(mapDagNodeToOperation(node)?.timeoutMs).toBe(5_000);
  });

  it.each(["LLM_EXECUTION", "MERGE", "CONDITIONAL"] as const)(
    "treats a %s node as a no-op (no sandbox operation)",
    (type) => {
      expect(mapDagNodeToOperation(makeNode({ id: "n1", type }))).toBeUndefined();
    },
  );

  it("returns undefined for a RUN_COMMAND-default node without a command", () => {
    expect(mapDagNodeToOperation(makeNode({ id: "n1", type: "VALIDATION" }))).toBeUndefined();
  });

  it("returns undefined for a PROPOSE_PATCH-default node without a safe target path", () => {
    const node = makeNode({ id: "n1", type: "FILE_OPERATION", expectedOutputs: ["/abs/escape.ts", "../up.ts"] });
    expect(mapDagNodeToOperation(node)).toBeUndefined();
  });
});

describe("mapDagNodeToOperation: explicit hints", () => {
  it("honors an explicit READ_FILE hint on an otherwise no-op node", () => {
    const node = makeNode({
      id: "n1",
      type: "LLM_EXECUTION",
      input: { sandboxOperation: { kind: "READ_FILE", path: "src/read.ts" } },
    });
    expect(mapDagNodeToOperation(node)).toEqual({ kind: "READ_FILE", path: "src/read.ts", approvalId: undefined });
  });

  it("honors an explicit LIST_DIR hint via operationKind", () => {
    const node = makeNode({
      id: "n1",
      type: "LLM_EXECUTION",
      input: { sandboxOperation: { operationKind: "LIST_DIR", path: "src" } },
    });
    expect(mapDagNodeToOperation(node)).toEqual({ kind: "LIST_DIR", path: "src", approvalId: undefined });
  });

  it("honors an explicit PROPOSE_PATCH hint with operation, content, and approvalId", () => {
    const node = makeNode({
      id: "n1",
      type: "FILE_OPERATION",
      input: { sandboxOperation: { kind: "PROPOSE_PATCH", path: "lib/x.ts", operation: "add", content: "hello", approvalId: "appr-1" } },
    });
    expect(mapDagNodeToOperation(node)).toEqual({
      kind: "PROPOSE_PATCH",
      path: "lib/x.ts",
      operation: "add",
      content: "hello",
      approvalId: "appr-1",
    });
  });

  it("lets an input hint take precedence over a metadata hint", () => {
    const node = makeNode({
      id: "n1",
      type: "LLM_EXECUTION",
      input: { sandboxOperation: { kind: "LIST_DIR", path: "from-input" } },
      metadata: { sandboxOperation: { kind: "READ_FILE", path: "from-metadata" } },
    });
    expect(mapDagNodeToOperation(node)).toEqual({ kind: "LIST_DIR", path: "from-input", approvalId: undefined });
  });

  it("falls back to a metadata hint when the node input carries none", () => {
    const node = makeNode({
      id: "n1",
      type: "LLM_EXECUTION",
      metadata: { sandboxOperation: { kind: "READ_FILE", path: "from-metadata.ts" } },
    });
    expect(mapDagNodeToOperation(node)).toEqual({ kind: "READ_FILE", path: "from-metadata.ts", approvalId: undefined });
  });
});

// ===========================================================================
// executeDagThroughSandbox — artifact recording shape (Req 4.7, 4.8)
// ===========================================================================

describe("executeDagThroughSandbox: artifact recording", () => {
  it("records a single redacted sandbox-operation artifact for a READ_FILE success", async () => {
    const { fs, sandbox } = buildSandbox({ files: { "src/read.ts": "file body" } });
    const dag = makeDag([
      makeNode({ id: "n1", type: "LLM_EXECUTION", input: { sandboxOperation: { kind: "READ_FILE", path: "src/read.ts" } } }),
    ]);

    const result = await executeDagThroughSandbox(dag, { sandbox }, { now });

    expect(result.status).toBe("SUCCESS");
    expect(result.nodeResults[0].status).toBe("SUCCESS");
    const opArtifacts = artifactsFor(result.artifacts, "sandbox-operation");
    expect(opArtifacts).toHaveLength(1);
    expect(opArtifacts[0]).toMatchObject({
      source: "sandbox-operation",
      nodeId: "n1",
      operationKind: "READ_FILE",
      status: "SUCCEEDED",
      preview: "file body",
    });
    // Req 4.8: no out-of-root I/O occurred.
    expect(fs.accessedOutsideRoot()).toEqual([]);
    // Every recorded artifact conforms to the ExecutionArtifact schema.
    for (const artifact of result.artifacts) {
      expect(() => ExecutionArtifactSchema.parse(artifact)).not.toThrow();
    }
  });

  it("captures stdout and stderr as separate artifacts for a RUN_COMMAND (Req 4.7)", async () => {
    const { sandbox } = buildSandbox({
      commandRunner: async () => ({ exitCode: 0, stdout: "build output", stderr: "warning line" }),
    });
    const dag = makeDag([makeNode({ id: "n1", type: "VALIDATION", input: { command: "npm:build" } })]);

    const result = await executeDagThroughSandbox(dag, { sandbox }, { now });

    expect(result.nodeResults[0].status).toBe("SUCCESS");
    expect(artifactsFor(result.artifacts, "sandbox-operation")).toHaveLength(1);

    const stdout = artifactsFor(result.artifacts, "command-stdout");
    const stderr = artifactsFor(result.artifacts, "command-stderr");
    expect(stdout).toHaveLength(1);
    expect(stderr).toHaveLength(1);
    expect(stdout[0]).toMatchObject({ nodeId: "n1", operationKind: "RUN_COMMAND", status: "SUCCEEDED", preview: "build output" });
    expect(stderr[0]).toMatchObject({ preview: "warning line" });
  });

  it("records a patch artifact with the emitted PatchArtifact id for a PROPOSE_PATCH", async () => {
    const approvals: SandboxApproval[] = [
      { id: "appr-1", scope: "FILE_WRITE", target: "src/app.ts", approvedBy: "tester" },
    ];
    const { fs, sandbox } = buildSandbox({ approvals });
    const dag = makeDag([
      makeNode({
        id: "n1",
        type: "FILE_OPERATION",
        input: { sandboxOperation: { kind: "PROPOSE_PATCH", path: "src/app.ts", operation: "add", content: "code" } },
      }),
    ]);

    const result = await executeDagThroughSandbox(dag, { sandbox }, { now });

    expect(result.nodeResults[0].status).toBe("SUCCESS");
    const patches = artifactsFor(result.artifacts, "patch");
    expect(patches).toHaveLength(1);
    expect(patches[0].source).toBe("patch");
    expect(patches[0].artifactId).toBe("patch:src-app.ts");
    expect(patches[0].status).toBe("SUCCEEDED");
    // The approved write went through the sandbox fs.
    expect(fs.writes).toHaveLength(1);
  });

  it("redacts secrets and truncates the preview to the bounded length", async () => {
    const secret = "sk-EXECUTORLEAKABCDEFGHIJKLMNOP012345";
    const longBody = embedSecret(secret, "file-content") + " " + "x".repeat(2_000);
    const { sandbox } = buildSandbox({ files: { "src/big.ts": longBody } });
    const dag = makeDag([
      makeNode({ id: "n1", type: "LLM_EXECUTION", input: { sandboxOperation: { kind: "READ_FILE", path: "src/big.ts" } } }),
    ]);

    const result = await executeDagThroughSandbox(dag, { sandbox }, { now });

    const preview = artifactsFor(result.artifacts, "sandbox-operation")[0].preview;
    expect(preview.length).toBeLessThanOrEqual(EXECUTION_ARTIFACT_PREVIEW_MAX_LENGTH);
    expect(preview).not.toContain(secret);
  });

  it("records no artifacts and makes no sandbox call for a no-op node", async () => {
    const { fs, sandbox } = buildSandbox();
    const dag = makeDag([makeNode({ id: "n1", type: "LLM_EXECUTION" })]);

    const result = await executeDagThroughSandbox(dag, { sandbox }, { now });

    expect(result.status).toBe("SUCCESS");
    expect(result.nodeResults[0].output).toMatchObject({ noop: true, sandbox: false });
    expect(result.artifacts).toEqual([]);
    expect(fs.reads).toEqual([]);
    expect(fs.writes).toEqual([]);
  });
});

// ===========================================================================
// executeDagThroughSandbox — denied/needs-approval surface as results (no throw)
// ===========================================================================

describe("executeDagThroughSandbox: denied/needs-approval as structured results", () => {
  it("surfaces an unapproved PROPOSE_PATCH as a structured failure without writing or throwing", async () => {
    const { fs, sandbox } = buildSandbox(); // no approvals
    const dag = makeDag([
      makeNode({
        id: "n1",
        type: "FILE_OPERATION",
        input: { sandboxOperation: { kind: "PROPOSE_PATCH", path: "src/app.ts", operation: "update", content: "code" } },
      }),
    ]);

    const result = await executeDagThroughSandbox(dag, { sandbox }, { now });

    expect(result.status).toBe("FAILED");
    const node = result.nodeResults[0];
    expect(node.status).toBe("FAILED");
    expect(node.error?.code).toBe("PERMISSION_DENIED");
    expect(node.output).toMatchObject({ denialReason: "NEEDS_APPROVAL", sandboxStatus: "NEEDS_APPROVAL" });
    // An unapproved patch is recorded but never written.
    expect(artifactsFor(result.artifacts, "patch")).toHaveLength(1);
    expect(fs.writes).toEqual([]);
  });

  it("surfaces a destructive command as a DENIED structured failure", async () => {
    const { sandbox } = buildSandbox();
    const dag = makeDag([
      makeNode({ id: "n1", type: "VALIDATION", input: { command: "rm", args: ["-rf", "."] } }),
    ]);

    const result = await executeDagThroughSandbox(dag, { sandbox }, { now });

    const node = result.nodeResults[0];
    expect(node.status).toBe("FAILED");
    expect(node.error?.code).toBe("PERMISSION_DENIED");
    expect(node.output).toMatchObject({ denialReason: "DESTRUCTIVE_COMMAND_BLOCKED", sandboxStatus: "DENIED" });
    expect(artifactsFor(result.artifacts, "sandbox-operation")[0].status).toBe("DENIED");
  });

  it("surfaces an arbitrary-shell SHELL_COMMAND node as a DENIED structured failure", async () => {
    const { sandbox } = buildSandbox();
    const dag = makeDag([makeNode({ id: "n1", type: "SHELL_COMMAND", input: { command: "npm:build" } })]);

    const result = await executeDagThroughSandbox(dag, { sandbox }, { now });

    const node = result.nodeResults[0];
    expect(node.status).toBe("FAILED");
    expect(node.output).toMatchObject({ denialReason: "ARBITRARY_SHELL_DISABLED", sandboxStatus: "DENIED" });
  });

  it("surfaces an off-allowlist command as a DENIED structured failure", async () => {
    const { sandbox } = buildSandbox({ allowlistedCommands: ["npm:test"] });
    const dag = makeDag([makeNode({ id: "n1", type: "VALIDATION", input: { command: "curl" } })]);

    const result = await executeDagThroughSandbox(dag, { sandbox }, { now });

    expect(result.nodeResults[0].output).toMatchObject({ denialReason: "COMMAND_NOT_ALLOWLISTED", sandboxStatus: "DENIED" });
  });

  it("maps a command timeout to a TIMEOUT node error", async () => {
    const { sandbox } = buildSandbox({
      commandRunner: async () => ({ exitCode: 1, stdout: "partial", stderr: "killed", timedOut: true }),
    });
    const dag = makeDag([makeNode({ id: "n1", type: "VALIDATION", input: { command: "npm:test" } })]);

    const result = await executeDagThroughSandbox(dag, { sandbox }, { now });

    const node = result.nodeResults[0];
    expect(node.status).toBe("FAILED");
    expect(node.error?.code).toBe("TIMEOUT");
    expect(node.output).toMatchObject({ denialReason: "COMMAND_TIMEOUT" });
  });

  it("propagates a downstream skip when a dependency is denied (structured, no throw)", async () => {
    const { sandbox } = buildSandbox();
    const dag = makeDag([
      makeNode({ id: "n1", type: "SHELL_COMMAND", input: { command: "npm:build" } }),
      makeNode({ id: "n2", type: "VALIDATION", dependsOn: ["n1"], input: { command: "npm:test" } }),
    ]);

    const result = await executeDagThroughSandbox(dag, { sandbox }, { now });

    expect(result.status).toBe("FAILED");
    expect(result.nodeResults.find((node) => node.nodeId === "n1")?.status).toBe("FAILED");
    expect(result.nodeResults.find((node) => node.nodeId === "n2")?.status).toBe("SKIPPED");
  });

  it("returns a structured FAILED result for a malformed DAG instead of throwing", async () => {
    const { sandbox } = buildSandbox();
    // Duplicate node ids pass the shape check but fail DAG validation.
    const malformed = {
      id: "dag-malformed",
      runId: "run-malformed",
      version: "1",
      nodes: [
        { id: "dup", type: "VALIDATION", dependsOn: [], toolPermissions: [], expectedOutputs: [] },
        { id: "dup", type: "VALIDATION", dependsOn: [], toolPermissions: [], expectedOutputs: [] },
      ],
      edges: [],
      createdAt: FIXED_NOW,
    } as unknown as Dag;

    const result = await executeDagThroughSandbox(malformed, { sandbox }, { now });

    expect(result.status).toBe("FAILED");
    expect(result.error?.code).toBe("DAG_VALIDATION_FAILED");
    expect(result.nodeResults).toEqual([]);
  });

  it("catches an unexpected sandbox throw and records it as a structured node failure", async () => {
    const throwingSandbox = {
      operate: async () => {
        throw new Error("unexpected sandbox failure");
      },
    } as unknown as WorkspaceSandboxAdapter;
    const dag = makeDag([makeNode({ id: "n1", type: "VALIDATION", input: { command: "npm:test" } })]);

    const result = await executeDagThroughSandbox(dag, { sandbox: throwingSandbox }, { now });

    const node = result.nodeResults[0];
    expect(node.status).toBe("FAILED");
    expect(node.output).toMatchObject({ sandbox: true });
    expect(String((node.output as { preview?: string }).preview)).toContain("unexpected sandbox failure");
  });
});
