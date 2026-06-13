import { describe, expect, it } from "vitest";
import { ProtocolEnvelopeSchema } from "../src/protocol/envelope";
import { validateDag } from "../src/protocol/dag";
import { RUN_PHASES } from "../src/protocol/phases";
import { RunEventSchema, RUN_EVENT_TYPES } from "../src/protocol/events";

const expectedPhases = [
  "CHAT_RECEIVED",
  "TRIAGE",
  "CONTEXT_BUILDING",
  "PLANNING",
  "SKEPTIC_REVIEW",
  "CRUCIBLE",
  "DAG_COMPILATION",
  "EXECUTING",
  "VALIDATING",
  "HEALING",
  "SYNTHESIZING",
  "DONE",
  "NEEDS_DECISION",
  "FAILED",
  "ABORTED",
] as const;

const validEnvelope = {
  version: "0.1.0",
  messageId: "msg-1",
  runId: "run-1",
  correlationId: "corr-1",
  sender: "chat-api",
  receiver: "orchestrator",
  phase: "TRIAGE",
  content: { text: "hello" },
  metadata: {
    timestamp: "2026-06-03T00:00:00.000Z",
    trace: { traceId: "trace-1" },
    budget: { maxUsd: 1, maxRuntimeMs: 1000 },
  },
};

const validDag = {
  id: "dag-1",
  runId: "run-1",
  version: "0.1.0",
  nodes: [
    {
      id: "plan",
      type: "LLM_EXECUTION",
      dependsOn: [],
      retryPolicy: { maxAttempts: 1, backoffMs: 0 },
      timeoutMs: 1000,
    },
    {
      id: "validate",
      type: "VALIDATION",
      dependsOn: ["plan"],
      retryPolicy: { maxAttempts: 2, backoffMs: 10, maxBackoffMs: 100 },
      timeoutMs: 1000,
    },
  ],
  edges: [{ from: "plan", to: "validate" }],
  validationPolicy: { requiredNodeIds: ["validate"] },
  budgetPolicy: { maxRuntimeMs: 5000 },
  createdAt: "2026-06-03T00:00:00.000Z",
};

describe("protocol phases", () => {
  it("matches the architecture phase list exactly", () => {
    expect(RUN_PHASES).toEqual(expectedPhases);
  });
});

describe("protocol envelope", () => {
  it("accepts a valid envelope", () => {
    const parsed = ProtocolEnvelopeSchema.parse(validEnvelope);
    expect(parsed.phase).toBe("TRIAGE");
    expect(parsed.metadata?.trace?.traceId).toBe("trace-1");
  });

  it("rejects an invalid phase", () => {
    expect(() =>
      ProtocolEnvelopeSchema.parse({
        ...validEnvelope,
        phase: "INTAKE",
      })
    ).toThrow();
  });

  it("rejects missing required fields", () => {
    const { runId: _runId, ...missingRunId } = validEnvelope;
    expect(() => ProtocolEnvelopeSchema.parse(missingRunId)).toThrow();
  });
});

describe("DAG validation", () => {
  it("accepts a simple valid DAG", () => {
    expect(validateDag(validDag)).toEqual({ valid: true, errors: [] });
  });

  it("rejects duplicate node IDs", () => {
    const dag = {
      ...validDag,
      nodes: [validDag.nodes[0], { ...validDag.nodes[0] }],
      edges: [],
    };

    const result = validateDag(dag);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("Duplicate node id: plan");
  });

  it("rejects a missing dependency", () => {
    const dag = {
      ...validDag,
      nodes: [{ ...validDag.nodes[0], dependsOn: ["missing"] }],
      edges: [],
    };

    const result = validateDag(dag);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("missing dependency: missing");
  });

  it("rejects a dependency cycle", () => {
    const dag = {
      ...validDag,
      nodes: [
        { ...validDag.nodes[0], id: "a", dependsOn: ["b"] },
        { ...validDag.nodes[1], id: "b", dependsOn: ["a"] },
      ],
      edges: [],
    };

    const result = validateDag(dag);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("Cycle detected");
  });

  it("rejects invalid retry policy and timeout values", () => {
    const dag = {
      ...validDag,
      nodes: [
        {
          ...validDag.nodes[0],
          retryPolicy: { maxAttempts: 0, backoffMs: -1 },
          timeoutMs: 0,
        },
      ],
      edges: [],
    };

    const result = validateDag(dag);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("timeoutMs must be a positive integer");
    expect(result.errors.join("\n")).toContain("retryPolicy.maxAttempts must be a positive integer");
    expect(result.errors.join("\n")).toContain("retryPolicy.backoffMs must be a non-negative integer");
  });

  it("rejects self-loop edges", () => {
    const dag = {
      ...validDag,
      edges: [{ from: "plan", to: "plan" }],
    };

    const result = validateDag(dag);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("Edge cannot be a self-loop: plan -> plan");
  });
});

describe("protocol run events", () => {
  const validRunEvent = {
    id: "evt-1",
    runId: "run-1",
    type: "RUN_CREATED",
    phase: "TRIAGE",
    payload: { foo: "bar" },
    traceId: "trace-123",
    createdAt: "2026-06-03T00:00:00.000Z",
  };

  it("exposes expected run event types list", () => {
    expect(RUN_EVENT_TYPES).toContain("RUN_CREATED");
    expect(RUN_EVENT_TYPES).toContain("RUN_COMPLETED");
    expect(RUN_EVENT_TYPES).toContain("DAG_NODE_STARTED");
    expect(RUN_EVENT_TYPES).toContain("VALIDATION_PASSED");
    expect(RUN_EVENT_TYPES).toContain("TOOL_INVOKED");
    expect(RUN_EVENT_TYPES).toContain("TOOL_COMPLETED");
  });

  it("accepts a valid run event", () => {
    const parsed = RunEventSchema.parse(validRunEvent);
    expect(parsed.id).toBe("evt-1");
    expect(parsed.type).toBe("RUN_CREATED");
    expect(parsed.phase).toBe("TRIAGE");
    expect(parsed.createdAt).toBe("2026-06-03T00:00:00.000Z");
  });

  it("rejects an invalid event type", () => {
    expect(() =>
      RunEventSchema.parse({
        ...validRunEvent,
        type: "INVALID_EVENT_TYPE",
      })
    ).toThrow();
  });

  it("rejects an invalid phase", () => {
    expect(() =>
      RunEventSchema.parse({
        ...validRunEvent,
        phase: "INVALID_PHASE",
      })
    ).toThrow();
  });

  it("rejects an invalid createdAt datetime", () => {
    expect(() =>
      RunEventSchema.parse({
        ...validRunEvent,
        createdAt: "2026-06-03", // Not an ISO datetime string
      })
    ).toThrow();
  });

  it("rejects missing required fields", () => {
    const { runId: _runId, ...missingRunId } = validRunEvent;
    expect(() => RunEventSchema.parse(missingRunId)).toThrow();
  });
});
