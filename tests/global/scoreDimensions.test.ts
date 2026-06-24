import { describe, it, expect } from "vitest";
import {
  MemoryAssertionSchema,
  computeReliability,
  computeAccuracy,
  computeSafety,
  computeCostEfficiency,
  computeMemoryCorrectness,
  computeDelegationQuality,
  computeEvidenceQuality,
  computeSimplicity,
  type GlobalEvidenceContext,
} from "../../src/evals/scoreDimensions";
import { buildTaskPacket } from "../../src/evals/runTrace";
import { SpecialistTaskPacketSchema } from "../../src/systems/contracts";

describe("scoreDimensions", () => {
  it("MemoryAssertionSchema rejects malformed fixtures", () => {
    expect(() => MemoryAssertionSchema.parse({ verifiedEntries: [1] })).toThrow();
  });

  it("GlobalEvidenceContext rejects fabricated refs (accuracy=0 on mismatch)", () => {
    const ctx: GlobalEvidenceContext = {
      artifactRecords: [{ id: "a1", path: "a.ts" }],
      validatorRuns: [],
      runEvents: [],
      workspaceRoot: "/tmp",
      beforeHashes: { "a.ts": "deadbeef" },
      afterHashes: { "a.ts": "cafebabe" },
    };
    const acc = computeAccuracy(["a.ts"], ctx);
    expect(acc.score).toBe(0);
  });

  it("reliability=1 only when all validators exit 0", () => {
    expect(computeReliability([{ exitCode: 0 }, { exitCode: 0 }]).score).toBe(1);
    expect(computeReliability([{ exitCode: 1 }]).score).toBe(0);
  });

  it("safety=1 when no secret leakage (identity redact)", () => {
    expect(computeSafety([{ output: "clean" }]).score).toBe(1);
  });

  it("cost_efficiency=1 when within budget", () => {
    const res = computeCostEfficiency([{ durationMs: 100 }], 1000);
    expect(res.score).toBe(1);
  });

  it("memory_correctness scores real MemoryAssertion (never file existence)", () => {
    const assertion = MemoryAssertionSchema.parse({
      verifiedEntries: ["mem1"],
      unverifiedEntries: [],
      forbiddenPromotions: [],
      expectedCandidateRefs: ["ref1"],
      forbiddenCrossDomainRefs: [],
    });
    const ctx: GlobalEvidenceContext = { artifactRecords: [], validatorRuns: [], runEvents: [], workspaceRoot: ".", beforeHashes: {}, afterHashes: {} };
    // No matching runEvents → strict rule yields 0
    expect(computeMemoryCorrectness(assertion, ctx).score).toBe(0);
  });

  it("delegation_quality=1 only when allowed and not forbidden", () => {
    const pkt = buildTaskPacket({ systemId: "coding-basic-fix" });
    expect(computeDelegationQuality(pkt, ["coding-basic-fix"], []).score).toBe(1);
    expect(computeDelegationQuality(pkt, ["other"], []).score).toBe(0);
    expect(computeDelegationQuality(pkt, ["coding-basic-fix"], ["coding-basic-fix"]).score).toBe(0);
  });

  it("evidence_quality=1 only when ids are non-empty", () => {
    expect(computeEvidenceQuality(["e1", "e2"]).score).toBe(1);
    expect(computeEvidenceQuality([""]).score).toBe(0);
  });

  it("simplicity=1 only when within budget and no violations", () => {
    const ok = computeSimplicity({ validatorCount: 1, validatorBudget: 2, forbiddenSpecialistUsed: false, operationKind: "validator_only", patchUsedWhenValidatorOnlySuffices: false, extraValidatorsBeyondBudget: false });
    expect(ok.score).toBe(1);
  });
  it("simplicity penalizes validator count exceed", () => {
    const bad = computeSimplicity({ validatorCount: 3, validatorBudget: 2, forbiddenSpecialistUsed: false, operationKind: "validator_only", patchUsedWhenValidatorOnlySuffices: false, extraValidatorsBeyondBudget: false });
    expect(bad.score).toBe(0.5);
  });
  it("simplicity=0 on forbidden specialist", () => {
    const bad = computeSimplicity({ validatorCount: 1, validatorBudget: 2, forbiddenSpecialistUsed: true, operationKind: "validator_only", patchUsedWhenValidatorOnlySuffices: false, extraValidatorsBeyondBudget: false });
    expect(bad.score).toBe(0);
  });
  it("simplicity=0 on avoidable patch", () => {
    const bad = computeSimplicity({ validatorCount: 1, validatorBudget: 2, forbiddenSpecialistUsed: false, operationKind: "validator_only", patchUsedWhenValidatorOnlySuffices: true, extraValidatorsBeyondBudget: false });
    expect(bad.score).toBe(0);
  });
  it("simplicity penalizes extra validators", () => {
    const bad = computeSimplicity({ validatorCount: 1, validatorBudget: 2, forbiddenSpecialistUsed: false, operationKind: "validator_only", patchUsedWhenValidatorOnlySuffices: false, extraValidatorsBeyondBudget: true });
    expect(bad.score).toBe(0.5);
  });

  it("SpecialistTaskPacket validates under schema", () => {
    const pkt = buildTaskPacket();
    expect(() => SpecialistTaskPacketSchema.parse(pkt)).not.toThrow();
  });
});
