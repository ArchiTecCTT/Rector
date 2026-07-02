import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";

import { getEvidenceTrackDir, getZaiLiveEvidenceDir } from "../../src/evidence";

import type { GateZaiLiveEvidenceResult } from "../../src/live/gateZaiLiveEvidence";
import {
  assertMatrixArtifactHasNoSecrets,
  buildIsolatedCampaignEnv,
  buildMatrixDiagnostics,
  buildStepCommandLog,
  dedupeZaiModelsPreserveOrder,
  deriveZaiModelCampaignRating,
  formatZaiMatrixSummaryMarkdown,
  getZaiMatrixCampaignSnapshotRelativeDir,
  parseZaiModelsList,
  resolveZaiMatrixConfig,
  resolveZaiMatrixModels,
  runZaiModelMatrix,
  snapshotZaiMatrixCampaignEvidence,
  toSafeModelEvidenceId,
  writeZaiMatrixSummary,
  ZAI_MATRIX_LIVE_CAMPAIGN_STEPS,
  ZAI_MATRIX_SUMMARY_SCHEMA_VERSION,
} from "../../src/live/zaiModelMatrix";
import { ZAI_MODEL_PROBE_REPORT_SCHEMA } from "../../src/live/zaiModelProbe";
import {
  MATRIX_ARTIFACT_NOT_CAPTURED,
  type MatrixCampaignSnapshotResult,
} from "../../src/live/liveMatrixCampaignSnapshot";

function mockCampaignSnapshot(input: {
  readonly safeModelId: string;
  readonly runIndex: number;
  readonly modelId: string;
  readonly copiedFiles?: readonly string[];
}): MatrixCampaignSnapshotResult {
  const dir = getZaiMatrixCampaignSnapshotRelativeDir(input.safeModelId, input.runIndex);
  const prefix = `${dir}/`;
  const copied = [...(input.copiedFiles ?? [])];
  const pointer = (name: string) => (copied.includes(name) ? `${prefix}${name}` : MATRIX_ARTIFACT_NOT_CAPTURED);
  return {
    evidenceSnapshotDir: dir,
    reportPointers: {
      latestJson: pointer("latest.json"),
      latestMd: pointer("latest.md"),
      providerSmokeJson: pointer("provider-smoke.json"),
      phase2ShadowJson: pointer("phase2-live-fact-shadow-report.json"),
    },
    copiedFiles: copied,
    skippedArtifacts: [],
    snapshotHealth: copied.length === 0 ? "empty" : copied.length === 4 ? "complete" : "partial",
    snapshotCopiedAt: "2026-06-30T12:00:00.000Z",
    snapshotEffectiveModelId: input.modelId,
  };
}

describe("zaiModelMatrix parsing", () => {
  it("parses comma, newline, and space separated model lists", () => {
    expect(parseZaiModelsList("glm-4.7,glm-4.5")).toEqual(["glm-4.7", "glm-4.5"]);
    expect(parseZaiModelsList("glm-a\nglm-b")).toEqual(["glm-a", "glm-b"]);
    expect(parseZaiModelsList("glm-a glm-b")).toEqual(["glm-a", "glm-b"]);
    expect(parseZaiModelsList("  glm-a ,  glm-b  ")).toEqual(["glm-a", "glm-b"]);
  });

  it("dedupes models preserving first occurrence", () => {
    expect(dedupeZaiModelsPreserveOrder(["glm-4", "glm-4", "glm-5"])).toEqual(["glm-4", "glm-5"]);
  });

  it("converts model ids to safe evidence segments", () => {
    expect(toSafeModelEvidenceId("glm-4.7")).toBe("glm-4.7");
    expect(toSafeModelEvidenceId("models/glm-4")).toBe("models_glm-4");
    expect(() => toSafeModelEvidenceId("")).toThrow(/empty/);
    expect(() => toSafeModelEvidenceId("..")).toThrow(/safe evidence segment/);
  });

  it("resolves models from ZAI_MODELS with optional cap", () => {
    const env = {
      ZAI_MODELS: "m1,m2,m3",
      ZAI_MATRIX_MAX_MODELS: "2",
    };
    expect(resolveZaiMatrixModels(env)).toEqual({ models: ["m1", "m2"], source: "ZAI_MODELS" });
  });

  it("falls back to single ZAI_MODEL", () => {
    expect(resolveZaiMatrixModels({ ZAI_MODEL: "glm-4.7" })).toEqual({
      models: ["glm-4.7"],
      source: "ZAI_MODEL",
    });
    expect(resolveZaiMatrixModels({})).toEqual({ models: [], source: "empty" });
  });

  it("reads matrix config env knobs", () => {
    const config = resolveZaiMatrixConfig({
      ZAI_MATRIX_RUNS_PER_MODEL: "3",
      ZAI_MATRIX_SKIP_OFFLINE: "1",
      ZAI_MATRIX_CONTINUE_ON_FAILURE: "0",
      ZAI_MATRIX_PREFILTER_PROBE: "1",
      ZAI_MATRIX_PROBE_JSON: "true",
    });
    expect(config.runsPerModel).toBe(3);
    expect(config.skipOffline).toBe(true);
    expect(config.continueOnFailure).toBe(false);
    expect(config.prefilterWithProbe).toBe(true);
    expect(config.probeJsonCapability).toBe(true);
  });
});

