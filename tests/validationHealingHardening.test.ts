import nodePath from "node:path";
import { describe, expect, it } from "vitest";

import { DagSchema, type Dag, type DagNode } from "../src/protocol/dag";
import { DagExecutionResultSchema, executeCompiledDag, type DagExecutionResult } from "../src/orchestration/executorSimulator";
import { validateAndHealExecution, type HealingExecutor, type LiveRepairAgent } from "../src/orchestration/validationHealing";
import { triageUserMessage } from "../src/orchestration/triage";
import { WorkspaceSandboxAdapter, type SandboxApproval, type WorkspaceFs } from "../src/sandbox";
import { createWorkspaceFs, generousBudget, makeContextPack, makeExternalRun, type InMemoryWorkspaceFs } from "./support/byokArbitraries";

const NOW = "2026-01-01T00:00:00.000Z";
const ROOT = nodePath.resolve("validation-healing-hardening-root");
const REPAIR_PATH = "src/index.ts";
const TRIAGE = triageUserMessage("Fix the validation failure in src/index.ts");
const CONTEXT = makeContextPack(TRIAGE);
const RUN = makeExternalRun(generousBudget());

function bindFs(fs: InMemoryWorkspaceFs): WorkspaceFs {
  return {
    realpathSync: (p) => fs.realpathSync(p),
    readFileSync: (p) => fs.readFileSync(p),
    readdirSync: (p) => fs.readdirSync(p),
    writeFileSync: (p, data) => fs.writeFileSync(p, data),
  };
}

function node(overrides: Partial<DagNode> & { id: string; type: DagNode["type"] }): DagNode {
  return {
    dependsOn: [],
    toolPermissions: ["fake.local"],
    expectedOutputs: [],
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    timeoutMs: 100,
    ...overrides,
  };
}

function dag(nodes: DagNode[]): Dag {
  return DagSchema.parse({ id: "dag-validation-hardening", runId: "run-validation-hardening", version: "1", nodes, edges: [], createdAt: NOW });
}

function failedResult(compiledDag: Dag, code: "VALIDATION_FAILED" | "SANDBOX_OPERATION_FAILED" = "VALIDATION_FAILED", message = "validation failed"): DagExecutionResult {
  const target = compiledDag.nodes[0];
  return DagExecutionResultSchema.parse({
    dagId: compiledDag.id,
    runId: compiledDag.runId,
    status: "FAILED",
    startedAt: NOW,
    completedAt: NOW,
    durationMs: 1,
    nodeResults: [
      {
        nodeId: target.id,
        status: "FAILED",
        attempts: 1,
        startedAt: NOW,
        completedAt: NOW,
        durationMs: 1,
        dependencies: [],
        error: { code, message, nodeId: target.id },
      },
    ],
    events: [
      { sequence: 1, type: "DAG_STARTED", at: NOW },
      { sequence: 2, type: "NODE_STARTED", nodeId: target.id, at: NOW, attempt: 1 },
      { sequence: 3, type: "NODE_FAILED", nodeId: target.id, status: "FAILED", at: NOW, attempt: 1, error: { code, message, nodeId: target.id } },
      { sequence: 4, type: "DAG_COMPLETED", status: "FAILED", at: NOW },
    ],
  });
}

function sandbox(approved: boolean): WorkspaceSandboxAdapter {
  const fs = createWorkspaceFs({ root: ROOT });
  const approvals: SandboxApproval[] = approved ? [{ id: "approval-1", scope: "FILE_WRITE", target: REPAIR_PATH, approvedBy: "tester" }] : [];
  return new WorkspaceSandboxAdapter({ workspaceRoot: ROOT, fsImpl: bindFs(fs), approvals, now: () => NOW });
}

const repairAgent: LiveRepairAgent = async () => ({
  path: REPAIR_PATH,
  operation: "update",
  content: "export const fixed = true;\n",
  rationale: "Replace the invalid file content with a valid fixture.",
});

describe("validation/healing hardening", () => {
  it("retries UNKNOWN failures only within the configured bound and then fails", async () => {
    const compiled = dag([node({ id: "task:unknown", type: "LLM_EXECUTION" })]);
    const initial = failedResult(compiled, "SANDBOX_OPERATION_FAILED", "sandbox failed without a retryable class");
    const alwaysUnknown: HealingExecutor = async () => initial;

    const result = await validateAndHealExecution({
      compiledDag: compiled,
      executionResult: initial,
      executor: alwaysUnknown,
      maxHealingAttempts: 1,
    });

    expect(result.status).toBe("FAILED");
    expect(result.attempts).toBe(1);
    expect(result.failures[0]).toMatchObject({ classification: "UNKNOWN" });
    expect(result.actions).toEqual([
      expect.objectContaining({ type: "RETRY_NODE", nodeId: "task:unknown", attempt: 1, classification: "UNKNOWN" }),
      expect.objectContaining({ type: "FAIL_RUN", nodeId: "task:unknown", classification: "UNKNOWN" }),
    ]);
  });

  it("uses a targeted safe patch repair path for validation failures and revalidates after the patch is applied", async () => {
    const compiled = dag([node({ id: "task:validate", type: "LLM_EXECUTION" })]);
    const initial = failedResult(compiled, "VALIDATION_FAILED", "TypeScript validation failed in src/index.ts");
    let revalidations = 0;
    const recoveringExecutor: HealingExecutor = async () => {
      revalidations += 1;
      return executeCompiledDag(compiled, { now: () => NOW });
    };

    const result = await validateAndHealExecution({
      compiledDag: compiled,
      executionResult: initial,
      executor: recoveringExecutor,
      maxHealingAttempts: 2,
      repairAgent,
      sandbox: sandbox(true),
      contextPack: CONTEXT,
      run: RUN,
    });

    expect(result.status).toBe("HEALED");
    expect(revalidations).toBe(1);
    expect(result.actions).toContainEqual(expect.objectContaining({ type: "APPLY_PATCH", classification: "VALIDATION" }));
    expect(result.rounds[0]).toMatchObject({ repairApplied: true, revalidationStatus: "SUCCESS" });
  });

  it("escalates to NEEDS_DECISION when a targeted repair patch requires approval", async () => {
    const compiled = dag([node({ id: "task:needs-approval", type: "LLM_EXECUTION" })]);
    const initial = failedResult(compiled, "VALIDATION_FAILED", "validator requested a file patch");

    const result = await validateAndHealExecution({
      compiledDag: compiled,
      executionResult: initial,
      maxHealingAttempts: 2,
      repairAgent,
      sandbox: sandbox(false),
      contextPack: CONTEXT,
      run: RUN,
    });

    expect(result.status).toBe("NEEDS_DECISION");
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0]).toMatchObject({ repairApplied: false, revalidationStatus: "FAILED" });
    expect(result.actions).toContainEqual(expect.objectContaining({ type: "REQUEST_DECISION", nodeId: "task:needs-approval" }));
  });

  it("redacts secrets from classified failure messages before returning them", async () => {
    const secret = "sk-VALIDATIONHARDENINGSECRET0123456789";
    const compiled = dag([node({ id: "task:secret", type: "LLM_EXECUTION" })]);
    const initial = failedResult(compiled, "VALIDATION_FAILED", `Authorization: Bearer ${secret}`);

    const result = await validateAndHealExecution({ compiledDag: compiled, executionResult: initial });

    expect(JSON.stringify(result.failures)).not.toContain(secret);
    expect(result.failures[0].message).toContain("Bearer [REDACTED]");
  });
});
