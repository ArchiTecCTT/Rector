import { describe, expect, it } from "vitest";

import { RectorFactSchema, runEventToFacts } from "../../src/facts";
import type { RunEvent } from "../../src/protocol/events";

function event(overrides: Partial<RunEvent> = {}): RunEvent {
  return {
    id: "evt-1",
    runId: "run-events",
    type: "PHASE_CHANGED",
    phase: "EXECUTING",
    payload: { step: 1 },
    createdAt: "2026-06-28T00:00:00.000Z",
    ...overrides,
  };
}

function expectValidFacts(facts: readonly unknown[]) {
  for (const fact of facts) expect(RectorFactSchema.safeParse(fact).success).toBe(true);
}

describe("run event fact adapter", () => {
  it("preserves run and event ids via provenance and never invents phases", () => {
    const facts = runEventToFacts(event({ id: "evt-phase", phase: "PLANNING", type: "PHASE_CHANGED" }));

    expectValidFacts(facts);
    expect(facts.some((fact) => fact.runId === "run-events" && fact.provenance.some((p) => p.sourceType === "run_event" && p.eventId === "evt-phase"))).toBe(true);
    expect(facts.some((fact) => fact.kind === "capability_call" && fact.capabilityId === "run_phase:PLANNING" && fact.status === "running")).toBe(true);
  });

  it("turns artifact-created events into raw artifact references, not dumped artifacts", () => {
    const facts = runEventToFacts(event({
      id: "evt-artifact",
      type: "ARTIFACT_CREATED",
      phase: "EXECUTING",
      payload: { artifactUri: "artifact://run-events/stdout.log", sizeBytes: 42, contentType: "text/plain", secret: "token=abc123" },
    }));

    expectValidFacts(facts);
    const artifact = facts.find((fact) => fact.kind === "raw_artifact");
    expect(artifact?.kind).toBe("raw_artifact");
    if (artifact?.kind === "raw_artifact") {
      expect(artifact.artifact.uri).toBe("artifact://run-events/stdout.log");
      expect(artifact.byteCount).toBe(42);
    }
    expect(JSON.stringify(facts)).not.toContain("abc123");
  });

  it("records failed validation with insufficient evidence when no artifact ref exists", () => {
    const facts = runEventToFacts(event({ id: "evt-validation", type: "VALIDATION_FAILED", phase: "VALIDATING", payload: { reason: "test failed" } }));

    expectValidFacts(facts);
    const validation = facts.find((fact) => fact.kind === "fact_grounding_validation");
    expect(validation?.kind).toBe("fact_grounding_validation");
    if (validation?.kind === "fact_grounding_validation") {
      expect(validation.status).toBe("failed");
      expect(validation.evidence[0]).toMatchObject({ refType: "insufficient_evidence" });
      expect(validation.trust.level).not.toBe("validation_linked");
    }
  });

  it("references oversized payloads as raw artifacts", () => {
    const facts = runEventToFacts(event({ id: "evt-large", payload: { text: "x".repeat(5_000) } }));

    expectValidFacts(facts);
    expect(facts.some((fact) => fact.kind === "raw_artifact" && fact.artifact.uri === "run-event://run-events/evt-large/payload.json")).toBe(true);
    expect(JSON.stringify(facts)).not.toContain("x".repeat(5_000));
  });

  it("still emits artifact metadata facts when payload is large but includes artifactUri", () => {
    const facts = runEventToFacts(event({
      id: "evt-large-artifact",
      type: "ARTIFACT_CREATED",
      phase: "EXECUTING",
      payload: { artifactUri: "artifact://run-events/large.log", sizeBytes: 9_000, blob: "x".repeat(5_000) },
    }));

    expectValidFacts(facts);
    expect(facts.some((fact) => fact.kind === "raw_artifact" && fact.artifact.uri === "artifact://run-events/large.log")).toBe(true);
    expect(facts.some((fact) => fact.kind === "raw_artifact" && fact.artifact.uri === "run-event://run-events/evt-large-artifact/payload.json")).toBe(true);
    expect(JSON.stringify(facts)).not.toContain("x".repeat(5_000));
  });
});