describe("zaiModelMatrix env isolation and logs", () => {
  it("isolates ZAI_MODEL per campaign env", () => {
    const env = buildIsolatedCampaignEnv(
      { ZAI_API_KEY: "secret-key-value", ZAI_BASE_URL: "https://api.z.ai/api/paas/v4", ZAI_MODEL: "old" },
      "glm-new",
    );
    expect(env.ZAI_MODEL).toBe("glm-new");
    expect(env.RECTOR_LIVE_PROVIDER).toBe("zai");
    expect(env.ZAI_API_KEY).toBe("secret-key-value");
  });

  it("omits sensitive env keys from command logs and redacts stderr tails", () => {
    const step = ZAI_MATRIX_LIVE_CAMPAIGN_STEPS[0];
    const entry = buildStepCommandLog(
      step,
      {
        exitCode: 1,
        stdout: "",
        stderr: "Bearer sk-live-abcdefghijklmnop failed",
        durationMs: 12,
      },
      {
        ZAI_MODEL: "glm-4",
        ZAI_API_KEY: "sk-live-abcdefghijklmnop",
        AZURE_OPENAI_API_KEY: "azure-secret",
        GITHUB_TOKEN: "gh-secret",
        LINEAR_API_KEY: "linear-secret",
        RECTOR_LIVE_PROVIDER: "zai",
        LIVE_FACT_EVALS: "1",
      },
    );
    expect(entry.envKeys).not.toContain("ZAI_API_KEY");
    expect(entry.envKeys).not.toContain("AZURE_OPENAI_API_KEY");
    expect(entry.envKeys).not.toContain("GITHUB_TOKEN");
    expect(entry.envKeys).not.toContain("LINEAR_API_KEY");
    expect(entry.envKeys).toContain("LIVE_FACT_EVALS");
    expect(entry.command).not.toContain("sk-live");
    expect(entry.stderrTail).not.toContain("sk-live");
  });

  it("rejects matrix artifacts that embed secret-like values", () => {
    expect(() =>
      assertMatrixArtifactHasNoSecrets({ note: "Bearer sk-12345678901234567890123456789012" }),
    ).toThrow(/secret-like/);
    expect(() =>
      assertMatrixArtifactHasNoSecrets({ ZAI_API_KEY: "aaaaaaaaaaaaaaaa" }),
    ).toThrow(/ZAI_API_KEY/);
  });
});

describe("zaiModelMatrix ratings", () => {
  it("derives grades from gate and harness evidence", () => {
    expect(deriveZaiModelCampaignRating({ gateOk: false }).grade).toBe("F");
    const topCampaign = deriveZaiModelCampaignRating({
      gateOk: true,
      gateSummary: {
        providerId: "zai",
        adapterId: "openai-compatible",
        modelId: "glm",
        host: "https://api.z.ai",
        harnessStatus: "passed",
        scenariosPassed: 3,
        scenariosTotal: 3,
        campaignTokens: 100,
        campaignTokenLimit: 100_000,
        campaignModelCalls: 3,
        estimatedCostUsd: 0,
        latestMarkdown: "x",
        manifestUpdated: false,
      },
      scorecardPassed: true,
    });
    expect(topCampaign.rating).toBe("gate_and_harness_pass");
    expect(topCampaign.grade).toBe("A");
  });
});

