import nodePath from "node:path";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { executeCompiledDag, type DagExecutionResult, type ExecutorSimulatorOptions } from "../src/orchestration/executorSimulator";
import {
  classifyExecutionFailures,
  validateAndHealExecution,
} from "../src/orchestration/validationHealing";
import type { CompiledDag } from "../src/orchestration/dagCompiler";
import { WorkspaceSandboxAdapter, type SandboxApproval } from "../src/sandbox";
import { triageUserMessage } from "../src/orchestration/triage";
import {
  arbFailingDag,
  createWorkspaceFs,
  generousBudget,
  makeAlwaysFailingExecutor,
  makeAlwaysFailingRepairAgent,
  makeContextPack,
  makeExternalRun,
} from "./support/byokArbitraries";

const NOW = "2026-01-01T00:00:00.000Z";

function dag(overrides: Partial<CompiledDag> = {}): CompiledDag {
  return {
    id: "dag-validation-healing-test",
    runId: "run-validation-healing-test",
    version: "0.1.0",
    nodes: [
      {
        id: "task:a",
        type: "LLM_EXECUTION",
        dependsOn: [],
        toolPermissions: ["fake.local"],
        retryPolicy: { maxAttempts: 1, backoffMs: 0 },
        timeoutMs: 100,
      },
      {
        id: "task:b",
        type: "FILE_OPERATION",
        dependsOn: ["task:a"],
        toolPermissions: ["fake.local", "local.file.proposed-write"],
        retryPolicy: { maxAttempts: 1, backoffMs: 0 },
        timeoutMs: 100,
      },
    ],
    edges: [{ from: "task:a", to: "task:b" }],
    createdAt: NOW,
    ...overrides,
  };
}

async function run(compiledDag: CompiledDag, options: ExecutorSimulatorOptions = {}): Promise<DagExecutionResult> {
  return executeCompiledDag(compiledDag, { now: () => NOW, ...options });
}

