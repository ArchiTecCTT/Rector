import { describe, expect, it } from "vitest";

import { DagSchema, type Dag, type DagNode } from "../src/protocol/dag";
import { executeCompiledDag } from "../src/orchestration/executorSimulator";

const NOW = "2026-01-01T00:00:00.000Z";

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

function dag(nodes: DagNode[], edges = nodes.slice(1).map((current, index) => ({ from: nodes[index].id, to: current.id }))): Dag {
  return DagSchema.parse({
    id: "dag-executor-hardening",
    runId: "run-executor-hardening",
    version: "1",
    nodes,
    edges,
    createdAt: NOW,
  });
}

describe("executor simulator hardening", () => {
  it("honors explicit retry policy for retryable and non-retryable error codes", async () => {
    const retryableDag = dag([
      node({ id: "task:retryable", type: "LLM_EXECUTION", retryPolicy: { maxAttempts: 3, backoffMs: 0 } }),
    ], []);

    const retryable = await executeCompiledDag(retryableDag, {
      now: () => NOW,
      failAttemptsByNodeId: { "task:retryable": 1 },
      executionPolicy: { retryableErrorCodes: ["INJECTED_FAILURE"] },
    });

    expect(retryable.status).toBe("SUCCESS");
    expect(retryable.nodeResults[0]).toMatchObject({ status: "RETRIED", attempts: 2 });
    expect(retryable.events.filter((event) => event.type === "NODE_RETRIED")).toEqual([
      expect.objectContaining({ nodeId: "task:retryable", attempt: 1 }),
    ]);

    const nonRetryableDag = dag([
      node({ id: "task:non-retryable", type: "LLM_EXECUTION", retryPolicy: { maxAttempts: 3, backoffMs: 0 } }),
    ], []);

    const nonRetryable = await executeCompiledDag(nonRetryableDag, {
      now: () => NOW,
      failAttemptsByNodeId: { "task:non-retryable": 2 },
      injectedErrorCodeByNodeId: { "task:non-retryable": "PERMISSION_DENIED" },
      executionPolicy: { retryableErrorCodes: ["INJECTED_FAILURE"] },
    });

    expect(nonRetryable.status).toBe("FAILED");
    expect(nonRetryable.nodeResults[0]).toMatchObject({ status: "FAILED", attempts: 1 });
    expect(nonRetryable.events.filter((event) => event.type === "NODE_RETRIED")).toEqual([]);
  });

  it("executes validation nodes by inspecting upstream task output and classifies missing artifacts as validation failures", async () => {
    const compiled = dag([
      node({ id: "task:build", type: "FILE_OPERATION", expectedOutputs: ["dist/app.js"] }),
      node({
        id: "validate:build",
        type: "VALIDATION",
        dependsOn: ["task:build"],
        input: { targetNodeId: "task:build", expectedArtifacts: ["dist/missing.js"] },
      }),
    ]);

    const result = await executeCompiledDag(compiled, { now: () => NOW });

    expect(result.status).toBe("PARTIAL");
    expect(result.nodeResults.find((entry) => entry.nodeId === "task:build")?.status).toBe("SUCCESS");
    expect(result.nodeResults.find((entry) => entry.nodeId === "validate:build")?.error).toMatchObject({
      code: "VALIDATION_FAILED",
      nodeId: "validate:build",
    });
  });

  it("keeps event sequencing deterministic with one start and one terminal event per node and DAG_COMPLETED last", async () => {
    const compiled = dag([
      node({ id: "task:a", type: "LLM_EXECUTION", retryPolicy: { maxAttempts: 2, backoffMs: 0 } }),
      node({ id: "task:b", type: "LLM_EXECUTION", dependsOn: ["task:a"] }),
    ]);

    const result = await executeCompiledDag(compiled, {
      now: () => NOW,
      failAttemptsByNodeId: { "task:a": 1 },
    });

    expect(result.events[result.events.length - 1]).toMatchObject({ type: "DAG_COMPLETED", status: "SUCCESS" });
    for (const id of ["task:a", "task:b"]) {
      expect(result.events.filter((event) => event.type === "NODE_STARTED" && event.nodeId === id)).toHaveLength(1);
      const terminal = result.events.filter(
        (event) => ["NODE_COMPLETED", "NODE_FAILED", "NODE_SKIPPED"].includes(event.type) && event.nodeId === id,
      );
      expect(terminal).toHaveLength(1);
    }
    expect(result.events.find((event) => event.type === "NODE_RETRIED" && event.nodeId === "task:a")).toMatchObject({
      attempt: 1,
    });
  });
});
