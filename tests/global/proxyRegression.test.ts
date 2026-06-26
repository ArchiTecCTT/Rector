import { describe, expect, it } from "vitest";
import {
  computeAccuracy,
  computeEvidenceQuality,
  computeMemoryCorrectness,
  computeDelegationQuality,
  computeCostEfficiency,
  type GlobalEvidenceContext,
  MemoryAssertionSchema,
  computeReliability,
} from "../../src/evals/scoreDimensions";
import { SpecialistTaskPacketSchema } from "../../src/systems/contracts";

describe("proxy-regression behavioral semantics (anti-cheat)", () => {
  const ctxBase: GlobalEvidenceContext = {
    artifactRecords: [{ id: "a1", path: "src/foo.ts" }],
    validatorRuns: [{ id: "v1", exitCode: 0, output: "ok", durationMs: 10 }],
    runEvents: [],
    workspaceRoot: "/tmp/ws",
    beforeHashes: { "src/foo.ts": "deadbeef" },
    afterHashes: { "src/foo.ts": "deadbeef" },
  };

  it("accuracy = 0 when before/after hashes do NOT match expected (old path-existence proxy would have scored >0)", () => {
    const mismatchCtx = { ...ctxBase, afterHashes: { "src/foo.ts": "cafebabe" } };
    const res = computeAccuracy(["src/foo.ts"], mismatchCtx);
    expect(res.score).toBe(0);
    expect(res.note).toContain("hash mismatch");
  });

  it("evidence_quality = 0 for a declared-but-unresolvable evidence ref", () => {
    const res = computeEvidenceQuality(["nonexistent-ref-xyz"], ctxBase);
    expect(res.score).toBe(0);
    expect(res.note).toContain("unresolvable");
  });

  it("memory_correctness = 0 for a file-existence-only case (no corroborating memory assertion/run events)", () => {
    const assertion = MemoryAssertionSchema.parse({
      verifiedEntries: ["mem-ghost"],
      unverifiedEntries: [],
      forbiddenPromotions: [],
      expectedCandidateRefs: [],
      forbiddenCrossDomainRefs: [],
    });
    const res = computeMemoryCorrectness(assertion, ctxBase);
    expect(res.score).toBe(0);
  });

  it("delegation_quality = 0 for a static-membership-only case without a matching packet/trace", () => {
    const fakePacket = SpecialistTaskPacketSchema.parse({
      taskId: "task",
      systemId: "coding",
      userGoal: "goal",
      successCriteria: [],
      constraints: [],
      allowedScopes: [],
      forbiddenScopes: [],
      memoryPacketRefs: [],
      capabilityHints: [],
      validationRequirements: [],
      budget: {},
      riskTolerance: "low",
    });
    const res = computeDelegationQuality({ packet: fakePacket, runEvents: [], expectedSpecialist: "coding", allowed: ["coding"], forbidden: [] });
    expect(res.score).toBe(0);
  });

  it("cost_efficiency is deterministic when a test clock is injected (total runtime <= budget)", () => {
    const runs = [{ exitCode: 0, output: "", durationMs: 42 }];
    const res = computeCostEfficiency(runs as any, 100);
    expect(res.score).toBe(1);
    expect(res.totalRuntimeMs).toBe(42);
  });

  it("at least one passing scenario scores all gated dims = 1", () => {
    const passCtx: GlobalEvidenceContext = {
      ...ctxBase,
      artifactRecords: [{ id: "e1", path: "src/ok.ts" }],
      beforeHashes: { "src/ok.ts": "aa" },
      afterHashes: { "src/ok.ts": "aa" },
    };
    const acc = computeAccuracy(["src/ok.ts"], passCtx);
    const ev = computeEvidenceQuality(["e1"], passCtx);
    expect(acc.score).toBe(1);
    expect(ev.score).toBe(1);
  });

  it("a failing scenario scores reliability 0 and would write a regression artifact", () => {
    const failRuns = [{ exitCode: 1, expectedExitCode: 0 }];
    const rel = computeReliability(failRuns as any);
    expect(rel.score).toBe(0);
  });
});