describe("validation and healing loop", () => {
  it("validates successful execution with zero actions", async () => {
    const compiledDag = dag();
    const executionResult = await run(compiledDag);

    const result = await validateAndHealExecution({ compiledDag, executionResult, executorOptions: { now: () => NOW } });

    expect(result.status).toBe("VALIDATED");
    expect(result.attempts).toBe(0);
    expect(result.failures).toEqual([]);
    expect(result.actions).toEqual([]);
    expect(result.finalExecutionResult.status).toBe("SUCCESS");
  });

  it("heals an injected transient failure through bounded re-execution", async () => {
    const compiledDag = dag();
    const executionResult = await run(compiledDag, { injectFailureNodeIds: ["task:a"] });

    const result = await validateAndHealExecution({
      compiledDag,
      executionResult,
      executorOptions: { injectFailureNodeIds: ["task:a"], now: () => NOW },
      maxHealingAttempts: 2,
    });

    expect(result.status).toBe("HEALED");
    expect(result.attempts).toBe(1);
    expect(result.actions).toEqual([
      expect.objectContaining({ type: "RETRY_NODE", nodeId: "task:a", attempt: 1 }),
    ]);
    expect(result.finalExecutionResult.status).toBe("SUCCESS");
  });

  it("classifies timeout and permission failures without unsafe auto-heal for permission", async () => {
    const timeoutDag = dag({
      nodes: [
        {
          id: "task:slow",
          type: "LLM_EXECUTION",
          dependsOn: [],
          toolPermissions: ["fake.local"],
          retryPolicy: { maxAttempts: 1, backoffMs: 0 },
          timeoutMs: 5,
        },
      ],
      edges: [],
    });
    const timeoutExecution = await run(timeoutDag, { simulatedDurationMsByNodeId: { "task:slow": 10 } });
    expect(classifyExecutionFailures(timeoutDag, timeoutExecution)[0]).toMatchObject({ classification: "TIMEOUT" });

    const permissionDag = dag({
      nodes: [
        {
          id: "task:shell",
          type: "SHELL_COMMAND",
          dependsOn: [],
          toolPermissions: ["unsafe.shell"],
          retryPolicy: { maxAttempts: 1, backoffMs: 0 },
          timeoutMs: 100,
        },
      ],
      edges: [],
    });
    const permissionExecution = await run(permissionDag);

    const permissionResult = await validateAndHealExecution({ compiledDag: permissionDag, executionResult: permissionExecution });

    expect(permissionResult.status).toBe("NEEDS_DECISION");
    expect(permissionResult.failures[0]).toMatchObject({ classification: "PERMISSION", nodeId: "task:shell" });
    expect(permissionResult.actions).toEqual([
      expect.objectContaining({ type: "REQUEST_DECISION", nodeId: "task:shell" }),
    ]);
    expect(permissionResult.finalExecutionResult.status).toBe("FAILED");
  });

  it("links dependency failures to the upstream root cause classification", async () => {
    const compiledDag = dag();
    const executionResult = await run(compiledDag, { injectFailureNodeIds: ["task:a"] });

    const failures = classifyExecutionFailures(compiledDag, executionResult);

    const dependencyFailure = failures.find((failure) => failure.nodeId === "task:b");
    expect(dependencyFailure).toMatchObject({
      classification: "DEPENDENCY",
      rootCauseNodeId: "task:a",
      rootCauseClassification: "TRANSIENT",
    });
  });

  it("bounds healing attempts and fails instead of looping forever", async () => {
    const compiledDag = dag({
      nodes: [
        {
          id: "task:always-flaky",
          type: "LLM_EXECUTION",
          dependsOn: [],
          toolPermissions: ["fake.local"],
          retryPolicy: { maxAttempts: 1, backoffMs: 0 },
          timeoutMs: 100,
        },
      ],
      edges: [],
    });
    const executionResult = await run(compiledDag, { injectFailureNodeIds: ["task:always-flaky"] });

    const result = await validateAndHealExecution({
      compiledDag,
      executionResult,
      maxHealingAttempts: 1,
      executor: (dagToExecute) => run(dagToExecute, { injectFailureNodeIds: ["task:always-flaky"] }),
    });

    expect(result.status).toBe("FAILED");
    expect(result.attempts).toBe(1);
    expect(result.actions).toEqual([
      expect.objectContaining({ type: "RETRY_NODE", nodeId: "task:always-flaky", attempt: 1 }),
      expect.objectContaining({ type: "FAIL_RUN", nodeId: "task:always-flaky" }),
    ]);
    expect(result.finalExecutionResult.status).toBe("FAILED");
  });

  it("heals an end-to-end timeout failure by clamping duration on retry", async () => {
    const timeoutDag = dag({
      nodes: [
        {
          id: "task:slow",
          type: "LLM_EXECUTION",
          dependsOn: [],
          toolPermissions: ["fake.local"],
          retryPolicy: { maxAttempts: 1, backoffMs: 0 },
          timeoutMs: 5,
        },
      ],
      edges: [],
    });

    const executionResult = await run(timeoutDag, {
      simulatedDurationMsByNodeId: { "task:slow": 10 },
    });

    expect(executionResult.status).toBe("FAILED");
    expect(executionResult.nodeResults[0].error?.code).toBe("TIMEOUT");

    const result = await validateAndHealExecution({
      compiledDag: timeoutDag,
      executionResult,
      executorOptions: {
        simulatedDurationMsByNodeId: { "task:slow": 10 },
        now: () => NOW,
      },
      maxHealingAttempts: 2,
    });

    expect(result.status).toBe("HEALED");
    expect(result.attempts).toBe(1);
    expect(result.actions).toEqual([
      expect.objectContaining({ type: "RETRY_NODE", nodeId: "task:slow", attempt: 1 }),
    ]);
    expect(result.finalExecutionResult.status).toBe("SUCCESS");
    expect(result.finalExecutionResult.nodeResults[0].status).toBe("SUCCESS");
  });

  it("classifies validation failures and fails the run without trying to heal", async () => {
    const invalidDag = dag({
      nodes: [
        {
          id: "task:cycle1",
          type: "LLM_EXECUTION",
          dependsOn: ["task:cycle2"],
          toolPermissions: ["fake.local"],
          retryPolicy: { maxAttempts: 1, backoffMs: 0 },
        },
        {
          id: "task:cycle2",
          type: "LLM_EXECUTION",
          dependsOn: ["task:cycle1"],
          toolPermissions: ["fake.local"],
          retryPolicy: { maxAttempts: 1, backoffMs: 0 },
        }
      ],
      edges: [
        { from: "task:cycle1", to: "task:cycle2" },
        { from: "task:cycle2", to: "task:cycle1" }
      ]
    });

    const executionResult = await run(invalidDag);
    expect(executionResult.status).toBe("FAILED");
    expect(executionResult.error?.code).toBe("DAG_VALIDATION_FAILED");

    const result = await validateAndHealExecution({
      compiledDag: invalidDag,
      executionResult,
    });

    expect(result.status).toBe("FAILED");
    expect(result.failures[0]).toMatchObject({
      classification: "VALIDATION",
      errorCode: "DAG_VALIDATION_FAILED"
    });
    expect(result.actions).toEqual([
      expect.objectContaining({ type: "FAIL_RUN", classification: "VALIDATION" }),
    ]);
  });

  it("classifies unknown failures and fails the run without trying to heal", async () => {
    const compiledDag = dag();
    const executionResult = await run(compiledDag);
    
    const mockExecutionResult = {
      ...executionResult,
      status: "FAILED" as const,
      nodeResults: [
        {
          nodeId: "task:a",
          status: "FAILED" as const,
          attempts: 1,
          startedAt: NOW,
          completedAt: NOW,
          durationMs: 10,
          dependencies: [],
        }
      ]
    };

    const result = await validateAndHealExecution({
      compiledDag,
      executionResult: mockExecutionResult,
    });

    expect(result.status).toBe("FAILED");
    expect(result.failures[0]).toMatchObject({
      classification: "UNKNOWN",
      nodeId: "task:a"
    });
    expect(result.actions).toEqual([
      expect.objectContaining({ type: "FAIL_RUN", classification: "UNKNOWN" }),
    ]);
  });

  it("treats an empty skipped DAG as validated rather than failed", async () => {
    const emptyDag = dag({ nodes: [], edges: [] });
    const executionResult = await run(emptyDag);

    expect(executionResult.status).toBe("SKIPPED");

    const result = await validateAndHealExecution({ compiledDag: emptyDag, executionResult });

    expect(result.status).toBe("VALIDATED");
    expect(result.failures).toEqual([]);
    expect(result.actions).toEqual([]);
  });

  it("requires human decision instead of auto-healing high-risk task failures", async () => {
    const highRiskDag = dag({
      nodes: [
        {
          id: "task:high-risk",
          type: "LLM_EXECUTION",
          dependsOn: [],
          toolPermissions: ["fake.local"],
          retryPolicy: { maxAttempts: 1, backoffMs: 0 },
          timeoutMs: 5,
          metadata: { risk: "high" },
        },
      ],
      edges: [],
    });
    const executionResult = await run(highRiskDag, { simulatedDurationMsByNodeId: { "task:high-risk": 10 } });

    const result = await validateAndHealExecution({ compiledDag: highRiskDag, executionResult });

    expect(result.status).toBe("NEEDS_DECISION");
    expect(result.actions).toEqual([
      expect.objectContaining({ type: "REQUEST_DECISION", nodeId: "task:high-risk" }),
    ]);
  });

  it("asserts the dependencyChain correctly for nested dependency root cause", async () => {
    const chainDag = dag({
      nodes: [
        {
          id: "task:a",
          type: "LLM_EXECUTION",
          dependsOn: [],
          toolPermissions: ["fake.local"],
          retryPolicy: { maxAttempts: 1, backoffMs: 0 },
        },
        {
          id: "task:b",
          type: "FILE_OPERATION",
          dependsOn: ["task:a"],
          toolPermissions: ["fake.local"],
          retryPolicy: { maxAttempts: 1, backoffMs: 0 },
        },
        {
          id: "task:c",
          type: "FILE_OPERATION",
          dependsOn: ["task:b"],
          toolPermissions: ["fake.local"],
          retryPolicy: { maxAttempts: 1, backoffMs: 0 },
        },
      ],
      edges: [
        { from: "task:a", to: "task:b" },
        { from: "task:b", to: "task:c" },
      ],
    });

    const executionResult = await run(chainDag, { injectFailureNodeIds: ["task:a"] });

    const failures = classifyExecutionFailures(chainDag, executionResult);

    const failureC = failures.find((f) => f.nodeId === "task:c");
    expect(failureC).toBeDefined();
    expect(failureC).toMatchObject({
      classification: "DEPENDENCY",
      rootCauseNodeId: "task:a",
      rootCauseClassification: "TRANSIENT",
      dependencyChain: ["task:c", "task:b", "task:a"],
    });

    const failureB = failures.find((f) => f.nodeId === "task:b");
    expect(failureB).toBeDefined();
    expect(failureB).toMatchObject({
      classification: "DEPENDENCY",
      rootCauseNodeId: "task:a",
      rootCauseClassification: "TRANSIENT",
      dependencyChain: ["task:b", "task:a"],
    });
  });
});

