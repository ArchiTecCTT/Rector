import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  EVIDENCE_TRACKS,
  getEvidenceRoot,
  getEvidenceTrackDir,
  getLegacyEvidenceRoot,
  getRectorLocalDir,
  getRegoloLiveEvidenceDir,
  getRegoloLiveRunEvidenceDir,
  getZaiLiveEvidenceDir,
  getZaiLiveRunEvidenceDir,
} from "../../src/evidence";

const originalEnv = { ...process.env };
const repoRoot = path.resolve("tmp", "rector-evidence-repo");

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("evidence path helpers", () => {
  it("uses Rector-owned evidence defaults and legacy .omo compatibility defaults", () => {
    delete process.env.RECTOR_EVIDENCE_DIR;
    delete process.env.RECTOR_LEGACY_EVIDENCE_DIR;

    expect(getRectorLocalDir(repoRoot)).toBe(path.join(repoRoot, ".rector"));
    expect(getEvidenceRoot(repoRoot)).toBe(path.join(repoRoot, ".rector", "evidence"));
    expect(getLegacyEvidenceRoot(repoRoot)).toBe(path.join(repoRoot, ".omo", "evidence"));
  });

  it("resolves relative env overrides under the repo root", () => {
    process.env.RECTOR_EVIDENCE_DIR = "proof/evidence";
    process.env.RECTOR_LEGACY_EVIDENCE_DIR = "legacy/evidence";

    expect(getEvidenceRoot(repoRoot)).toBe(path.join(repoRoot, "proof", "evidence"));
    expect(getLegacyEvidenceRoot(repoRoot)).toBe(path.join(repoRoot, "legacy", "evidence"));
  });

  it("allows absolute env overrides only when the operator explicitly sets the env var", () => {
    const absoluteOverride = path.resolve(path.sep, "tmp", "rector-evidence-operator-override");
    process.env.RECTOR_EVIDENCE_DIR = absoluteOverride;

    expect(getEvidenceRoot(repoRoot)).toBe(absoluteOverride);
  });

  it("rejects traversal in relative env overrides", () => {
    process.env.RECTOR_EVIDENCE_DIR = "../outside";

    expect(() => getEvidenceRoot(repoRoot)).toThrow(/traversal|repo root/i);
  });

  it("supports every canonical evidence track", () => {
    expect(EVIDENCE_TRACKS).toEqual([
      "phase0",
      "phase0.5",
      "phase1",
      "phase2",
      "live/zai",
      "live/regolo",
      "global",
      "capabilities",
    ]);

    expect(getEvidenceTrackDir("phase0", repoRoot)).toBe(path.join(repoRoot, ".rector", "evidence", "phase0"));
    expect(getEvidenceTrackDir("phase0.5", repoRoot)).toBe(path.join(repoRoot, ".rector", "evidence", "phase0.5"));
    expect(getEvidenceTrackDir("phase1", repoRoot)).toBe(path.join(repoRoot, ".rector", "evidence", "phase1"));
    expect(getEvidenceTrackDir("phase2", repoRoot)).toBe(path.join(repoRoot, ".rector", "evidence", "phase2"));
    expect(getEvidenceTrackDir("live/zai", repoRoot)).toBe(path.join(repoRoot, ".rector", "evidence", "live", "zai"));
    expect(getEvidenceTrackDir("live/regolo", repoRoot)).toBe(path.join(repoRoot, ".rector", "evidence", "live", "regolo"));
    expect(getEvidenceTrackDir("global", repoRoot)).toBe(path.join(repoRoot, ".rector", "evidence", "global"));
    expect(getEvidenceTrackDir("capabilities", repoRoot)).toBe(path.join(repoRoot, ".rector", "evidence", "capabilities"));
  });

  it("builds Z.ai live run evidence paths with safe run ids only", () => {
    const runId = "zai-2026-06-30T00-00-00-000Z";

    expect(getZaiLiveEvidenceDir(repoRoot)).toBe(path.join(repoRoot, ".rector", "evidence", "live", "zai"));
    expect(getZaiLiveRunEvidenceDir(runId, repoRoot)).toBe(
      path.join(repoRoot, ".rector", "evidence", "live", "zai", "runs", runId),
    );
    expect(() => getZaiLiveRunEvidenceDir("../escape", repoRoot)).toThrow(/run id|traversal/i);
    expect(() => getZaiLiveRunEvidenceDir("nested/run", repoRoot)).toThrow(/run id|traversal/i);
  });

  it("builds Regolo live run evidence paths with safe run ids only", () => {
    const runId = "regolo-2026-07-01T00-00-00-000Z";

    expect(getRegoloLiveEvidenceDir(repoRoot)).toBe(path.join(repoRoot, ".rector", "evidence", "live", "regolo"));
    expect(getRegoloLiveRunEvidenceDir(runId, repoRoot)).toBe(
      path.join(repoRoot, ".rector", "evidence", "live", "regolo", "runs", runId),
    );
  });
});
