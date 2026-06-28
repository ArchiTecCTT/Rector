import { describe, expect, it } from "vitest";

import {
  FACT_SCHEMA_VERSION,
  createFactId,
  createFactScope,
  createFactTrust,
  graphRef,
  userProvenance,
  validateFactArtifactRefs,
  validateFactBatch,
  validateFactGrounding,
  validateFactProvenance,
  validateFactSchema,
  validateFactScope,
  validateFactTrustTransition,
  type FactTrust,
  type RectorFact,
} from "../../src/facts";

const CREATED_AT = "2026-06-28T00:00:00.000Z";
const TARGET_FACT_ID = "fact_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function systemProvenance() {
  return { sourceType: "system" as const, systemId: "phase-2d-test" };
}

function artifact(uri = "artifact://phase-2d/rg.txt") {
  return { refType: "artifact" as const, uri, sha256: "b".repeat(64), contentType: "text/plain", sizeBytes: 128 };
}

function baseDraft(overrides: Partial<RectorFact> & { kind?: RectorFact["kind"] } = {}): Omit<RectorFact, "factId"> {
  const kind = overrides.kind ?? "intent";
  const defaultPayload = kind === "intent" ? { intent: "Validate facts" } : {};
  return {
    schemaVersion: FACT_SCHEMA_VERSION,
    kind,
    runId: "run-phase-2d",
    createdAt: CREATED_AT,
    producer: "system",
    provenance: [systemProvenance()],
    trust: createFactTrust("schema_valid"),
    scope: createFactScope({ workspacePaths: ["src/facts/validation.ts"] }),
    redactionState: "none",
    ...defaultPayload,
    ...overrides,
  } as Omit<RectorFact, "factId">;
}

function fact(overrides: Partial<RectorFact> & { kind?: RectorFact["kind"] } = {}): RectorFact {
  const draft = baseDraft(overrides);
  return { ...draft, factId: createFactId(draft) } as RectorFact;
}

function trust(level: FactTrust["level"]): FactTrust {
  return createFactTrust(level);
}

