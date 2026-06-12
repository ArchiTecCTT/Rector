import nodePath from "node:path";
import { describe, expect, it } from "vitest";

import { DagSchema, DagNodeSchema, type Dag, type DagNode } from "../src/protocol/dag";
import {
  EXECUTION_ARTIFACT_PREVIEW_MAX_LENGTH,
  executeDagThroughSandbox,
  type ExecutionArtifact,
} from "../src/orchestration/sandboxExecutor";
import { WorkspaceSandboxAdapter, type CommandRunner, type WorkspaceFs } from "../src/sandbox";
import { createWorkspaceFs, embedSecret, type InMemoryWorkspaceFs } from "./support/byokArbitraries";

const NOW = "2026-01-01T00:00:00.000Z";
const ROOT = nodePath.resolve("sandbox-executor-hardening-root");

function bindFs(fs: InMemoryWorkspaceFs): WorkspaceFs {
  return {
    realpathSync: (p) => fs.realpathSync(p),
    readFileSync: (p) => fs.readFileSync(p),
    readdirSync: (p) => fs.readdirSync(p),
    writeFileSync: (p, data) => fs.writeFileSync(p, data),
  };
}

function makeNode(overrides: Partial<DagNode> & { id: string; type: DagNode["type"] }): DagNode {
  return DagNodeSchema.parse({ dependsOn: [], toolPermissions: [], expectedOutputs: [], ...overrides });
}

function makeDag(nodes: DagNode[]): Dag {
  const edges = nodes.slice(1).map((node, index) => ({ from: nodes[index].id, to: node.id }));
  return DagSchema.parse({ id: "dag-sandbox-hardening", runId: "run-sandbox-hardening", version: "1", nodes, edges, createdAt: NOW });
}

function buildSandbox(options: { files?: Record<string, string>; commandRunner?: CommandRunner; allowlistedCommands?: string[] } = {}) {
  const fs = createWorkspaceFs({ root: ROOT, files: options.files });
  const sandbox = new WorkspaceSandboxAdapter({
    workspaceRoot: ROOT,
    fsImpl: bindFs(fs),
    now: () => NOW,
    allowlistedCommands: options.allowlistedCommands ?? ["npm:test", "npm:build"],
    commandRunner: options.commandRunner,
  });
  return { fs, sandbox };
}

function artifactsFor(artifacts: ExecutionArtifact[], source: ExecutionArtifact["source"]): ExecutionArtifact[] {
  return artifacts.filter((artifact) => artifact.source === source);
}

