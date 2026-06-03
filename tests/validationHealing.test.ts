import { describe, expect, it } from "vitest";
import { executeCompiledDag, type DagExecutionResult, type ExecutorSimulatorOptions } from "../src/orchestration/executorSimulator";
import {
  classifyExecutionFailures,
  validateAndHealExecution,
} from "../src/orchestration/validationHealing";
import type { CompiledDag } from "../src/orchestration/dagCompiler";

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
