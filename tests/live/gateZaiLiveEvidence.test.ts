import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ZAI_HARNESS_SCORECARD_SCHEMA_VERSION } from "../../src/live/harnessScorecard";
import {
  ZAI_HARNESS_REPORT_SCHEMA_VERSION,
  ZaiHarnessReportSchema,
} from "../../src/live/zaiHarnessReport";
import {
  ZAI_PROVIDER_SMOKE_REPORT_SCHEMA_VERSION,
  ZaiProviderSmokeReportSchema,
} from "../../src/live/zaiProviderSmokeReport";
import {
  gateZaiLiveEvidence,
  isResolvedPathInsideDirectory,
  resolveGateZaiLiveEvidenceInvocation,
  ZAI_LIVE_RUN_ARTIFACT_FILES,
} from "../../src/live/gateZaiLiveEvidence";

const GENERATED_AT = "2026-06-30T12:00:00.000Z";
const RUN_ID = "zai-gate-fixture-run";

describe("gateZaiLiveEvidence", () => {
  it("passes for sanitized live_provider campaign fixtures and updates manifest", async () => {
    const repoRoot = await makeRepo();
    try {
      await writePassingCampaignFixture(repoRoot);
      const result = await gateZaiLiveEvidence({
        repoRoot,
        now: () => new Date(GENERATED_AT),
      });
      expect(result.violations, result.violations.join("; ")).toHaveLength(0);
      expect(result.ok).toBe(true);
      expect(result.summary.manifestUpdated).toBe(true);
      const manifest = JSON.parse(
        await readFile(path.join(repoRoot, ".rector", "evidence", "manifest.json"), "utf8"),
      );
      expect(manifest.liveEvidenceStatus).toBe("live_provider");
      expect(manifest.campaignBudget?.total.totalTokens).toBeGreaterThan(0);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("rejects non-live liveEvidenceStatus", async () => {
    const repoRoot = await makeRepo();
    try {
      await writePassingCampaignFixture(repoRoot, { liveEvidenceStatus: "test_only_injected" });
      const result = await gateZaiLiveEvidence({ repoRoot, updateManifestOnPass: false });
      expect(result.ok).toBe(false);
      expect(result.violations.some((v) => v.includes("liveEvidenceStatus"))).toBe(true);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("rejects fake provider identities", async () => {
    const repoRoot = await makeRepo();
    try {
      await writePassingCampaignFixture(repoRoot, { providerId: "spy-llm-provider" });
      const result = await gateZaiLiveEvidence({ repoRoot, updateManifestOnPass: false });
      expect(result.ok).toBe(false);
      expect(result.violations.some((v) => v.includes("fake/deterministic"))).toBe(true);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("fails when required run artifacts are missing", async () => {
    const repoRoot = await makeRepo();
    try {
      await writePassingCampaignFixture(repoRoot, { omitRunArtifacts: true });
      const result = await gateZaiLiveEvidence({ repoRoot, updateManifestOnPass: false });
      expect(result.ok).toBe(false);
      expect(result.violations.some((v) => v.includes("missing required artifact"))).toBe(true);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("fails when campaign tokens exceed the 100k budget", async () => {
    const repoRoot = await makeRepo();
    try {
      await writePassingCampaignFixture(repoRoot, { harnessTotalTokens: 95_000, phase2TotalTokens: 10_000 });
      const result = await gateZaiLiveEvidence({ repoRoot, updateManifestOnPass: false });
      expect(result.ok).toBe(false);
      expect(result.violations.some((v) => v.includes("exceeds limit"))).toBe(true);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("fails when campaign model calls are zero", async () => {
    const repoRoot = await makeRepo();
    try {
      await writePassingCampaignFixture(repoRoot, { zeroModelCalls: true });
      const result = await gateZaiLiveEvidence({ repoRoot, updateManifestOnPass: false });
      expect(result.ok).toBe(false);
      expect(result.violations.some((v) => v.includes("modelCalls"))).toBe(true);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("fails when read-only scenarios record source mutation", async () => {
    const repoRoot = await makeRepo();
    try {
      await writePassingCampaignFixture(repoRoot, { mutateScenarioId: "B1" });
      const result = await gateZaiLiveEvidence({ repoRoot, updateManifestOnPass: false });
      expect(result.ok).toBe(false);
      expect(result.violations.some((v) => v.includes("mutated source files"))).toBe(true);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("fails when secret-like values appear in evidence", async () => {
    const repoRoot = await makeRepo();
    try {
      await writePassingCampaignFixture(repoRoot, { secretLeak: "sk-livegatefixturesecret1234567890" });
      const result = await gateZaiLiveEvidence({ repoRoot, updateManifestOnPass: false });
      expect(result.ok).toBe(false);
      expect(result.violations.some((v) => v.includes("secret-like"))).toBe(true);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("rejects missing host and adapter on harness and provider-smoke tracks", async () => {
    const repoRoot = await makeRepo();
    try {
      await writePassingCampaignFixture(repoRoot, { host: null, adapterId: null });
      const result = await gateZaiLiveEvidence({ repoRoot, updateManifestOnPass: false });
      expect(result.ok).toBe(false);
      expect(result.violations.some((v) => v.includes("host is required"))).toBe(true);
      expect(result.violations.some((v) => v.includes("adapterId is required"))).toBe(true);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("rejects non-Z.ai host", async () => {
    const repoRoot = await makeRepo();
    try {
      await writePassingCampaignFixture(repoRoot, { host: "api.openai.com" });
      const result = await gateZaiLiveEvidence({ repoRoot, updateManifestOnPass: false });
      expect(result.ok).toBe(false);
      expect(result.violations.some((v) => v.includes("not an intended Z.ai"))).toBe(true);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("rejects test_only_injected provider-smoke track", async () => {
    const repoRoot = await makeRepo();
    try {
      await writePassingCampaignFixture(repoRoot, { providerSmokeLiveEvidenceStatus: "test_only_injected" });
      const result = await gateZaiLiveEvidence({ repoRoot, updateManifestOnPass: false });
      expect(result.ok).toBe(false);
      expect(result.violations.some((v) => v.includes("provider-smoke liveEvidenceStatus"))).toBe(true);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("rejects skipped provider-smoke status", async () => {
    const repoRoot = await makeRepo();
    try {
      await writePassingCampaignFixture(repoRoot, { providerSmokeStatus: "skipped" });
      const result = await gateZaiLiveEvidence({ repoRoot, updateManifestOnPass: false });
      expect(result.ok).toBe(false);
      expect(result.violations.some((v) => v.includes("provider-smoke status"))).toBe(true);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("rejects test_only_injected phase2 track", async () => {
    const repoRoot = await makeRepo();
    try {
      await writePassingCampaignFixture(repoRoot, { phase2LiveEvidenceStatus: "test_only_injected" });
      const result = await gateZaiLiveEvidence({ repoRoot, updateManifestOnPass: false });
      expect(result.ok).toBe(false);
      expect(result.violations.some((v) => v.includes("phase2 live fact shadow liveEvidenceStatus"))).toBe(true);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("rejects failed harness status and scorecard", async () => {
    const repoRoot = await makeRepo();
    try {
      await writePassingCampaignFixture(repoRoot, { harnessStatus: "failed", scorecardPassed: false });
      const result = await gateZaiLiveEvidence({ repoRoot, updateManifestOnPass: false });
      expect(result.ok).toBe(false);
      expect(result.violations.some((v) => v.includes("harness status"))).toBe(true);
      expect(result.violations.some((v) => v.includes("scorecard.passed"))).toBe(true);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("rejects artifact pointers that escape via sibling-prefix paths", async () => {
    const repoRoot = await makeRepo();
    try {
      await writePassingCampaignFixture(repoRoot, {
        artifactPointerEscape: "../zai_evil/harness-report.json",
      });
      const result = await gateZaiLiveEvidence({ repoRoot, updateManifestOnPass: false });
      expect(result.ok).toBe(false);
      expect(result.violations.some((v) => v.includes("escapes live/zai"))).toBe(true);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("fails when campaign track timestamps are too far apart", async () => {
    const repoRoot = await makeRepo();
    try {
      await writePassingCampaignFixture(repoRoot, {
        providerSmokeGeneratedAt: "2026-06-30T10:00:00.000Z",
        phase2GeneratedAt: "2026-06-30T12:00:00.000Z",
      });
      const result = await gateZaiLiveEvidence({ repoRoot, updateManifestOnPass: false });
      expect(result.ok).toBe(false);
      expect(result.violations.some((v) => v.includes("campaign evidence timestamps span"))).toBe(true);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("resolveGateZaiLiveEvidenceInvocation disables manifest update for harness-only", () => {
    expect(resolveGateZaiLiveEvidenceInvocation({ harnessOnly: true })).toEqual({
      requireCampaignTracks: false,
      updateManifestOnPass: false,
      harnessOnlyDiagnostic: true,
    });
  });

  it("isResolvedPathInsideDirectory rejects sibling-prefix escapes", () => {
    const zaiDir = path.join("/tmp", "evidence", "live", "zai");
    const evil = path.resolve(zaiDir, "../zai_evil/file.json");
    expect(isResolvedPathInsideDirectory(evil, zaiDir)).toBe(false);
  });

  it("does not update manifest when the gate fails", async () => {
    const repoRoot = await makeRepo();
    const manifestPath = path.join(repoRoot, ".rector", "evidence", "manifest.json");
    try {
      await mkdir(path.dirname(manifestPath), { recursive: true });
      await writeFile(
        manifestPath,
        `${JSON.stringify({ liveEvidenceStatus: "unknown", marker: "keep" }, null, 2)}\n`,
        "utf8",
      );
      await writePassingCampaignFixture(repoRoot, { liveEvidenceStatus: "test_only_injected" });
      const result = await gateZaiLiveEvidence({ repoRoot, now: () => new Date(GENERATED_AT) });
      expect(result.ok).toBe(false);
      expect(result.summary.manifestUpdated).toBe(false);
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      expect(manifest.liveEvidenceStatus).toBe("unknown");
      expect(manifest.marker).toBe("keep");
      expect(manifest.secretScanPassedAt).toBeUndefined();
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "rector-zai-gate-"));
  await mkdir(path.join(root, ".rector", "evidence", "live", "zai", "runs", RUN_ID), { recursive: true });
  await mkdir(path.join(root, ".rector", "evidence", "phase2"), { recursive: true });
  return root;
}

async function writePassingCampaignFixture(
  repoRoot: string,
  options: {
    liveEvidenceStatus?: "live_provider" | "test_only_injected";
    providerSmokeLiveEvidenceStatus?: "live_provider" | "test_only_injected" | "skipped";
    phase2LiveEvidenceStatus?: "live_provider" | "test_only_injected" | "skipped";
    providerSmokeStatus?: "passed" | "failed" | "skipped";
    providerId?: string;
    adapterId?: string | null;
    host?: string | null;
    harnessStatus?: "passed" | "failed";
    scorecardPassed?: boolean;
    omitRunArtifacts?: boolean;
    harnessTotalTokens?: number;
    phase2TotalTokens?: number;
    zeroModelCalls?: boolean;
    mutateScenarioId?: string;
    secretLeak?: string;
    artifactPointerEscape?: string;
    providerSmokeGeneratedAt?: string;
    phase2GeneratedAt?: string;
  } = {},
): Promise<void> {
  const zaiDir = path.join(repoRoot, ".rector", "evidence", "live", "zai");
  const runDir = path.join(zaiDir, "runs", RUN_ID);
  const providerId = options.providerId ?? "zai:env";
  const liveEvidenceStatus = options.liveEvidenceStatus ?? "live_provider";
  const providerSmokeLiveEvidenceStatus = options.providerSmokeLiveEvidenceStatus ?? liveEvidenceStatus;
  const phase2LiveEvidenceStatus = options.phase2LiveEvidenceStatus ?? liveEvidenceStatus;
  const harnessStatus = options.harnessStatus ?? "passed";
  const scorecardPassed = options.scorecardPassed ?? true;
  const adapterId = options.adapterId === undefined ? "openai-compatible" : options.adapterId;
  const host = options.host === undefined ? "api.z.ai" : options.host;
  const harnessTokens = options.harnessTotalTokens ?? 1_200;
  const modelCalls = options.zeroModelCalls ? 0 : 3;

  const scenarios = [
    scenarioFixture("B1", "read_only_repository_inspection", options.mutateScenarioId === "B1"),
    scenarioFixture("B2", "plan_only_improvement", options.mutateScenarioId === "B2"),
    scenarioFixture("B3", "forbidden_mutation_safety", options.mutateScenarioId === "B3"),
  ];

  const tokenUsage = {
    schemaVersion: "rector.zai-harness-token-usage.v1",
    generatedAt: GENERATED_AT,
    limits: { maxTotalTokens: 100_000 },
    total: {
      inputTokens: harnessTokens,
      outputTokens: 0,
      totalTokens: harnessTokens,
      estimatedUsd: 0.01,
      modelCalls,
    },
    preflightEstimates: [],
    scenarios: [],
  };

  const scorecard = {
    schemaVersion: ZAI_HARNESS_SCORECARD_SCHEMA_VERSION,
    generatedAt: GENERATED_AT,
    passed: scorecardPassed,
    scenarioCount: 3,
    passedCount: 3,
    failedCount: 0,
    skippedCount: 0,
    failureCounts: Object.fromEntries(
      [
        "provider_config",
        "http",
        "timeout",
        "json",
        "planner",
        "skeptic",
        "crucible",
        "unsafe_unexpected_mutation",
        "missing_evidence",
        "secret_leak",
        "token_budget",
        "scorecard",
        "unknown",
      ].map((kind) => [kind, 0]),
    ),
    mutationFree: true,
    evidenceComplete: true,
    noSecretLeaks: true,
    withinTokenBudget: true,
    notes: ["fixture"],
  };

  const latest = ZaiHarnessReportSchema.parse({
    schemaVersion: ZAI_HARNESS_REPORT_SCHEMA_VERSION,
    generatedAt: GENERATED_AT,
    runId: RUN_ID,
    status: harnessStatus,
    liveEvidenceStatus,
    providerId,
    adapterId,
    modelId: "glm-4.5-air",
    host,
    scenarioCount: 3,
    passedCount: 3,
    failedCount: 0,
    skippedCount: 0,
    scenarios,
    tokenUsage,
    costReport: { status: "within_budget" },
    scorecard,
    artifacts: {
      harnessReportJson: options.artifactPointerEscape ?? `runs/${RUN_ID}/harness-report.json`,
      harnessReportMarkdown: `runs/${RUN_ID}/harness-report.md`,
      runEventsJsonl: `runs/${RUN_ID}/run-events.jsonl`,
      factLedgerJsonl: `runs/${RUN_ID}/fact-ledger.jsonl`,
      providerCallsJson: `runs/${RUN_ID}/provider-calls.json`,
      tokenUsageJson: `runs/${RUN_ID}/token-usage.json`,
      costReportJson: `runs/${RUN_ID}/cost-report.json`,
      redactedPromptsJson: `runs/${RUN_ID}/redacted-prompts.json`,
      redactedModelOutputsJson: `runs/${RUN_ID}/redacted-model-outputs.json`,
      workspaceBeforeManifestJson: `runs/${RUN_ID}/workspace-before-manifest.json`,
      workspaceAfterManifestJson: `runs/${RUN_ID}/workspace-after-manifest.json`,
      scorecardJson: `runs/${RUN_ID}/scorecard.json`,
      scorecardMarkdown: `runs/${RUN_ID}/scorecard.md`,
    },
    failures: [],
    notes: ["fixture"],
  });

  const latestBody = JSON.stringify(latest, null, 2);
  await writeFile(path.join(zaiDir, "latest.json"), options.secretLeak ? `${latestBody}\n${options.secretLeak}\n` : `${latestBody}\n`, "utf8");
  await writeFile(path.join(zaiDir, "latest.md"), "# fixture\n", "utf8");

  if (!options.omitRunArtifacts) {
    const redactedPrompts = {
      schemaVersion: "rector.zai-harness-redacted-prompts.v1",
      generatedAt: GENERATED_AT,
      prompts: [{ callId: "c1", scenarioId: "B1", messages: [{ role: "user", content: "fixture prompt" }] }],
    };
    const redactedOutputs = {
      schemaVersion: "rector.zai-harness-redacted-model-outputs.v1",
      generatedAt: GENERATED_AT,
      outputs: [{ callId: "c1", scenarioId: "B1", content: "fixture output" }],
    };
    for (const name of ZAI_LIVE_RUN_ARTIFACT_FILES) {
      let body = name.endsWith(".md") ? "# fixture\n" : name.endsWith(".jsonl") ? "{}\n" : "{}";
      if (name === "redacted-prompts.json") body = JSON.stringify(redactedPrompts);
      if (name === "redacted-model-outputs.json") body = JSON.stringify(redactedOutputs);
      if (name === "harness-report.json") body = latestBody;
      if (name === "scorecard.json") body = JSON.stringify(scorecard);
      if (name === "token-usage.json") body = JSON.stringify(tokenUsage);
      await writeFile(path.join(runDir, name), `${body}\n`, "utf8");
    }
  }

  const providerSmokeStatus = options.providerSmokeStatus ?? "passed";
  const providerSmokeGeneratedAt = options.providerSmokeGeneratedAt ?? GENERATED_AT;
  const phase2GeneratedAt = options.phase2GeneratedAt ?? GENERATED_AT;

  const providerSmoke = ZaiProviderSmokeReportSchema.parse({
    schemaVersion: ZAI_PROVIDER_SMOKE_REPORT_SCHEMA_VERSION,
    generatedAt: providerSmokeGeneratedAt,
    status: providerSmokeStatus,
    liveEvidenceStatus: providerSmokeLiveEvidenceStatus,
    providerId,
    adapterId,
    modelId: "glm-4.5-air",
    host,
    ...(providerSmokeStatus === "skipped" ? { skippedReason: "fixture skip" } : {}),
    tokenUsage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      modelCalls: options.zeroModelCalls ? 0 : 1,
    },
    estimatedCostUsd: 0.0001,
    latencyMs: 12,
    notes: ["fixture"],
  });
  await writeFile(path.join(zaiDir, "provider-smoke.json"), `${JSON.stringify(providerSmoke, null, 2)}\n`, "utf8");

  const phase2Dir = path.join(repoRoot, ".rector", "evidence", "phase2");
  const phase2Tokens = options.phase2TotalTokens ?? 500;
  const phase2Report = {
    generatedAt: phase2GeneratedAt,
    status: phase2LiveEvidenceStatus === "skipped" ? "skipped" : "completed",
    liveEvidenceStatus: phase2LiveEvidenceStatus,
    providerId,
    failedCount: 0,
    cases: [{ status: "passed", failureReasons: [] }],
  };
  const phase2Summary = {
    generatedAt: phase2GeneratedAt,
    totalTokenUsage: {
      modelCalls: options.zeroModelCalls ? 0 : 2,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: phase2Tokens,
    },
    liveEvidenceStatus: phase2LiveEvidenceStatus,
    status: phase2LiveEvidenceStatus === "skipped" ? "skipped" : "completed",
    failedCount: 0,
  };
  await writeFile(path.join(phase2Dir, "live-fact-shadow-report.json"), `${JSON.stringify(phase2Report, null, 2)}\n`, "utf8");
  await writeFile(path.join(phase2Dir, "live-fact-shadow-summary.json"), `${JSON.stringify(phase2Summary, null, 2)}\n`, "utf8");
}

function scenarioFixture(
  id: string,
  kind: "read_only_repository_inspection" | "plan_only_improvement" | "forbidden_mutation_safety",
  mutated: boolean,
) {
  return {
    scenarioId: id,
    title: id,
    kind,
    status: "passed" as const,
    startedAt: GENERATED_AT,
    completedAt: GENERATED_AT,
    durationMs: 1,
    runId: RUN_ID,
    runStatus: "completed",
    runPhase: "DONE",
    synthesisStatus: "DONE",
    workspaceMutation: {
      mutationDetected: mutated,
      mutatedPaths: mutated ? ["src/index.ts"] : [],
      added: [],
      removed: [],
      changed: mutated ? ["src/index.ts"] : [],
    },
    evidence: { runEventCount: 2, factCount: 1 },
    tokenUsage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      estimatedUsd: 0.0001,
      modelCalls: 1,
    },
    estimatedCostUsd: 0.0001,
    failures: [],
  };
}