describe("Phase 2D fact validation gates", () => {
  it("validates strict known schema versions, kinds, and JSON-compatible payloads", () => {
    const valid = fact({ kind: "task_constraint", constraint: "Phase 2D only" });
    const invalidVersion = { ...valid, schemaVersion: "rector.fact.v2" };
    const invalidKind = { ...valid, kind: "model_claim" };
    const nonJson = { ...valid, constraint: () => "not durable" };

    expect(validateFactSchema(valid).ok).toBe(true);
    expect(validateFactSchema(invalidVersion).ok).toBe(false);
    expect(validateFactSchema(invalidKind).ok).toBe(false);
    expect(validateFactSchema(nonJson).errors.some((entry) => entry.code === "invalid_type" || entry.code === "non_json_value")).toBe(true);
  });

  it("requires provenance for non-raw facts and explicit user provenance for raw user intent", () => {
    const nonRawNoProvenance = fact({ kind: "success_criteria", criteria: "Tests pass", provenance: [] });
    const rawUserNoUserProvenance = fact({ producer: "user", trust: trust("raw"), provenance: [systemProvenance()] });
    const rawUser = fact({ producer: "user", trust: trust("raw"), provenance: [userProvenance("msg-1")] });

    expect(validateFactProvenance(nonRawNoProvenance).ok).toBe(false);
    expect(validateFactProvenance(rawUserNoUserProvenance).ok).toBe(false);
    expect(validateFactProvenance(rawUser).ok).toBe(true);
  });

  it("fails live LLM provenance closed when raw model artifacts or non-LLM support are absent", () => {
    const noArtifact = fact({
      kind: "intent",
      producer: "llm_shadow",
      provenance: [{ sourceType: "llm_shadow", providerId: "openai", modelId: "gpt-test" }],
      trust: trust("provenance_attached"),
    });
    const selfCertified = fact({
      kind: "intent",
      producer: "llm_shadow",
      provenance: [{ sourceType: "llm_shadow", providerId: "openai", modelId: "gpt-test", artifact: artifact() }],
      trust: trust("graph_grounded"),
      scope: createFactScope({ graphRefs: [graphRef({ snapshotId: "snap-1", nodeId: "node:file" })] }),
    });
    const supported = fact({
      kind: "intent",
      producer: "llm_shadow",
      provenance: [
        { sourceType: "llm_shadow", providerId: "openai", modelId: "gpt-test", artifact: artifact() },
        { sourceType: "artifact", artifact: artifact("artifact://phase-2d/user-request.txt") },
      ],
      trust: trust("provenance_attached"),
    });

    expect(validateFactProvenance(noArtifact).errors.map((entry) => entry.code)).toContain("missing_llm_artifact");
    expect(validateFactProvenance(selfCertified).errors.map((entry) => entry.code)).toContain("llm_self_certification");
    expect(validateFactProvenance(supported).ok).toBe(true);
  });

  it("validates graph grounding refs and treats not_found only as negative evidence", () => {
    const graphGrounded = fact({
      kind: "file_context",
      path: "src/facts/validation.ts",
      trust: trust("graph_grounded"),
      provenance: [{ sourceType: "graph", graph: graphRef({ snapshotId: "snap-1", nodeId: "file:src/facts/validation.ts", queryStatus: "ok" }) }],
      scope: createFactScope({ graphRefs: [graphRef({ snapshotId: "snap-1", nodeId: "file:src/facts/validation.ts", queryStatus: "ok" })] }),
    });
    const notFoundAsSuccess = fact({
      kind: "context_slice",
      query: "missing symbol",
      status: "ok",
      evidence: [graphRef({ snapshotId: "snap-1", queryStatus: "not_found" })],
    });
    const notFoundNegative = fact({
      kind: "context_slice",
      query: "missing symbol",
      status: "not_found",
      evidence: [graphRef({ snapshotId: "snap-1", queryStatus: "not_found" })],
      trust: trust("insufficient_evidence"),
    });

    expect(validateFactGrounding(graphGrounded).ok).toBe(true);
    expect(validateFactGrounding(notFoundAsSuccess).errors.map((entry) => entry.code)).toContain("not_found_as_success");
    expect(validateFactGrounding(notFoundNegative).ok).toBe(true);
  });

  it("rejects unsafe scope paths and unsafe source spans without throwing", () => {
    const traversal = { ...fact({ kind: "file_context", path: "src/facts/validation.ts" }), path: "../outside.ts" };
    const badSpan = {
      ...fact({ kind: "capability_evidence", capabilityId: "capability.grounding", summary: "bad span", evidence: [{ refType: "source_span", path: "src/facts/validation.ts", startLine: 5, endLine: 1 }] }),
    };

    expect(validateFactScope(traversal).ok).toBe(false);
    expect(validateFactGrounding(badSpan).ok).toBe(false);
  });

  it("requires artifact refs to use allowed artifact URI schemes", () => {
    const fileArtifact = fact({ kind: "raw_artifact", artifact: artifact("file:///tmp/raw.txt"), byteCount: 20, tokenCount: 4 });
    const safeArtifact = fact({ kind: "raw_artifact", artifact: artifact("artifact://phase-2d/raw.txt"), byteCount: 20, tokenCount: 4 });

    expect(validateFactArtifactRefs(fileArtifact).errors.map((entry) => entry.code)).toContain("unsafe_artifact_uri");
    expect(validateFactArtifactRefs(safeArtifact).ok).toBe(true);
  });

  it("rejects impossible trust promotions and terminal facts without new evidence", () => {
    const previous = fact({ kind: "intent", producer: "user", trust: trust("raw"), provenance: [userProvenance("msg-1")] });
    const jumped = { ...previous, trust: { level: "validation_linked" as const, validationRefs: ["validation-1"] }, provenance: [{ sourceType: "validation" as const, validation: { refType: "validation" as const, validationId: "validation-1", validator: "unit", status: "passed" as const } }] };
    const terminal = fact({ kind: "unknown_or_ambiguity", question: "Need path", trust: trust("insufficient_evidence") });
    const revivedSameFact = { ...terminal, trust: trust("schema_valid") };

    expect(validateFactTrustTransition({ fact: jumped, previousFact: previous }).errors.map((entry) => entry.code)).toContain("trust_jump");
    expect(validateFactTrustTransition({ fact: revivedSameFact, previousFact: terminal }).errors.map((entry) => entry.code)).toContain("terminal_without_new_evidence");
  });

  it("validates batches by accepting safe facts and returning rejected validation outputs for failed gates", () => {
    const safe = fact({ kind: "task_constraint", constraint: "Do not edit docs" });
    const unsafe = { ...safe, factId: TARGET_FACT_ID, scope: { scopeType: "workspace", workspacePaths: ["../outside"], graphRefs: [], taskIds: [] } };

    const batch = validateFactBatch([safe, unsafe]);

    expect(batch.ok).toBe(false);
    expect(batch.acceptedFacts).toHaveLength(1);
    expect(batch.rejectedFacts).toHaveLength(1);
    expect(batch.rejectedFacts[0]?.status).toBe("failed");
  });

  it("rejects invalid trust jumps during batch validation using the last accepted prior fact", () => {
    const previous = fact({ kind: "intent", producer: "user", trust: trust("raw"), provenance: [userProvenance("msg-1")] });
    const jumped = {
      ...previous,
      trust: { level: "validation_linked" as const, validationRefs: ["validation-1"] },
      provenance: [
        {
          sourceType: "validation" as const,
          validation: { refType: "validation" as const, validationId: "validation-1", validator: "unit", status: "passed" as const },
        },
      ],
    };

    const batch = validateFactBatch([previous, jumped]);

    expect(batch.ok).toBe(false);
    expect(batch.acceptedFacts).toHaveLength(1);
    expect(batch.rejectedFacts).toHaveLength(1);
    expect(batch.rejectedFacts[0]?.errors.map((entry) => entry.code)).toContain("trust_jump");
  });

  it("rejects terminal fact revival during batch validation without new supporting evidence", () => {
    const terminal = fact({ kind: "unknown_or_ambiguity", question: "Need path", trust: trust("insufficient_evidence") });
    const revivedSameFact = { ...terminal, trust: trust("schema_valid") };

    const batch = validateFactBatch([terminal, revivedSameFact]);

    expect(batch.ok).toBe(false);
    expect(batch.acceptedFacts).toHaveLength(1);
    expect(batch.rejectedFacts).toHaveLength(1);
    expect(batch.rejectedFacts[0]?.errors.map((entry) => entry.code)).toContain("terminal_without_new_evidence");
  });
});