/**
 * Property 5: Healing rounds are always bounded.
 *
 * Validates: Requirements 5.1
 *
 * The live-repair healing loop must never run unbounded. Driven by an
 * always-failing executor (every re-validation reports failure) and an
 * always-failing repair agent (every round proposes a patch that is "applied"
 * through the safe executor yet never actually fixes the failure), the loop is
 * forced to exhaust its bound. The design invariant asserted here is:
 *
 *   ∀ failing DAG d, ∀ configured bound b:
 *     validateAndHealExecution({ d, always-failing executor + repair agent, b })
 *       terminates
 *       ∧ status = "FAILED"
 *       ∧ rounds.length <= clamp(b, 1, 10)            (the live-repair clamp)
 *       ∧ executor re-validation invocations <= clamp(b, 1, 10)
 *       ∧ repair-agent invocations <= clamp(b, 1, 10)
 *       ∧ the final execution result and all artifacts are preserved.
 *
 * The live-repair path clamps the configured bound to the inclusive 1..10 range
 * (`boundedLiveAttempts`), so the assertion accounts for the clamp rather than
 * using the raw configured value. Everything is mock-only: the executor and
 * repair agent are deterministic doubles, the workspace filesystem is injected
 * via the in-memory `WorkspaceFs` double, and the sandbox carries a matching
 * `FILE_WRITE` approval so each `PROPOSE_PATCH` resolves to `SUCCEEDED` (the
 * patch is "applied") while the executor keeps failing. No API key, real disk,
 * process, or network is used.
 */
