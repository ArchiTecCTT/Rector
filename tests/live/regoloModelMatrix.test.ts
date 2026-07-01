import { describe, expect, it } from "vitest";

import {
  assertMatrixArtifactHasNoSecrets,
  buildIsolatedCampaignEnv,
  buildStepCommandLog,
  formatRegoloMatrixSummaryMarkdown,
  parseRegoloModelsList,
  REGOLO_MATRIX_LIVE_CAMPAIGN_STEPS,
  resolveRegoloMatrixModels,
  runRegoloModelMatrix,
} from "../../src/live/regoloModelMatrix";

describe("regoloModelMatrix parsing", () => {
  it("resolves models from REGOLO_MODELS with optional cap", () => {
    const env = {
      REGOLO_MODELS: "qwen3.5-9b,Llama-3.3-70B-Instruct,mistral-small-4-119b",
      REGOLO_MATRIX_MAX_MODELS: "2",
    };
    expect(resolveRegoloMatrixModels(env)).toEqual({
      models: ["qwen3.5-9b", "Llama-3.3-70B-Instruct"],
      source: "REGOLO_MODELS",
    });
  });

  it("falls back to single REGOLO_MODEL", () => {
    expect(resolveRegoloMatrixModels({ REGOLO_MODEL: "gpt-oss-20b" })).toEqual({
      models: ["gpt-oss-20b"],
      source: "REGOLO_MODEL",
    });
  });

  it("isolates REGOLO_MODEL per campaign env", () => {
    const env = buildIsolatedCampaignEnv(
      {
        REGOLO_API_KEY: "secret-key-value",
        REGOLO_BASE_URL: "https://api.regolo.ai/v1",
        REGOLO_MODEL: "old",
      },
      "qwen3.5-9b",
    );
    expect(env.REGOLO_MODEL).toBe("qwen3.5-9b");
    expect(env.RECTOR_LIVE_PROVIDER).toBe("regolo");
    expect(env.REGOLO_API_KEY).toBe("secret-key-value");
  });

  it("parses model lists via regoloModelsEnv", () => {
    expect(parseRegoloModelsList("a,b")).toEqual(["a", "b"]);
  });
});

describe("regoloModelMatrix env isolation and artifact hygiene", () => {
  it("omits cross-provider credential env keys from command logs when .envrc also has Z.ai vars", () => {
    const step = REGOLO_MATRIX_LIVE_CAMPAIGN_STEPS[0];
    const entry = buildStepCommandLog(
      step,
      {
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 5,
      },
      {
        REGOLO_MODEL: "qwen3.5-9b",
        REGOLO_API_KEY: "regolo-secret-value",
        ZAI_API_KEY: "zai-secret-from-shared-envrc",
        OPENAI_COMPATIBLE_API_KEY: "compat-secret",
        AZURE_OPENAI_API_KEY: "azure-from-envrc",
        GITHUB_TOKEN: "gh-from-envrc",
        LINEAR_API_KEY: "linear-from-envrc",
        RECTOR_LIVE_PROVIDER: "regolo",
        LIVE_FACT_EVALS: "1",
      },
    );
    expect(entry.envKeys).not.toContain("REGOLO_API_KEY");
    expect(entry.envKeys).not.toContain("ZAI_API_KEY");
    expect(entry.envKeys).not.toContain("OPENAI_COMPATIBLE_API_KEY");
    expect(entry.envKeys).not.toContain("AZURE_OPENAI_API_KEY");
    expect(entry.envKeys).not.toContain("GITHUB_TOKEN");
    expect(entry.envKeys).not.toContain("LINEAR_API_KEY");
    expect(entry.envKeys).toContain("REGOLO_MODEL");
    expect(entry.envKeys).toContain("LIVE_FACT_EVALS");
  });

  it("uses Regolo-specific secret scan errors", () => {
    expect(() =>
      assertMatrixArtifactHasNoSecrets({ note: "Bearer sk-12345678901234567890123456789012" }),
    ).toThrow(/Regolo live matrix artifact contains secret-like content/);
    expect(() =>
      assertMatrixArtifactHasNoSecrets({ REGOLO_API_KEY: "aaaaaaaaaaaaaaaa" }),
    ).toThrow(/Regolo live matrix artifact/);
  });

  it("accepts matrix summaries that only list non-credential env keys", async () => {
    const summary = await runRegoloModelMatrix({
      repoRoot: process.cwd(),
      models: ["qwen3.5-9b"],
      modelSource: "REGOLO_MODEL",
      env: {
        REGOLO_API_KEY: "regolo-live-key-value",
        ZAI_API_KEY: "zai-from-envrc",
        REGOLO_BASE_URL: "https://api.regolo.ai/v1",
      },
      config: {
        runsPerModel: 1,
        skipOffline: true,
        continueOnFailure: true,
        prefilterWithProbe: false,
        probeJsonCapability: false,
      },
      snapshotCampaignEvidence: async ({ safeModelId, runIndex }) => ({
        evidenceSnapshotDir: `.rector/evidence/live/regolo/matrix/${safeModelId}/${runIndex}`,
        reportPointers: {
          latestJson: `.rector/evidence/live/regolo/matrix/${safeModelId}/${runIndex}/latest.json`,
          latestMd: `.rector/evidence/live/regolo/matrix/${safeModelId}/${runIndex}/latest.md`,
          providerSmokeJson: `.rector/evidence/live/regolo/matrix/${safeModelId}/${runIndex}/provider-smoke.json`,
          phase2ShadowJson: `.rector/evidence/phase2/live-fact-shadow-report.json`,
        },
        copiedFiles: [],
        skippedArtifacts: [],
      }),
      runCommand: async () => ({ exitCode: 1, stdout: "", stderr: "", durationMs: 1 }),
      gateEvaluator: async () => ({
        ok: false,
        violations: ["fixture"],
        summary: {
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
        },
      }),
      now: () => new Date("2026-07-01T12:00:00.000Z"),
    });

    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("ZAI_API_KEY");
    expect(serialized).not.toContain("REGOLO_API_KEY");
    expect(formatRegoloMatrixSummaryMarkdown(summary)).toContain("Regolo live model matrix summary");
    expect(formatRegoloMatrixSummaryMarkdown(summary)).not.toContain("Z.ai live model matrix summary");
  });
});