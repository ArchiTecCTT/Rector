import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { GateZaiLiveEvidenceResult } from "../../src/live/gateZaiLiveEvidence";
import {
  assertMatrixArtifactHasNoSecrets,
  buildIsolatedCampaignEnv,
  buildStepCommandLog,
  dedupeZaiModelsPreserveOrder,
  deriveZaiModelCampaignRating,
  formatZaiMatrixSummaryMarkdown,
  parseZaiModelsList,
  resolveZaiMatrixConfig,
  resolveZaiMatrixModels,
  runZaiModelMatrix,
  toSafeModelEvidenceId,
  writeZaiMatrixSummary,
  ZAI_MATRIX_LIVE_CAMPAIGN_STEPS,
  ZAI_MATRIX_SUMMARY_SCHEMA_VERSION,
} from "../../src/live/zaiModelMatrix";

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
    });
    expect(config.runsPerModel).toBe(3);
    expect(config.skipOffline).toBe(true);
    expect(config.continueOnFailure).toBe(false);
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
        RECTOR_LIVE_PROVIDER: "zai",
      },
    );
    expect(entry.envKeys).not.toContain("ZAI_API_KEY");
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
    expect(
      deriveZaiModelCampaignRating({
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
      }).grade,
    ).toBe("A");
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
      },
      runCommand: async (input) => {
        const script = input.args[1] ?? "";
        invocations.push({ model: input.env.ZAI_MODEL, script });
        return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
      },
      gateEvaluator: async () => gateOk,
      now: () => new Date("2026-06-30T12:00:00.000Z"),
    });

    expect(summary.schemaVersion).toBe(ZAI_MATRIX_SUMMARY_SCHEMA_VERSION);
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
      },
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
        config: { runsPerModel: 1, skipOffline: true, continueOnFailure: true },
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
});