const HEALING_NOW = () => "2026-01-01T00:00:00.000Z";
// An absolute host path (POSIX or Windows); the injected WorkspaceFs normalizes
// internally while `resolveWithinWorkspace` uses the platform `node:path`.
const HEALING_WORKSPACE_ROOT = nodePath.resolve("validation-healing-fixture-root");
// The relative path the always-failing repair agent proposes a patch for; the
// sandbox approval below authorizes exactly this target so the patch "applies".
const HEALING_REPAIR_PATH = "src/index.ts";
const HEALING_TRIAGE = triageUserMessage("Fix the failing build and re-run the tests");
const HEALING_CONTEXT_PACK = makeContextPack(HEALING_TRIAGE);
const HEALING_RUN = makeExternalRun(generousBudget());

/** The inclusive 1..10 clamp the live-repair loop applies to the configured bound. */
function clampLiveBound(value: number): number {
  return Math.min(10, Math.max(1, Math.floor(value)));
}

/**
 * Builds a workspace sandbox whose `PROPOSE_PATCH` for {@link HEALING_REPAIR_PATH}
 * resolves to `SUCCEEDED` (a matching `FILE_WRITE` approval is supplied), so the
 * healing loop records each round as an applied repair even though the executor
 * never recovers.
 */
function buildApprovingSandbox(): WorkspaceSandboxAdapter {
  const fs = createWorkspaceFs({ root: HEALING_WORKSPACE_ROOT });
  const approvals: SandboxApproval[] = [
    { id: "approval-heal-1", scope: "FILE_WRITE", target: HEALING_REPAIR_PATH, approvedBy: "tester" },
  ];
  return new WorkspaceSandboxAdapter({
    workspaceRoot: HEALING_WORKSPACE_ROOT,
    fsImpl: fs,
    approvals,
    now: HEALING_NOW,
  });
}

describe("Property 5: healing rounds are always bounded", () => {
  // Validates: Requirement 5.1
  it("terminates in FAILED with rounds and invocations within the clamped bound and all artifacts preserved", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbFailingDag(),
        // Includes values below 1 and above 10 to exercise the 1..10 clamp.
        fc.integer({ min: 0, max: 15 }),
        async ({ dag, executionResult }, maxHealingAttempts) => {
          const counting = makeAlwaysFailingExecutor(HEALING_NOW);
          const repair = makeAlwaysFailingRepairAgent({ path: HEALING_REPAIR_PATH });
          const sandbox = buildApprovingSandbox();

          const result = await validateAndHealExecution({
            compiledDag: dag,
            executionResult,
            executor: counting.executor,
            maxHealingAttempts,
            repairAgent: repair.agent,
            sandbox,
            contextPack: HEALING_CONTEXT_PACK,
            run: HEALING_RUN,
          });

          const bound = clampLiveBound(maxHealingAttempts);

          // Termination + Req 5.1: the loop ends FAILED once the bound is reached.
          expect(result.status).toBe("FAILED");

          // Req 5.1: the number of healing rounds never exceeds the clamped bound.
          expect(result.rounds.length).toBeGreaterThanOrEqual(1);
          expect(result.rounds.length).toBeLessThanOrEqual(bound);
          // The reported attempt count is consistent with the recorded rounds.
          expect(result.attempts).toBe(result.rounds.length);

          // Req 5.1: re-validation and repair invocations stay within the bound,
          // proving the loop cannot run unbounded.
          expect(counting.calls).toBeLessThanOrEqual(bound);
          expect(repair.calls).toBeLessThanOrEqual(bound);

          // Req 5.9: the final execution result and all artifacts are preserved.
          expect(result.finalExecutionResult.status).toBe("FAILED");
          expect(result.finalExecutionResult.nodeResults).toHaveLength(dag.nodes.length);

          // Req 5.6: every round whose patch was applied references a PatchArtifact
          // id emitted by the safe executor — artifacts are never dropped.
          for (const round of result.rounds) {
            expect(round.explanation.length).toBeGreaterThan(0);
            if (round.repairApplied) {
              expect(round.patchArtifactId).toBeDefined();
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
