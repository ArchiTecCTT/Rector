import { describe, expect, it } from "vitest";

import {
  FACT_SCHEMA_VERSION,
  FactFamilyKindSchema,
  FactProducerSchema,
  FactTrustLevelSchema,
  RectorFactSchema,
  createFactId,
  createFactScope,
  createFactTrust,
  graphRef,
  userProvenance,
  type RectorFact,
} from "../../src/facts";

const CREATED_AT = "2026-06-28T00:00:00.000Z";

function systemProvenance() {
  return { sourceType: "system" as const, systemId: "phase-2a-test" };
}

function draftFact(overrides: Partial<RectorFact> & { kind: RectorFact["kind"] }): Omit<RectorFact, "factId"> {
  const { kind, ...rest } = overrides;
  return {
    schemaVersion: FACT_SCHEMA_VERSION,
    kind,
    runId: "run-phase-2a",
    createdAt: CREATED_AT,
    producer: "system",
    provenance: [systemProvenance()],
    trust: createFactTrust("schema_valid"),
    scope: createFactScope({ workspacePaths: ["src/facts/schemas.ts"] }),
    redactionState: "none",
    ...rest,
  } as Omit<RectorFact, "factId">;
}

function fact(overrides: Partial<RectorFact> & { kind: RectorFact["kind"] }): RectorFact {
  const draft = draftFact(overrides);
  return { ...draft, factId: createFactId(draft) } as RectorFact;
}

