import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";

import { getEvidenceTrackDir, getZaiLiveEvidenceDir } from "../../src/evidence";
import {
  beginMatrixCampaignSnapshotSession,
  copyMatrixCampaignArtifactsForStep,
  finalizeMatrixCampaignSnapshot,
} from "../../src/live/liveMatrixCampaignSnapshot";
import {
  assertLiveMatrixArtifactHasNoSecrets,
  isSensitiveMatrixEnvKeyName,
  listMatrixStepReproEnvKeys,
} from "../../src/live/harnessEvidence";

describe("matrix step repro env keys", () => {
  it("allowlists only reproducibility knobs and omits ambient credential env names", () => {
    const keys = listMatrixStepReproEnvKeys({
      RECTOR_LIVE_PROVIDER: "zai",
      ZAI_MODEL: "glm-4.7",
      LIVE_FACT_EVALS: "1",
      ZAI_MATRIX_RUNS_PER_MODEL: "1",
      ZAI_API_KEY: "secret",
      AZURE_OPENAI_API_KEY: "secret",
      GITHUB_TOKEN: "secret",
      LINEAR_API_KEY: "secret",
    });
    expect(keys).toContain("RECTOR_LIVE_PROVIDER");
    expect(keys).toContain("ZAI_MODEL");
    expect(keys).not.toContain("ZAI_API_KEY");
    expect(keys).not.toContain("AZURE_OPENAI_API_KEY");
    expect(keys).not.toContain("GITHUB_TOKEN");
    expect(keys).not.toContain("LINEAR_API_KEY");
    expect(isSensitiveMatrixEnvKeyName("GITHUB_TOKEN")).toBe(true);
  });

  it("rejects matrix artifacts that enumerate sensitive env var names in envKeys", () => {
    expect(() =>
      assertLiveMatrixArtifactHasNoSecrets(
        { steps: [{ envKeys: ["AZURE_OPENAI_API_KEY", "ZAI_MODEL"] }] },
        { artifactLabel: "Z.ai live matrix" },
      ),
    ).toThrow(/sensitive env var name: AZURE_OPENAI_API_KEY/);
  });
});

describe("incremental matrix campaign snapshots", () => {
  it("does not copy stale harness latest.json from another model", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "matrix-snap-iso-"));
    try {
      const zaiDir = getZaiLiveEvidenceDir(repoRoot);
      const phase2Dir = getEvidenceTrackDir("phase2", repoRoot);
      await mkdir(zaiDir, { recursive: true });
      await mkdir(phase2Dir, { recursive: true });
      await writeFile(
        path.join(zaiDir, "latest.json"),
        `${JSON.stringify({ modelId: "winner-model", status: "passed" })}\n`,
        "utf8",
      );
      await writeFile(path.join(phase2Dir, "live-fact-shadow-report.json"), "{\"status\":\"completed\"}\n", "utf8");

      const session = await beginMatrixCampaignSnapshotSession({
        track: "zai",
        repoRoot,
        safeModelId: "loser-model",
        runIndex: 0,
        modelId: "loser-model",
      });
      await copyMatrixCampaignArtifactsForStep(session, "eval:facts:live");
      await copyMatrixCampaignArtifactsForStep(session, "test:live:zai:harness");
      const snapshot = await finalizeMatrixCampaignSnapshot(session);

      expect(snapshot.copiedFiles).toContain("phase2-live-fact-shadow-report.json");
      expect(snapshot.copiedFiles).not.toContain("latest.json");
      expect(snapshot.skippedArtifacts.some((entry) => entry.destName === "latest.json")).toBe(true);

      const snapshotLatest = path.join(
        repoRoot,
        ".rector/evidence/live/zai/matrix/loser-model/0/latest.json",
      );
      await expect(readFile(snapshotLatest, "utf8")).rejects.toThrow();
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("copies harness latest.json when modelId matches the campaign", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "matrix-snap-match-"));
    try {
      const zaiDir = getZaiLiveEvidenceDir(repoRoot);
      await mkdir(zaiDir, { recursive: true });
      await writeFile(
        path.join(zaiDir, "latest.json"),
        `${JSON.stringify({ modelId: "glm-4.7", status: "passed" })}\n`,
        "utf8",
      );

      const session = await beginMatrixCampaignSnapshotSession({
        track: "zai",
        repoRoot,
        safeModelId: "glm-4.7",
        runIndex: 0,
        modelId: "glm-4.7",
      });
      await copyMatrixCampaignArtifactsForStep(session, "test:live:zai:harness");
      const snapshot = await finalizeMatrixCampaignSnapshot(session);

      expect(snapshot.copiedFiles).toContain("latest.json");
      const copied = await readFile(
        path.join(repoRoot, ".rector/evidence/live/zai/matrix/glm-4.7/0/latest.json"),
        "utf8",
      );
      expect(copied).toContain("glm-4.7");
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});