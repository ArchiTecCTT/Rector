import { describe, expect, it } from "vitest";

import {
  FACT_SCHEMA_VERSION,
  createFactId,
  createFactScope,
  createFactTrust,
  validateFactBatch,
  validateFactRedactionState,
  validateFactSchema,
  validateFactScope,
  type RectorFact,
} from "../../src/facts";

const CREATED_AT = "2026-06-28T00:00:00.000Z";

function systemProvenance() {
  return { sourceType: "system" as const, systemId: "phase-2d-security-test" };
}

function artifact(uri = "artifact://phase-2d/raw.txt") {
  return { refType: "artifact" as const, uri, contentType: "text/plain", sizeBytes: 100 };
}

function draft(overrides: Partial<RectorFact> & { kind?: RectorFact["kind"] } = {}): Omit<RectorFact, "factId"> {
  const kind = overrides.kind ?? "tool_result";
  const defaultPayload = kind === "tool_result" ? { callId: "call-security", toolName: "shell.capture", ok: true, output: "safe output" } : {};
  return {
    schemaVersion: FACT_SCHEMA_VERSION,
    kind,
    runId: "run-phase-2d-security",
    createdAt: CREATED_AT,
    producer: "tool_registry",
    provenance: [systemProvenance()],
    trust: createFactTrust("schema_valid"),
    scope: createFactScope({ workspacePaths: ["src/facts/validation.ts"] }),
    redactionState: "none",
    ...defaultPayload,
    ...overrides,
  } as Omit<RectorFact, "factId">;
}

function fact(overrides: Partial<RectorFact> & { kind?: RectorFact["kind"] } = {}): RectorFact {
  const value = draft(overrides);
  return { ...value, factId: createFactId(value) } as RectorFact;
}

describe("Phase 2D fact security gates", () => {
  it("rejects path traversal before a fact can become trusted success", () => {
    const traversal = { ...fact({ kind: "file_context", producer: "cartographer", path: "src/facts/validation.ts" }), scope: { scopeType: "workspace", workspacePaths: ["src/../secrets.env"], graphRefs: [], taskIds: [] } };

    const schema = validateFactSchema(traversal);
    const scope = validateFactScope(traversal);
    const batch = validateFactBatch([traversal]);

    expect(schema.ok).toBe(false);
    expect(scope.ok).toBe(false);
    expect(batch.acceptedFacts).toHaveLength(0);
    expect(batch.rejectedFacts[0]?.status).toBe("failed");
  });

  it("blocks secret-like raw values in durable facts even when the fact shape is otherwise valid", () => {
    const leaked = fact({ output: "provider returned api_key=sk_test_1234567890abcdef1234567890abcdef" });

    const redaction = validateFactRedactionState(leaked);

    expect(redaction.ok).toBe(false);
    expect(redaction.errors.map((entry) => entry.code)).toContain("raw_secret_value");
  });

  it("allows redacted markers and contains_sensitive raw artifact refs without embedding raw secret text", () => {
    const redacted = fact({ output: "provider returned api_key=[REDACTED]", redactionState: "redacted" });
    const sensitiveArtifact = fact({
      kind: "raw_artifact",
      producer: "tool_registry",
      provenance: [{ sourceType: "artifact", artifact: artifact("artifact://phase-2d/sensitive-log.txt") }],
      redactionState: "contains_sensitive",
      artifact: artifact("artifact://phase-2d/sensitive-log.txt"),
      byteCount: 100,
      tokenCount: 12,
    });

    expect(validateFactRedactionState(redacted).ok).toBe(true);
    expect(validateFactRedactionState(sensitiveArtifact).ok).toBe(true);
  });

  it("fails closed on raw artifacts with unknown redaction state", () => {
    const unknown = fact({
      kind: "raw_artifact",
      producer: "tool_registry",
      provenance: [{ sourceType: "artifact", artifact: artifact() }],
      redactionState: "unknown",
      artifact: artifact(),
      byteCount: 100,
      tokenCount: 12,
    });

    const result = validateFactRedactionState(unknown);

    expect(result.ok).toBe(false);
    expect(result.errors.map((entry) => entry.code)).toContain("unknown_raw_artifact_redaction");
  });

  it("rejects prototype-pollution keys in validation schema inputs", () => {
    const pollutedArgs = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    const safe = fact({ kind: "tool_call", args: {}, callId: "call-polluted", toolName: "unsafe.tool" });
    const polluted = { ...safe, args: pollutedArgs } as unknown;

    const result = validateFactSchema(polluted);

    expect(result.ok).toBe(false);
    expect(result.errors.map((entry) => entry.code)).toContain("prototype_pollution_key");
  });

  it("rejects absolute artifact URI references that could expose host files", () => {
    const hostFile = fact({
      kind: "raw_artifact",
      producer: "tool_registry",
      provenance: [{ sourceType: "artifact", artifact: artifact("/home/user/.env") }],
      artifact: artifact("/home/user/.env"),
      byteCount: 4,
    });

    const batch = validateFactBatch([hostFile]);

    expect(batch.ok).toBe(false);
    expect(batch.errors.map((entry) => entry.code)).toContain("unsafe_artifact_uri");
  });
});