describe("Rector fact schemas", () => {
  it("accepts every required producer and trust level", () => {
    const producers = ["user", "system", "cartographer", "tool_registry", "capability_eval", "global_harness", "llm_shadow", "validator", "human_operator"];
    const trusts = ["raw", "schema_valid", "provenance_attached", "graph_grounded", "scope_checked", "validation_linked", "rejected", "insufficient_evidence"];

    expect(producers.every((producer) => FactProducerSchema.safeParse(producer).success)).toBe(true);
    expect(trusts.every((trust) => FactTrustLevelSchema.safeParse(trust).success)).toBe(true);
    expect(FactProducerSchema.safeParse("fake_provider").success).toBe(false);
    expect(FactTrustLevelSchema.safeParse("trusted_because_llm_said_so").success).toBe(false);
  });

  it("parses a strict intent fact envelope with schemaVersion rector.fact.v1", () => {
    const parsed = RectorFactSchema.parse(fact({ kind: "intent", intent: "Implement typed facts", confidence: 0.9 }));

    expect(parsed.schemaVersion).toBe(FACT_SCHEMA_VERSION);
    expect(parsed.factId).toMatch(/^fact_[a-f0-9]{40}$/);
    expect(parsed.kind).toBe("intent");
  });

  it("rejects invalid extra fields and unsupported schemaVersion", () => {
    const valid = fact({ kind: "task_constraint", constraint: "No provider path changes" });

    expect(RectorFactSchema.safeParse({ ...valid, unexpected: "nope" }).success).toBe(false);
    expect(RectorFactSchema.safeParse({ ...valid, schemaVersion: "rector.fact.v2" }).success).toBe(false);
  });

  it("rejects missing provenance and requires explicit user provenance for raw user intent facts", () => {
    const noProvenance = fact({ kind: "success_criteria", criteria: "Tests pass", provenance: [] });
    const rawUserIntentWithoutUserProvenance = fact({
      kind: "intent",
      producer: "user",
      trust: createFactTrust("raw"),
      provenance: [],
      intent: "Please implement facts",
    });
    const rawUserIntentWithUserProvenance = fact({
      kind: "intent",
      producer: "user",
      trust: createFactTrust("raw"),
      provenance: [userProvenance("msg-1")],
      intent: "Please implement facts",
    });

    expect(RectorFactSchema.safeParse(noProvenance).success).toBe(false);
    expect(RectorFactSchema.safeParse(rawUserIntentWithoutUserProvenance).success).toBe(false);
    expect(RectorFactSchema.safeParse(rawUserIntentWithUserProvenance).success).toBe(true);
  });

  it("requires graph grounding evidence for graph_grounded trust", () => {
    const missingGraph = fact({ kind: "file_context", path: "src/facts/schemas.ts", trust: createFactTrust("graph_grounded") });
    const withGraph = fact({
      kind: "file_context",
      path: "src/facts/schemas.ts",
      trust: createFactTrust("graph_grounded"),
      provenance: [{ sourceType: "graph", graph: graphRef({ snapshotId: "snap-1", nodeId: "file:src/facts/schemas.ts" }) }],
      scope: createFactScope({ graphRefs: [graphRef({ snapshotId: "snap-1", nodeId: "file:src/facts/schemas.ts" })] }),
    });

    expect(RectorFactSchema.safeParse(missingGraph).success).toBe(false);
    expect(RectorFactSchema.safeParse(withGraph).success).toBe(true);
  });

  it("requires explicit validation refs for validation_linked trust", () => {
    const missingValidation = fact({ kind: "fact_schema_validation", targetFactId: "fact_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", valid: true, trust: createFactTrust("validation_linked") });
    const validation = { refType: "validation" as const, validationId: "schema-check-1", validator: "zod", status: "passed" as const, checkedAt: CREATED_AT };
    const linked = fact({
      kind: "fact_schema_validation",
      targetFactId: "fact_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      valid: true,
      trust: { level: "validation_linked", validationRefs: ["schema-check-1"] },
      provenance: [{ sourceType: "validation", validation }],
    });

    expect(RectorFactSchema.safeParse(missingValidation).success).toBe(false);
    expect(RectorFactSchema.safeParse(linked).success).toBe(true);
  });

  it("exposes all Phase 2A fact family kind contracts", () => {
    const expectedKinds = [
      "intent",
      "task_constraint",
      "success_criteria",
      "risk_tolerance",
      "unknown_or_ambiguity",
      "cartographer_snapshot",
      "graph_node_ref",
      "graph_edge_ref",
      "context_slice",
      "file_context",
      "symbol_context",
      "impact_context",
      "test_link_context",
      "capability_graph_context",
      "tool_definition",
      "tool_call",
      "tool_result",
      "tool_failure",
      "capability_request",
      "capability_call",
      "capability_evidence",
      "capability_coverage",
      "capability_warning",
      "capability_failure",
      "raw_artifact",
      "raw_artifact_chunk",
      "artifact_hash",
      "artifact_redaction",
      "plan_candidate",
      "critique",
      "validation_obligation",
      "repair_candidate",
      "memory_patch_candidate",
      "fact_schema_validation",
      "fact_grounding_validation",
      "fact_scope_validation",
      "fact_provenance_validation",
      "fact_replay_validation",
    ];

    expect(expectedKinds.every((kind) => FactFamilyKindSchema.safeParse(kind).success)).toBe(true);
  });

  it("neutralizes prototype pollution keys inside JSON-compatible tool args", () => {
    const parsedJson = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    const draft = draftFact({ kind: "tool_call", producer: "tool_registry", callId: "call-1", toolName: "rg" });
    const toolCall = { ...draft, factId: "fact_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", args: parsedJson };

    const result = RectorFactSchema.safeParse(toolCall);

    expect(result.success).toBe(true);
    if (result.success && result.data.kind === "tool_call") {
      expect(Object.prototype.hasOwnProperty.call((result.data as { args: unknown }).args, "__proto__")).toBe(false);
    }
  });

  it("accepts destructive tool risk for ToolRegistry compatibility", () => {
    const destructiveTool = fact({
      kind: "tool_definition",
      producer: "tool_registry",
      toolName: "workspace.apply_patch",
      description: "Apply a patch to the workspace",
      risk: "destructive",
      requiresApproval: true,
      requiresSandbox: false,
    });

    expect(RectorFactSchema.safeParse(destructiveTool).success).toBe(true);
  });

  it("parses explicit tool failure facts for ToolRegistry adapters", () => {
    const failure = fact({
      kind: "tool_failure",
      producer: "tool_registry",
      callId: "call-1",
      toolName: "workspace.validate",
      code: "VALIDATION_FAILED",
      message: "validator did not run",
      retryable: false,
    });

    expect(RectorFactSchema.safeParse(failure).success).toBe(true);
  });

  it("requires capability evidence to carry source refs or explicit insufficient_evidence", () => {
    const artifactEvidence = fact({
      kind: "capability_evidence",
      producer: "capability_eval",
      capabilityId: "capability.grounding",
      summary: "Grounded in raw artifact",
      evidence: [{ refType: "artifact", uri: "artifact://call-1/rg.txt" }],
    });
    const insufficient = fact({
      kind: "capability_evidence",
      producer: "capability_eval",
      capabilityId: "capability.grounding",
      summary: "Missing source line",
      evidence: [{ refType: "insufficient_evidence", reason: "artifact did not include line numbers", missing: ["line span"], searched: ["artifact://call-1/rg.txt"] }],
      trust: createFactTrust("insufficient_evidence"),
    });

    expect(RectorFactSchema.safeParse(artifactEvidence).success).toBe(true);
    expect(RectorFactSchema.safeParse(insufficient).success).toBe(true);
  });

  it("exports a user provenance helper compatible with raw user intent", () => {
    const rawUserIntent = fact({
      kind: "intent",
      producer: "user",
      trust: createFactTrust("raw"),
      provenance: [userProvenance("msg-1")],
      intent: "Add fact contracts",
    });

    expect(RectorFactSchema.safeParse(rawUserIntent).success).toBe(true);
  });
});