describe("buildMatrixDiagnostics edge cases", () => {
  it("sums gate campaignTokens only and stays zero-safe when gate totals are absent", () => {
    const diagnostics = buildMatrixDiagnostics([
      {
        modelId: "m1",
        safeModelId: "m1",
        runIndex: 0,
        status: "fail",
        durationMs: 10,
        steps: [],
        grade: "F",
        rating: "gate_fail",
        evidenceSnapshotDir: ".rector/evidence/live/zai/matrix/m1/0",
        reportPointers: {
          latestJson: MATRIX_ARTIFACT_NOT_CAPTURED,
          latestMd: MATRIX_ARTIFACT_NOT_CAPTURED,
          providerSmokeJson: MATRIX_ARTIFACT_NOT_CAPTURED,
          phase2ShadowJson: MATRIX_ARTIFACT_NOT_CAPTURED,
        },
        snapshotCopiedFiles: [],
        snapshotSkippedArtifacts: [],
        snapshotHealth: "empty",
        snapshotEffectiveModelId: "m1",
      },
      {
        modelId: "m2",
        safeModelId: "m2",
        runIndex: 0,
        status: "pass",
        durationMs: 20,
        steps: [{ stepId: "gate", command: "npm run evidence:zai-live:gate", envKeys: [], exitCode: 0, durationMs: 5 }],
        grade: "A",
        rating: "gate_and_harness_pass",
        evidenceSnapshotDir: ".rector/evidence/live/zai/matrix/m2/0",
        reportPointers: {
          latestJson: MATRIX_ARTIFACT_NOT_CAPTURED,
          latestMd: MATRIX_ARTIFACT_NOT_CAPTURED,
          providerSmokeJson: MATRIX_ARTIFACT_NOT_CAPTURED,
          phase2ShadowJson: MATRIX_ARTIFACT_NOT_CAPTURED,
        },
        snapshotCopiedFiles: [],
        snapshotSkippedArtifacts: [],
        snapshotHealth: "empty",
        snapshotEffectiveModelId: "m2",
        gate: {
          providerId: "zai",
          adapterId: "openai-compatible",
          modelId: "m2",
          host: "https://api.z.ai",
          harnessStatus: "passed",
          scenariosPassed: 1,
          scenariosTotal: 1,
          campaignTokens: 0,
          campaignTokenLimit: 100_000,
          campaignModelCalls: 1,
          estimatedCostUsd: 0,
          latestMarkdown: "x",
          manifestUpdated: false,
        },
      },
    ]);
    expect(diagnostics.tokens.totalTokens).toBe(0);
    expect(diagnostics.tokens.inputTokens).toBe(0);
    expect(diagnostics.tokens.outputTokens).toBe(0);
    expect(diagnostics.tokens.modelCalls).toBe(0);
  });
});

