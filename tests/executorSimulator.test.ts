import { describe, expect, it } from "vitest";
import { executeCompiledDag } from "../src/orchestration/executorSimulator";
import type { CompiledDag } from "../src/orchestration/dagCompiler";

const NOW = "2026-01-01T00:00:00.000Z";

function dag(overrides: Partial<CompiledDag> = {}): CompiledDag {
  return {
    id: "dag-executor-test",
    runId: "run-executor-test",
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
      {
        id: "validate:b",
        type: "VALIDATION",
        dependsOn: ["task:b"],
        toolPermissions: ["fake.local", "local.validation"],
        retryPolicy: { maxAttempts: 1, backoffMs: 0 },
        timeoutMs: 100,
      },
    ],
    edges: [
      { from: "task:a", to: "task:b" },
      { from: "task:b", to: "validate:b" },
    ],
    createdAt: NOW,
    ...overrides,
  };
}

describe("executor simulator", () => {
  it("executes a successful DAG in dependency order", async () => {
    const result = await executeCompiledDag(dag(), { now: () => NOW });

    expect(result.status).toBe("SUCCESS");
    expect(result.nodeResults.map((node) => node.nodeId)).toEqual(["task:a", "task:b", "validate:b"]);
    expect(result.nodeResults.every((node) => node.status === "SUCCESS")).toBe(true);
    expect(result.events.map((event) => event.type)).toContain("DAG_COMPLETED");
  });

  it("retries an injected node failure until retry policy is exhausted", async () => {
    const result = await executeCompiledDag(
      dag({
        nodes: [
          {
            id: "task:retry",
            type: "LLM_EXECUTION",
            dependsOn: [],
            toolPermissions: ["fake.local"],
            retryPolicy: { maxAttempts: 3, backoffMs: 0 },
            timeoutMs: 100,
          },
        ],
        edges: [],
      }),
      { injectFailureNodeIds: ["task:retry"], now: () => NOW }
    );

    expect(result.status).toBe("FAILED");
    expect(result.nodeResults[0]).toMatchObject({ nodeId: "task:retry", status: "FAILED", attempts: 3 });
    expect(result.nodeResults[0].error).toMatchObject({ code: "INJECTED_FAILURE", nodeId: "task:retry" });
    expect(result.events.filter((event) => event.type === "NODE_RETRIED")).toHaveLength(2);
  });

  it("skips downstream nodes when a dependency failed", async () => {
    const result = await executeCompiledDag(dag(), { injectFailureNodeIds: ["task:a"], now: () => NOW });

    expect(result.status).toBe("PARTIAL");
    expect(result.nodeResults.map((node) => [node.nodeId, node.status])).toEqual([
      ["task:a", "FAILED"],
      ["task:b", "SKIPPED"],
      ["validate:b", "SKIPPED"],
    ]);
    expect(result.nodeResults[1].error).toMatchObject({ code: "DEPENDENCY_FAILED" });
  });

  it("fails timed-out nodes deterministically without waiting", async () => {
    const started = Date.now();
    const result = await executeCompiledDag(
      dag({
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
      }),
      { simulatedDurationMsByNodeId: { "task:slow": 10_000 }, now: () => NOW }
    );

    expect(Date.now() - started).toBeLessThan(500);
    expect(result.status).toBe("FAILED");
    expect(result.nodeResults[0]).toMatchObject({ status: "FAILED", durationMs: 10_000 });
    expect(result.nodeResults[0].error).toMatchObject({ code: "TIMEOUT" });
  });

  it("denies unsafe shell permissions by default", async () => {
    const result = await executeCompiledDag(
      dag({
        nodes: [
          {
            id: "task:shell",
            type: "SHELL_COMMAND",
            dependsOn: [],
            toolPermissions: ["unsafe.shell"],
            retryPolicy: { maxAttempts: 3, backoffMs: 0 },
            timeoutMs: 100,
          },
        ],
        edges: [],
      }),
      { now: () => NOW }
    );

    expect(result.status).toBe("FAILED");
    expect(result.nodeResults[0]).toMatchObject({ nodeId: "task:shell", status: "FAILED", attempts: 1 });
    expect(result.nodeResults[0].error).toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("partially fails a node but eventually succeeds via failAttemptsByNodeId", async () => {
    const result = await executeCompiledDag(
      dag({
        nodes: [
          {
            id: "task:partial-retry",
            type: "LLM_EXECUTION",
            dependsOn: [],
            toolPermissions: ["fake.local"],
            retryPolicy: { maxAttempts: 3, backoffMs: 0 },
            timeoutMs: 100,
          },
        ],
        edges: [],
      }),
      { failAttemptsByNodeId: { "task:partial-retry": 2 }, now: () => NOW }
    );

    expect(result.status).toBe("SUCCESS");
    expect(result.nodeResults[0]).toMatchObject({
      nodeId: "task:partial-retry",
      status: "RETRIED",
      attempts: 3,
    });
    expect(result.events.filter((event) => event.type === "NODE_RETRIED")).toHaveLength(2);
    expect(result.events.filter((event) => event.type === "NODE_COMPLETED")).toHaveLength(1);
    expect(result.events.find((event) => event.type === "NODE_COMPLETED")).toMatchObject({
      nodeId: "task:partial-retry",
      status: "RETRIED",
    });
  });

  it("injects node failures by node types", async () => {
    const result = await executeCompiledDag(
      dag({
        nodes: [
          {
            id: "task:llm",
            type: "LLM_EXECUTION",
            dependsOn: [],
            toolPermissions: ["fake.local"],
            retryPolicy: { maxAttempts: 1, backoffMs: 0 },
            timeoutMs: 100,
          },
          {
            id: "task:file",
            type: "FILE_OPERATION",
            dependsOn: [],
            toolPermissions: ["fake.local"],
            retryPolicy: { maxAttempts: 1, backoffMs: 0 },
            timeoutMs: 100,
          },
        ],
        edges: [],
      }),
      { injectFailureNodeTypes: ["LLM_EXECUTION"], now: () => NOW }
    );

    expect(result.status).toBe("PARTIAL");
    expect(result.nodeResults.find((n) => n.nodeId === "task:llm")).toMatchObject({
      status: "FAILED",
    });
    expect(result.nodeResults.find((n) => n.nodeId === "task:file")).toMatchObject({
      status: "SUCCESS",
    });
  });

  it("fails nodes due to timeout using simulatedDurationMsByNodeType", async () => {
    const result = await executeCompiledDag(
      dag({
        nodes: [
          {
            id: "task:slow-type",
            type: "VALIDATION",
            dependsOn: [],
            toolPermissions: ["fake.local"],
            retryPolicy: { maxAttempts: 1, backoffMs: 0 },
            timeoutMs: 50,
          },
        ],
        edges: [],
      }),
      { simulatedDurationMsByNodeType: { VALIDATION: 100 }, now: () => NOW }
    );

    expect(result.status).toBe("FAILED");
    expect(result.nodeResults[0]).toMatchObject({
      nodeId: "task:slow-type",
      status: "FAILED",
      durationMs: 100,
    });
    expect(result.nodeResults[0].error).toMatchObject({
      code: "TIMEOUT",
    });
  });

  it("fails execution with DAG_VALIDATION_FAILED for Zod schema parse errors", async () => {
    const invalidDag = {
      id: "invalid-dag",
      runId: "invalid-run",
      nodes: [],
    } as any;

    const result = await executeCompiledDag(invalidDag, { now: () => NOW });

    expect(result.status).toBe("FAILED");
    expect(result.error).toMatchObject({
      code: "DAG_VALIDATION_FAILED",
    });
    expect(result.error?.message).toContain("Required");
  });

  it("fails execution with DAG_VALIDATION_FAILED for custom DAG cycle/validation errors", async () => {
    const cyclicDag = dag({
      nodes: [
        {
          id: "task:a",
          type: "LLM_EXECUTION",
          dependsOn: ["task:b"],
          toolPermissions: ["fake.local"],
          retryPolicy: { maxAttempts: 1, backoffMs: 0 },
          timeoutMs: 100,
        },
        {
          id: "task:b",
          type: "FILE_OPERATION",
          dependsOn: ["task:a"],
          toolPermissions: ["fake.local"],
          retryPolicy: { maxAttempts: 1, backoffMs: 0 },
          timeoutMs: 100,
        },
      ],
      edges: [
        { from: "task:a", to: "task:b" },
        { from: "task:b", to: "task:a" },
      ],
    });

    const result = await executeCompiledDag(cyclicDag, { now: () => NOW });

    expect(result.status).toBe("FAILED");
    expect(result.error).toMatchObject({
      code: "DAG_VALIDATION_FAILED",
      message: "Cycle detected in DAG dependencies",
    });
  });

  it("explicitly sets the overall DAG status to PARTIAL if some nodes succeed and others fail", async () => {
    const result = await executeCompiledDag(
      dag({
        nodes: [
          {
            id: "task:succeed",
            type: "LLM_EXECUTION",
            dependsOn: [],
            toolPermissions: ["fake.local"],
            retryPolicy: { maxAttempts: 1, backoffMs: 0 },
            timeoutMs: 100,
          },
          {
            id: "task:fail",
            type: "FILE_OPERATION",
            dependsOn: [],
            toolPermissions: ["fake.local"],
            retryPolicy: { maxAttempts: 1, backoffMs: 0 },
            timeoutMs: 100,
          },
        ],
        edges: [],
      }),
      { injectFailureNodeIds: ["task:fail"], now: () => NOW }
    );

    expect(result.status).toBe("PARTIAL");
    expect(result.nodeResults).toHaveLength(2);
    expect(result.nodeResults.find((r) => r.nodeId === "task:succeed")?.status).toBe("SUCCESS");
    expect(result.nodeResults.find((r) => r.nodeId === "task:fail")?.status).toBe("FAILED");
  });
});