describe("sandbox executor hardening", () => {
  it("rejects an ambiguous file-operation node instead of silently treating it as a no-op", async () => {
    const { sandbox } = buildSandbox();
    const compiled = makeDag([
      makeNode({ id: "task:unsafe", type: "FILE_OPERATION", expectedOutputs: ["../escape.ts"] }),
    ]);

    const result = await executeDagThroughSandbox(compiled, { sandbox }, { now: () => NOW });

    expect(result.status).toBe("FAILED");
    expect(result.nodeResults[0]).toMatchObject({
      nodeId: "task:unsafe",
      status: "FAILED",
      error: { code: "OPERATION_MAPPING_FAILED" },
    });
    expect(result.artifacts).toEqual([]);
  });

  it("redacts and length-bounds artifact previews while preserving operation correlation", async () => {
    const secret = "sk-SANDBOXHARDENINGSECRET0123456789abcd";
    const body = `${embedSecret(secret, "file")}${"x".repeat(2_000)}`;
    const { sandbox } = buildSandbox({ files: { "src/secret.ts": body } });
    const compiled = makeDag([
      makeNode({ id: "task:read", type: "LLM_EXECUTION", input: { sandboxOperation: { kind: "READ_FILE", path: "src/secret.ts" } } }),
    ]);

    const result = await executeDagThroughSandbox(compiled, { sandbox }, { now: () => NOW });

    const artifact = artifactsFor(result.artifacts, "sandbox-operation")[0];
    expect(artifact.operationId).toBe("task:read:READ_FILE");
    expect(artifact.preview.length).toBeLessThanOrEqual(EXECUTION_ARTIFACT_PREVIEW_MAX_LENGTH);
    expect(artifact.preview).not.toContain(secret);
    expect(typeof artifact.truncated).toBe("boolean");
  });

  it("captures stdout and stderr artifacts with bridge-level truncation flags", async () => {
    const stdout = "o".repeat(EXECUTION_ARTIFACT_PREVIEW_MAX_LENGTH + 50);
    const stderr = "e".repeat(EXECUTION_ARTIFACT_PREVIEW_MAX_LENGTH + 75);
    const { sandbox } = buildSandbox({ commandRunner: async () => ({ exitCode: 0, stdout, stderr }) });
    const compiled = makeDag([
      makeNode({ id: "validate:test", type: "VALIDATION", input: { command: "npm:test" } }),
    ]);

    const result = await executeDagThroughSandbox(compiled, { sandbox }, { now: () => NOW });

    expect(result.status).toBe("SUCCESS");
    const stdoutArtifact = artifactsFor(result.artifacts, "command-stdout")[0];
    const stderrArtifact = artifactsFor(result.artifacts, "command-stderr")[0];
    expect(stdoutArtifact).toMatchObject({ operationId: "validate:test:RUN_COMMAND", truncated: true });
    expect(stderrArtifact).toMatchObject({ operationId: "validate:test:RUN_COMMAND", truncated: true });
    expect(stdoutArtifact.preview.length).toBe(EXECUTION_ARTIFACT_PREVIEW_MAX_LENGTH);
    expect(stderrArtifact.preview.length).toBe(EXECUTION_ARTIFACT_PREVIEW_MAX_LENGTH);
  });

  it("returns a schema-valid partial DAG result when one sandbox operation fails and an independent node succeeds", async () => {
    const { sandbox } = buildSandbox({ commandRunner: async ({ command }) => ({ exitCode: command === "npm:test" ? 1 : 0, stdout: "ok", stderr: "failed" }) });
    const compiled = DagSchema.parse({
      id: "dag-sandbox-partial",
      runId: "run-sandbox-partial",
      version: "1",
      nodes: [
        makeNode({ id: "validate:test", type: "VALIDATION", input: { command: "npm:test" } }),
        makeNode({ id: "validate:build", type: "VALIDATION", input: { command: "npm:build" } }),
      ],
      edges: [],
      createdAt: NOW,
    });

    const result = await executeDagThroughSandbox(compiled, { sandbox }, { now: () => NOW });

    expect(result.status).toBe("PARTIAL");
    expect(result.nodeResults.find((entry) => entry.nodeId === "validate:test")?.status).toBe("FAILED");
    expect(result.nodeResults.find((entry) => entry.nodeId === "validate:build")?.status).toBe("SUCCESS");
    expect(result.events[result.events.length - 1]).toMatchObject({ type: "DAG_COMPLETED", status: "PARTIAL" });
  });

  it("retains expected outputs on successful sandbox node results for downstream validation", async () => {
    const { sandbox } = buildSandbox({ files: { "src/result.txt": "ok" } });
    const compiled = DagSchema.parse({
      id: "dag-sandbox-expected-outputs",
      runId: "run-sandbox-expected-outputs",
      version: "1",
      nodes: [
        makeNode({
          id: "task:read",
          type: "LLM_EXECUTION",
          input: { sandboxOperation: { kind: "READ_FILE", path: "src/result.txt" } },
          expectedOutputs: ["src/result.txt"],
        }),
        makeNode({
          id: "validate:read",
          type: "VALIDATION",
          dependsOn: ["task:read"],
          input: { targetNodeId: "task:read", expectedArtifacts: ["src/result.txt"] },
        }),
      ],
      edges: [{ from: "task:read", to: "validate:read" }],
      createdAt: NOW,
    });

    const result = await executeDagThroughSandbox(compiled, { sandbox }, { now: () => NOW });

    expect(result.status).toBe("SUCCESS");
    expect(result.nodeResults.find((entry) => entry.nodeId === "task:read")?.output).toMatchObject({
      expectedOutputs: ["src/result.txt"],
    });
    expect(result.nodeResults.find((entry) => entry.nodeId === "validate:read")?.status).toBe("SUCCESS");
  });
});
