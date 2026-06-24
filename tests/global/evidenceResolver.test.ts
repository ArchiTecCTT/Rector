import { describe, it, expect } from "vitest";
import {
  resolveEvidenceRef,
  computeEvidenceQuality,
  type GlobalEvidenceContext,
} from "../../src/evals/scoreDimensions";
import type { RunEvent } from "../../src/protocol/events";

const baseCtx: GlobalEvidenceContext = {
  artifactRecords: [{ id: "art-1", path: "src/foo.ts" }],
  validatorRuns: [{ id: "val-1", exitCode: 0, output: "ok", durationMs: 10 }],
  runEvents: [{ id: "evt-1", runId: "r1", type: "RUN_CREATED", phase: "TRIAGE", payload: {}, createdAt: new Date().toISOString() } as RunEvent],
  workspaceRoot: "/tmp/ws",
  beforeHashes: {},
  afterHashes: {},
};

describe("evidenceResolver", () => {
  it("resolves real artifact id", () => {
    const r = resolveEvidenceRef("art-1", baseCtx);
    expect(r.resolved).toBe(true);
    expect(r.kind).toBe("artifact");
  });

  it("resolves real validator id", () => {
    const r = resolveEvidenceRef("val-1", baseCtx);
    expect(r.resolved).toBe(true);
    expect(r.kind).toBe("validator");
  });

  it("resolves real runEvent id", () => {
    const r = resolveEvidenceRef("evt-1", baseCtx);
    expect(r.resolved).toBe(true);
    expect(r.kind).toBe("event");
  });

  it("resolves file path ref under workspaceRoot", () => {
    const r = resolveEvidenceRef("/tmp/ws/src/bar.ts", baseCtx);
    expect(r.resolved).toBe(true);
    expect(r.kind).toBe("file");
  });

  it("resolves line/path style ref", () => {
    const r = resolveEvidenceRef("src/foo.ts:42", baseCtx);
    expect(r.resolved).toBe(true);
    expect(r.kind).toBe("line");
  });

  it("fabricated id resolves false", () => {
    const r = resolveEvidenceRef("does.not.exist", baseCtx);
    expect(r.resolved).toBe(false);
    expect(r.reason).toContain("unresolvable");
  });

  it("computeEvidenceQuality=0 when any ref is fabricated", () => {
    const score = computeEvidenceQuality(["art-1", "does.not.exist"], baseCtx);
    expect(score.score).toBe(0);
    expect(score.note).toContain("unresolvable");
  });

  it("computeEvidenceQuality=1 when all refs resolve", () => {
    const score = computeEvidenceQuality(["art-1", "val-1"], baseCtx);
    expect(score.score).toBe(1);
  });

  // Anti-cheat negative cases (must NOT resolve fabricated slashed/colon refs)
  const ctxUnrelated: GlobalEvidenceContext = {
    artifactRecords: [{ id: "real-1", path: "real.ts" }],
    validatorRuns: [],
    runEvents: [],
    workspaceRoot: "/tmp/ws",
    beforeHashes: { "real.ts": "abc" },
    afterHashes: {},
  };

  it("evil/fabricated.ts resolves false (anti-cheat)", () => {
    const r = resolveEvidenceRef("evil/fabricated.ts", ctxUnrelated);
    expect(r.resolved).toBe(false);
  });

  it("made:up:99 resolves false (anti-cheat)", () => {
    const r = resolveEvidenceRef("made:up:99", ctxUnrelated);
    expect(r.resolved).toBe(false);
  });

  // Positive file/line via artifact path or hash key
  const ctxWithA: GlobalEvidenceContext = {
    artifactRecords: [{ id: "a1", path: "a.ts" }],
    validatorRuns: [],
    runEvents: [],
    workspaceRoot: "/tmp/ws",
    beforeHashes: { "a.ts": "dead" },
    afterHashes: {},
  };

  it("a.ts resolves true kind file when artifact path present", () => {
    const r = resolveEvidenceRef("a.ts", ctxWithA);
    expect(r.resolved).toBe(true);
    expect(r.kind).toBe("file");
  });

  it("a.ts:12 resolves true kind line when artifact path present", () => {
    const r = resolveEvidenceRef("a.ts:12", ctxWithA);
    expect(r.resolved).toBe(true);
    expect(r.kind).toBe("line");
  });

  it("computeEvidenceQuality=0 on slashed fabricated ref", () => {
    const score = computeEvidenceQuality(["evil/fake.ts"], ctxUnrelated);
    expect(score.score).toBe(0);
  });
});