describe("runZaiModelMatrix orchestration", () => {
  it("runs isolated campaigns per model with injected command runner", async () => {
    const invocations: Array<{ model?: string; script: string }> = [];
    const gateOk: GateZaiLiveEvidenceResult = {
      ok: true,
      violations: [],
      summary: {
        providerId: "zai-env",
        adapterId: "openai-compatible",
        modelId: "glm-4.7",
        host: "https://api.z.ai/api/paas/v4",
        harnessStatus: "passed",
        scenariosPassed: 2,
        scenariosTotal: 2,
        campaignTokens: 500,
        campaignTokenLimit: 100_000,
        campaignModelCalls: 2,
        estimatedCostUsd: 0.01,
        latestMarkdown: ".rector/evidence/live/zai/latest.md",
        manifestUpdated: false,
      },
    };

    const summary = await runZaiModelMatrix({
      repoRoot: process.cwd(),
      models: ["glm-4.7", "glm-4.5"],
      modelSource: "ZAI_MODELS",
      config: {
        runsPerModel: 1,
        skipOffline: true,
        continueOnFailure: true,
        prefilterWithProbe: false,
        probeJsonCapability: false,
      },
      snapshotCampaignEvidence: async ({ safeModelId, runIndex, modelId }) =>
        mockCampaignSnapshot({ safeModelId, runIndex, modelId }),
      runCommand: async (input) => {
        const script = input.args[1] ?? "";
        invocations.push({ model: input.env.ZAI_MODEL, script });
        return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
      },
      gateEvaluator: async () => gateOk,
      now: () => new Date("2026-06-30T12:00:00.000Z"),
    });

    expect(summary.schemaVersion).toBe(ZAI_MATRIX_SUMMARY_SCHEMA_VERSION);
    expect(summary.diagnostics.latencyMs.matrixSteps?.count).toBeGreaterThan(0);
    expect(summary.campaigns).toHaveLength(2);
    expect(summary.campaigns.every((c) => c.status === "pass")).toBe(true);
    expect(invocations.filter((i) => i.model === "glm-4.7").length).toBeGreaterThan(0);
    expect(invocations.filter((i) => i.model === "glm-4.5").length).toBeGreaterThan(0);
    expect(new Set(invocations.map((i) => i.model))).toEqual(new Set(["glm-4.7", "glm-4.5"]));
  });

  it("continues across models when a campaign fails and continueOnFailure is enabled", async () => {
    const summary = await runZaiModelMatrix({
      repoRoot: process.cwd(),
      models: ["bad-model", "good-model"],
      modelSource: "ZAI_MODELS",
      config: {
        runsPerModel: 1,
        skipOffline: true,
        continueOnFailure: true,
        prefilterWithProbe: false,
        probeJsonCapability: false,
      },
      snapshotCampaignEvidence: async ({ safeModelId, runIndex, modelId }) =>
        mockCampaignSnapshot({ safeModelId, runIndex, modelId }),
      runCommand: async (input) => ({
        exitCode: input.env.ZAI_MODEL === "bad-model" ? 1 : 0,
        stdout: "",
        stderr: "",
        durationMs: 1,
      }),
      gateEvaluator: async () => ({
        ok: true,
        violations: [],
        summary: {
          providerId: "zai",
          adapterId: "openai-compatible",
          modelId: "good-model",
          host: "https://api.z.ai",
          harnessStatus: "passed",
          scenariosPassed: 1,
          scenariosTotal: 1,
          campaignTokens: 10,
          campaignTokenLimit: 100_000,
          campaignModelCalls: 1,
          estimatedCostUsd: 0,
          latestMarkdown: "x",
          manifestUpdated: false,
        },
      }),
    });

    expect(summary.overallStatus).toBe("partial");
    expect(summary.passedCount).toBe(1);
    expect(summary.failedCount).toBe(1);
  });

  it("writes durable matrix summary artifacts", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "zai-matrix-"));
    try {
      const summary = await runZaiModelMatrix({
        repoRoot,
        models: ["glm-4.7"],
        modelSource: "ZAI_MODEL",
        config: {
          runsPerModel: 1,
          skipOffline: true,
          continueOnFailure: true,
          prefilterWithProbe: false,
          probeJsonCapability: false,
        },
        snapshotCampaignEvidence: async ({ safeModelId, runIndex, modelId }) =>
          mockCampaignSnapshot({ safeModelId, runIndex, modelId }),
        runCommand: async () => ({ exitCode: 1, stdout: "", stderr: "step failed", durationMs: 2 }),
        gateEvaluator: async () => ({ ok: false, violations: ["fixture"], summary: {
          providerId: null,
          adapterId: null,
          modelId: null,
          host: null,
          harnessStatus: null,
          scenariosPassed: 0,
          scenariosTotal: 0,
          campaignTokens: 0,
          campaignTokenLimit: 100_000,
          campaignModelCalls: 0,
          estimatedCostUsd: 0,
          latestMarkdown: "x",
          manifestUpdated: false,
        } }),
        now: () => new Date("2026-06-30T12:00:00.000Z"),
      });

      const written = await writeZaiMatrixSummary(summary, { repoRoot });
      const json = JSON.parse(await readFile(written.jsonPath, "utf8"));
      expect(json.campaigns[0].status).toBe("fail");
      expect(formatZaiMatrixSummaryMarkdown(summary)).toContain("Z.ai live model matrix summary");
      expect(JSON.stringify(json)).not.toContain("ZAI_API_KEY");
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("snapshots campaign artifacts into per-model matrix directories", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "zai-matrix-snap-"));
    try {
      const zaiDir = getZaiLiveEvidenceDir(repoRoot);
      const phase2Dir = getEvidenceTrackDir("phase2", repoRoot);
      await mkdir(zaiDir, { recursive: true });
      await mkdir(phase2Dir, { recursive: true });
      await writeFile(
        path.join(zaiDir, "latest.json"),
        `${JSON.stringify({ modelId: "glm-4.7", campaign: true })}\n`,
        "utf8",
      );
      await writeFile(path.join(zaiDir, "provider-smoke.json"), "{\"passed\":true}\n", "utf8");
      await writeFile(path.join(phase2Dir, "live-fact-shadow-report.json"), "{\"status\":\"completed\"}\n", "utf8");

      const snapshot = await snapshotZaiMatrixCampaignEvidence({
        repoRoot,
        safeModelId: "glm-4.7",
        runIndex: 0,
        modelId: "glm-4.7",
      });

      expect(snapshot.evidenceSnapshotDir).toBe(".rector/evidence/live/zai/matrix/glm-4.7/0");
      expect(snapshot.reportPointers.latestJson).toContain("matrix/glm-4.7/0/latest.json");
      const copied = await readFile(path.join(repoRoot, ".rector/evidence/live/zai/matrix/glm-4.7/0/latest.json"), "utf8");
      expect(copied).toContain("campaign");
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("skips non-callable models when probe pre-filter is enabled", async () => {
    const invocations: string[] = [];
    const summary = await runZaiModelMatrix({
      repoRoot: process.cwd(),
      models: ["bad-model", "good-model"],
      modelSource: "ZAI_MODELS",
      config: {
        runsPerModel: 1,
        skipOffline: true,
        continueOnFailure: true,
        prefilterWithProbe: true,
        probeJsonCapability: false,
      },
      probeRunner: async () => ({
        schemaVersion: ZAI_MODEL_PROBE_REPORT_SCHEMA,
        generatedAt: "2026-06-30T00:00:00.000Z",
        baseUrlHost: "api.z.ai",
        modelsProbed: 2,
        callable: 1,
        failed: 1,
        estimatedModelCalls: 2,
        jsonCapabilityProbed: false,
        rows: [
          { modelId: "bad-model", classification: "invalid_model_id", latencyMs: 1, message: "nope" },
          { modelId: "good-model", classification: "callable", latencyMs: 1, message: "ok" },
        ],
      }),
      snapshotCampaignEvidence: async ({ safeModelId, runIndex, modelId }) =>
        mockCampaignSnapshot({ safeModelId, runIndex, modelId }),
      runCommand: async (input) => {
        invocations.push(input.env.ZAI_MODEL ?? "");
        return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
      },
      gateEvaluator: async () => ({
        ok: true,
        violations: [],
        summary: {
          providerId: "zai",
          adapterId: "openai-compatible",
          modelId: "good-model",
          host: "https://api.z.ai",
          harnessStatus: "passed",
          scenariosPassed: 1,
          scenariosTotal: 1,
          campaignTokens: 10,
          campaignTokenLimit: 100_000,
          campaignModelCalls: 1,
          estimatedCostUsd: 0,
          latestMarkdown: "x",
          manifestUpdated: false,
        },
      }),
    });

    expect(summary.skippedProbeCount).toBe(1);
    expect(summary.probePrefilter?.modelsSkipped).toEqual(["bad-model"]);
    expect(new Set(invocations)).toEqual(new Set(["good-model"]));
    expect(invocations.length).toBe(ZAI_MATRIX_LIVE_CAMPAIGN_STEPS.length);
    expect(summary.campaigns.find((c) => c.modelId === "bad-model")?.status).toBe("skipped_probe");
  });

  it("marks overall status fail with passedCount 0 when probe pre-filter skips every model", async () => {
    const summary = await runZaiModelMatrix({
      repoRoot: process.cwd(),
      models: ["bad-a", "bad-b"],
      modelSource: "ZAI_MODELS",
      config: {
        runsPerModel: 1,
        skipOffline: true,
        continueOnFailure: true,
        prefilterWithProbe: true,
        probeJsonCapability: false,
      },
      probeRunner: async () => ({
        schemaVersion: ZAI_MODEL_PROBE_REPORT_SCHEMA,
        generatedAt: "2026-06-30T00:00:00.000Z",
        baseUrlHost: "api.z.ai",
        modelsProbed: 2,
        callable: 0,
        failed: 2,
        estimatedModelCalls: 2,
        jsonCapabilityProbed: false,
        rows: [
          { modelId: "bad-a", classification: "invalid_model_id", latencyMs: 1, message: "nope" },
          { modelId: "bad-b", classification: "auth_failure", latencyMs: 1, message: "nope" },
        ],
      }),
      snapshotCampaignEvidence: async ({ safeModelId, runIndex, modelId }) =>
        mockCampaignSnapshot({ safeModelId, runIndex, modelId }),
      runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
      gateEvaluator: async () => ({
        ok: true,
        violations: [],
        summary: {
          providerId: "zai",
          adapterId: "openai-compatible",
          modelId: "unused",
          host: "https://api.z.ai",
          harnessStatus: "passed",
          scenariosPassed: 1,
          scenariosTotal: 1,
          campaignTokens: 10,
          campaignTokenLimit: 100_000,
          campaignModelCalls: 1,
          estimatedCostUsd: 0,
          latestMarkdown: "x",
          manifestUpdated: false,
        },
      }),
    });

    expect(summary.passedCount).toBe(0);
    expect(summary.failedCount).toBe(0);
    expect(summary.skippedProbeCount).toBe(2);
    expect(summary.overallStatus).toBe("fail");
    expect(formatZaiMatrixSummaryMarkdown(summary)).toContain("gate `campaignTokens`");
  });

  it("does not reference stale snapshot files or shared canonical paths when a campaign fails early", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "zai-matrix-stale-"));
    try {
      const staleDir = path.join(repoRoot, ".rector/evidence/live/zai/matrix/glm-4.5-flash/0");
      await mkdir(staleDir, { recursive: true });
      await writeFile(
        path.join(staleDir, "latest.json"),
        `${JSON.stringify({ modelId: "other-model" })}\n`,
        "utf8",
      );
      const zaiDir = getZaiLiveEvidenceDir(repoRoot);
      await mkdir(zaiDir, { recursive: true });
      await writeFile(
        path.join(zaiDir, "latest.json"),
        `${JSON.stringify({ modelId: "other-model" })}\n`,
        "utf8",
      );

      const summary = await runZaiModelMatrix({
        repoRoot,
        models: ["glm-4.5-flash"],
        modelSource: "ZAI_MODEL",
        env: { ZAI_API_KEY: "secret-key-should-not-appear", ZAI_MODEL: "glm-4.5-flash" },
        config: {
          runsPerModel: 1,
          skipOffline: true,
          continueOnFailure: true,
          prefilterWithProbe: false,
          probeJsonCapability: false,
        },
        runCommand: async () => ({ exitCode: 1, stdout: "", stderr: "", durationMs: 1 }),
        gateEvaluator: async () => ({ ok: false, violations: ["skipped"], summary: {
          providerId: null,
          adapterId: null,
          modelId: null,
          host: null,
          harnessStatus: null,
          scenariosPassed: 0,
          scenariosTotal: 0,
          campaignTokens: 0,
          campaignTokenLimit: 100_000,
          campaignModelCalls: 0,
          estimatedCostUsd: 0,
          latestMarkdown: "x",
          manifestUpdated: false,
        } }),
      });

      const campaign = summary.campaigns[0];
      expect(campaign.reportPointers.latestJson).toBe(MATRIX_ARTIFACT_NOT_CAPTURED);
      expect(campaign.snapshotHealth).toBe("empty");
      expect(JSON.stringify(summary)).not.toContain("ZAI_API_KEY");
      expect(JSON.stringify(summary)).not.toContain(".rector/evidence/live/zai/latest.json");
      await expect(readFile(path.join(staleDir, "latest.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});