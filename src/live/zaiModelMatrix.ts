import fs from "node:fs/promises";
import path from "node:path";

import {
  getEvidenceTrackDir,
  getZaiLiveEvidenceDir,
  SAFE_EVIDENCE_RUN_ID_PATTERN,
  sanitizeEvidenceStringLeaves,
} from "../evidence";
import type { ModelProbeReport } from "./zaiModelProbe";
import { callableModelsFromProbeReport, runZaiModelProbe } from "./zaiModelProbe";
import { dedupeZaiModelsPreserveOrder, parseZaiModelsList } from "./zaiModelsEnv";

import {
  gateZaiLiveEvidence,
  type GateZaiLiveEvidenceResult,
  type GateZaiLiveEvidenceSummary,
} from "./gateZaiLiveEvidence";
import {
  assertLiveMatrixArtifactHasNoSecrets,
  LIVE_MATRIX_CREDENTIAL_ENV_KEYS,
  sanitizeHarnessEvidenceValue,
} from "./harnessEvidence";
import { ZaiHarnessReportSchema } from "./zaiHarnessReport";
import {
  buildZaiLiveDiagnostics,
  renderZaiLiveDiagnosticsMarkdown,
  ZaiLiveDiagnosticsSchema,
  type ZaiLiveDiagnostics,
} from "./liveHarnessDiagnostics";

export const ZAI_MATRIX_SUMMARY_SCHEMA_VERSION = "rector.zai-live-matrix-summary.v1";

/** @deprecated Prefer {@link LIVE_MATRIX_CREDENTIAL_ENV_KEYS} — kept for importers. */
export const ZAI_MATRIX_SENSITIVE_ENV_KEYS = LIVE_MATRIX_CREDENTIAL_ENV_KEYS;

export type ZaiMatrixGrade = "A" | "B" | "C" | "D" | "F";

export interface ZaiMatrixCommandInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
}

export interface ZaiMatrixCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export type ZaiMatrixCommandRunner = (input: ZaiMatrixCommandInvocation) => Promise<ZaiMatrixCommandResult>;

export interface ZaiMatrixStepDefinition {
  readonly id: string;
  readonly npmScript: string;
  readonly npmArgs?: readonly string[];
}

export const ZAI_MATRIX_OFFLINE_STEP: ZaiMatrixStepDefinition = {
  id: "verify:phase2",
  npmScript: "verify:phase2",
};

export const ZAI_MATRIX_LIVE_CAMPAIGN_STEPS: readonly ZaiMatrixStepDefinition[] = [
  { id: "eval:facts:live", npmScript: "eval:facts:live" },
  { id: "test:live:zai:provider", npmScript: "test:live:zai:provider" },
  { id: "test:live:zai:harness", npmScript: "test:live:zai:harness" },
  {
    id: "evidence:zai-live:gate",
    npmScript: "evidence:zai-live:gate",
    npmArgs: ["--no-manifest-update"],
  },
];

export interface ZaiMatrixConfig {
  readonly runsPerModel: number;
  readonly maxModels?: number;
  readonly skipOffline: boolean;
  readonly continueOnFailure: boolean;
  readonly prefilterWithProbe: boolean;
  readonly probeJsonCapability: boolean;
}

export interface ZaiMatrixStepLogEntry {
  readonly stepId: string;
  readonly command: string;
  readonly envKeys: readonly string[];
  readonly exitCode: number;
  readonly durationMs: number;
  readonly stderrTail?: string;
}

export interface ZaiMatrixCampaignReportPointers {
  readonly latestJson: string;
  readonly latestMd: string;
  readonly providerSmokeJson: string;
  readonly phase2ShadowJson: string;
}

export interface ZaiMatrixCampaignResult {
  readonly modelId: string;
  readonly safeModelId: string;
  readonly runIndex: number;
  readonly status: "pass" | "fail" | "skipped_probe";
  readonly durationMs: number;
  readonly steps: readonly ZaiMatrixStepLogEntry[];
  readonly gate?: GateZaiLiveEvidenceSummary;
  readonly gateViolations?: readonly string[];
  readonly grade: ZaiMatrixGrade;
  readonly rating: string;
  readonly evidenceSnapshotDir: string;
  readonly reportPointers: ZaiMatrixCampaignReportPointers;
  readonly probePrefilterSkipped?: boolean;
}

export interface ZaiMatrixProbePrefilterSummary {
  readonly enabled: boolean;
  readonly modelsSkipped: readonly string[];
  readonly probeReportPath: string;
  readonly rows: ModelProbeReport["rows"];
}

export interface ZaiMatrixSummary {
  readonly schemaVersion: typeof ZAI_MATRIX_SUMMARY_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly repoRoot: string;
  readonly modelSource: "ZAI_MODELS" | "ZAI_MODEL";
  readonly config: ZaiMatrixConfig;
  readonly modelsRequested: readonly string[];
  readonly modelsExecuted: readonly string[];
  readonly campaigns: readonly ZaiMatrixCampaignResult[];
  readonly overallStatus: "pass" | "fail" | "partial";
  readonly passedCount: number;
  readonly failedCount: number;
  readonly skippedProbeCount: number;
  readonly probePrefilter?: ZaiMatrixProbePrefilterSummary;
  readonly diagnostics: ZaiLiveDiagnostics;
}

export function getZaiLiveMatrixEvidenceDir(repoRoot?: string): string {
  return path.join(getZaiLiveEvidenceDir(repoRoot), "matrix");
}

export function getZaiMatrixCampaignSnapshotRelativeDir(safeModelId: string, runIndex: number): string {
  return `.rector/evidence/live/zai/matrix/${safeModelId}/${runIndex}`;
}

export async function snapshotZaiMatrixCampaignEvidence(input: {
  readonly repoRoot: string;
  readonly safeModelId: string;
  readonly runIndex: number;
}): Promise<{
  readonly evidenceSnapshotDir: string;
  readonly reportPointers: ZaiMatrixCampaignReportPointers;
  readonly copiedFiles: readonly string[];
}> {
  const evidenceSnapshotDir = getZaiMatrixCampaignSnapshotRelativeDir(input.safeModelId, input.runIndex);
  const absSnapshotDir = path.join(
    getZaiLiveMatrixEvidenceDir(input.repoRoot),
    input.safeModelId,
    String(input.runIndex),
  );
  await fs.mkdir(absSnapshotDir, { recursive: true });

  const copyPlans: Array<{ readonly src: string; readonly destName: string }> = [
    { src: path.join(getZaiLiveEvidenceDir(input.repoRoot), "latest.json"), destName: "latest.json" },
    { src: path.join(getZaiLiveEvidenceDir(input.repoRoot), "latest.md"), destName: "latest.md" },
    { src: path.join(getZaiLiveEvidenceDir(input.repoRoot), "provider-smoke.json"), destName: "provider-smoke.json" },
    {
      src: path.join(getEvidenceTrackDir("phase2", input.repoRoot), "live-fact-shadow-report.json"),
      destName: "phase2-live-fact-shadow-report.json",
    },
  ];

  const copiedFiles: string[] = [];
  for (const plan of copyPlans) {
    try {
      await fs.copyFile(plan.src, path.join(absSnapshotDir, plan.destName));
      copiedFiles.push(plan.destName);
    } catch {
      // campaign artifacts may be absent when steps fail early
    }
  }

  const prefix = `${evidenceSnapshotDir}/`;
  return {
    evidenceSnapshotDir,
    reportPointers: {
      latestJson: `${prefix}latest.json`,
      latestMd: `${prefix}latest.md`,
      providerSmokeJson: `${prefix}provider-smoke.json`,
      phase2ShadowJson: `${prefix}phase2-live-fact-shadow-report.json`,
    },
    copiedFiles,
  };
}

export { dedupeZaiModelsPreserveOrder, parseZaiModelsList } from "./zaiModelsEnv";

export function toSafeModelEvidenceId(modelId: string): string {
  const trimmed = modelId.trim();
  if (!trimmed) {
    throw new Error("Z.ai matrix model id must not be empty.");
  }
  let sanitized = trimmed.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  if (!sanitized || sanitized === "." || sanitized === "..") {
    throw new Error(`Z.ai matrix model id cannot be converted to a safe evidence segment: ${modelId}`);
  }
  if (!/^[A-Za-z0-9]/.test(sanitized)) {
    sanitized = `m_${sanitized}`;
  }
  if (!SAFE_EVIDENCE_RUN_ID_PATTERN.test(sanitized)) {
    throw new Error(`Z.ai matrix model id is not a safe evidence segment after sanitization: ${modelId}`);
  }
  return sanitized;
}

export function resolveZaiMatrixConfig(env: Record<string, string | undefined> = process.env): ZaiMatrixConfig {
  const runsPerModel = positiveInt(env.ZAI_MATRIX_RUNS_PER_MODEL, 1);
  const maxModelsRaw = env.ZAI_MATRIX_MAX_MODELS?.trim();
  const maxModels = maxModelsRaw ? positiveInt(maxModelsRaw, 0) : undefined;
  const skipOffline = truthyEnv(env.ZAI_MATRIX_SKIP_OFFLINE);
  const continueOnFailure = env.ZAI_MATRIX_CONTINUE_ON_FAILURE === undefined
    ? true
    : truthyEnv(env.ZAI_MATRIX_CONTINUE_ON_FAILURE);
  const prefilterWithProbe = truthyEnv(env.ZAI_MATRIX_PREFILTER_PROBE);
  const probeJsonCapability = truthyEnv(env.ZAI_MATRIX_PROBE_JSON) || truthyEnv(env.ZAI_MODEL_PROBE_JSON);
  return {
    runsPerModel: Math.max(1, runsPerModel),
    ...(maxModels !== undefined && maxModels > 0 ? { maxModels } : {}),
    skipOffline,
    continueOnFailure,
    prefilterWithProbe,
    probeJsonCapability,
  };
}

export function resolveZaiMatrixModels(env: Record<string, string | undefined> = process.env): {
  readonly models: readonly string[];
  readonly source: "ZAI_MODELS" | "ZAI_MODEL" | "empty";
} {
  const fromList = dedupeZaiModelsPreserveOrder(parseZaiModelsList(env.ZAI_MODELS));
  if (fromList.length > 0) {
    return { models: applyMaxModelsCap(fromList, env), source: "ZAI_MODELS" };
  }
  const single = env.ZAI_MODEL?.trim();
  if (single) {
    return { models: [single], source: "ZAI_MODEL" };
  }
  return { models: [], source: "empty" };
}

export function buildIsolatedCampaignEnv(
  baseEnv: Record<string, string | undefined>,
  modelId: string,
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    output[key] = value;
  }
  output.ZAI_MODEL = modelId;
  output.RECTOR_LIVE_PROVIDER = "zai";
  return output;
}

export function buildStepCommandLog(
  step: ZaiMatrixStepDefinition,
  result: ZaiMatrixCommandResult,
  env: Record<string, string>,
): ZaiMatrixStepLogEntry {
  const args = step.npmArgs?.length ? ["--", ...step.npmArgs] : [];
  const command = `npm run ${step.npmScript}${args.length ? ` ${args.join(" ")}` : ""}`;
  return sanitizeEvidenceStringLeaves({
    stepId: step.id,
    command,
    envKeys: Object.keys(env).filter((key) => !LIVE_MATRIX_CREDENTIAL_ENV_KEYS.has(key)).sort(),
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    ...(result.stderr.trim()
      ? { stderrTail: truncateRedactedTail(result.stderr) }
      : {}),
  });
}

export function deriveZaiModelCampaignRating(input: {
  readonly gateOk: boolean;
  readonly gateSummary?: GateZaiLiveEvidenceSummary;
  readonly scorecardPassed?: boolean;
}): { readonly grade: ZaiMatrixGrade; readonly rating: string } {
  if (!input.gateOk) {
    return { grade: "F", rating: "gate_fail" };
  }
  if (input.scorecardPassed === false) {
    return { grade: "C", rating: "gate_pass_scorecard_fail" };
  }
  const total = input.gateSummary?.scenariosTotal ?? 0;
  const passed = input.gateSummary?.scenariosPassed ?? 0;
  if (total > 0 && passed === total) {
    return { grade: "A", rating: "gate_and_harness_pass" };
  }
  if (total > 0 && passed / total >= 0.8) {
    return { grade: "B", rating: "partial_scenarios" };
  }
  if (input.gateOk) {
    return { grade: "D", rating: "gate_pass_weak_harness" };
  }
  return { grade: "F", rating: "fail" };
}

export function assertMatrixArtifactHasNoSecrets(value: unknown): void {
  assertLiveMatrixArtifactHasNoSecrets(value, { artifactLabel: "Z.ai live matrix" });
}

export async function runZaiModelMatrix(options: {
  readonly repoRoot: string;
  readonly env?: Record<string, string | undefined>;
  readonly config?: ZaiMatrixConfig;
  readonly models?: readonly string[];
  readonly modelSource?: "ZAI_MODELS" | "ZAI_MODEL";
  readonly runCommand: ZaiMatrixCommandRunner;
  readonly now?: () => Date;
  readonly gateEvaluator?: (input: { repoRoot: string }) => Promise<GateZaiLiveEvidenceResult>;
  readonly probeRunner?: (input: {
    readonly models: readonly string[];
    readonly env: Record<string, string | undefined>;
    readonly config: ZaiMatrixConfig;
    readonly repoRoot: string;
  }) => Promise<ModelProbeReport>;
  readonly snapshotCampaignEvidence?: (input: {
    readonly repoRoot: string;
    readonly safeModelId: string;
    readonly runIndex: number;
  }) => ReturnType<typeof snapshotZaiMatrixCampaignEvidence>;
}): Promise<ZaiMatrixSummary> {
  const repoRoot = path.resolve(options.repoRoot);
  const env = options.env ?? process.env;
  const config = options.config ?? resolveZaiMatrixConfig(env);
  const resolved = options.models
    ? {
        models: [...options.models],
        source: options.modelSource ?? ("ZAI_MODELS" as const),
      }
    : resolveZaiMatrixModels(env);
  if (resolved.models.length === 0 || resolved.source === "empty") {
    throw new Error("Z.ai matrix requires ZAI_MODELS or ZAI_MODEL to be set.");
  }

  const gateEvaluator = options.gateEvaluator ?? ((input) =>
    gateZaiLiveEvidence({
      repoRoot: input.repoRoot,
      updateManifestOnPass: false,
      requireCampaignTracks: true,
    }));

  const generatedAt = (options.now?.() ?? new Date()).toISOString();
  const campaigns: ZaiMatrixCampaignResult[] = [];
  let offlineFailed = false;
  const snapshotCampaignEvidence = options.snapshotCampaignEvidence ?? snapshotZaiMatrixCampaignEvidence;
  const probeRunner = options.probeRunner ?? ((input) =>
    runZaiModelProbe({
      env: input.env,
      models: [...input.models],
      repoRoot: input.repoRoot,
      write: true,
      probeJsonCapability: input.config.probeJsonCapability,
    }));

  let probePrefilter: ZaiMatrixProbePrefilterSummary | undefined;
  let modelsToRun = [...resolved.models];
  const skippedByProbe = new Set<string>();

  if (config.prefilterWithProbe) {
    const probeReport = await probeRunner({
      models: resolved.models,
      env,
      config,
      repoRoot,
    });
    const callable = new Set(callableModelsFromProbeReport(probeReport));
    for (const modelId of resolved.models) {
      if (!callable.has(modelId)) skippedByProbe.add(modelId);
    }
    modelsToRun = resolved.models.filter((modelId) => callable.has(modelId));
    probePrefilter = {
      enabled: true,
      modelsSkipped: [...skippedByProbe],
      probeReportPath: ".rector/evidence/live/zai/model-probe/latest.json",
      rows: probeReport.rows,
    };
    if (modelsToRun.length === 0 && !config.continueOnFailure) {
      throw new Error("Z.ai matrix probe pre-filter found no callable models.");
    }
  }

  if (!config.skipOffline) {
    const offlineResult = await options.runCommand({
      command: "npm",
      args: ["run", ZAI_MATRIX_OFFLINE_STEP.npmScript],
      cwd: repoRoot,
      env: stringifyEnv(env),
    });
    if (offlineResult.exitCode !== 0) {
      offlineFailed = true;
      if (!config.continueOnFailure) {
        throw new Error(
          `Z.ai matrix offline step ${ZAI_MATRIX_OFFLINE_STEP.id} failed with exit ${offlineResult.exitCode}.`,
        );
      }
    }
  }

  for (const modelId of resolved.models) {
    if (skippedByProbe.has(modelId)) {
      const safeModelId = toSafeModelEvidenceId(modelId);
      for (let runIndex = 0; runIndex < config.runsPerModel; runIndex += 1) {
        const evidenceSnapshotDir = getZaiMatrixCampaignSnapshotRelativeDir(safeModelId, runIndex);
        campaigns.push({
          modelId,
          safeModelId,
          runIndex,
          status: "skipped_probe",
          durationMs: 0,
          steps: [],
          grade: "F",
          rating: "probe_not_callable",
          evidenceSnapshotDir,
          reportPointers: sharedCanonicalReportPointers(),
          probePrefilterSkipped: true,
        });
      }
    }
  }

  modelLoop: for (const modelId of modelsToRun) {
    const safeModelId = toSafeModelEvidenceId(modelId);
    for (let runIndex = 0; runIndex < config.runsPerModel; runIndex += 1) {
      const campaignStart = Date.now();
      const campaignEnv = buildIsolatedCampaignEnv(env, modelId);
      const steps: ZaiMatrixStepLogEntry[] = [];
      let campaignFailed = offlineFailed;

      for (const step of ZAI_MATRIX_LIVE_CAMPAIGN_STEPS) {
        const args = ["run", step.npmScript, ...(step.npmArgs?.length ? ["--", ...step.npmArgs] : [])];
        const stepStart = Date.now();
        const result = await options.runCommand({
          command: "npm",
          args,
          cwd: repoRoot,
          env: campaignEnv,
        });
        steps.push(
          buildStepCommandLog(step, { ...result, durationMs: Date.now() - stepStart }, campaignEnv),
        );
        if (result.exitCode !== 0) {
          campaignFailed = true;
          break;
        }
      }

      let gateResult: GateZaiLiveEvidenceResult | undefined;
      let scorecardPassed: boolean | undefined;
      if (!campaignFailed) {
        gateResult = await gateEvaluator({ repoRoot });
        scorecardPassed = await readHarnessScorecardPassed(repoRoot);
        if (!gateResult.ok) {
          campaignFailed = true;
        }
      }

      const { grade, rating } = deriveZaiModelCampaignRating({
        gateOk: gateResult?.ok ?? false,
        gateSummary: gateResult?.summary,
        scorecardPassed,
      });

      const snapshot = await snapshotCampaignEvidence({ repoRoot, safeModelId, runIndex });

      campaigns.push({
        modelId,
        safeModelId,
        runIndex,
        status: campaignFailed ? "fail" : "pass",
        durationMs: Date.now() - campaignStart,
        steps,
        ...(gateResult?.summary ? { gate: gateResult.summary } : {}),
        ...(gateResult && !gateResult.ok ? { gateViolations: gateResult.violations } : {}),
        grade,
        rating,
        evidenceSnapshotDir: snapshot.evidenceSnapshotDir,
        reportPointers: snapshot.reportPointers,
      });

      if (campaignFailed && !config.continueOnFailure) {
        break modelLoop;
      }
    }
  }

  const passedCount = campaigns.filter((c) => c.status === "pass").length;
  const failedCount = campaigns.filter((c) => c.status === "fail").length;
  const skippedProbeCount = campaigns.filter((c) => c.status === "skipped_probe").length;
  const overallStatus: ZaiMatrixSummary["overallStatus"] = failedCount === 0 && skippedProbeCount === 0
    ? "pass"
    : passedCount === 0
      ? "fail"
      : "partial";

  const summary: ZaiMatrixSummary = {
    schemaVersion: ZAI_MATRIX_SUMMARY_SCHEMA_VERSION,
    generatedAt,
    repoRoot: ".",
    modelSource: resolved.source,
    config,
    modelsRequested: [...resolved.models],
    modelsExecuted: dedupeZaiModelsPreserveOrder(
      campaigns.filter((c) => c.status !== "skipped_probe").map((c) => c.modelId),
    ),
    campaigns,
    overallStatus,
    passedCount,
    failedCount,
    skippedProbeCount,
    diagnostics: buildMatrixDiagnostics(campaigns),
    ...(probePrefilter ? { probePrefilter } : {}),
  };

  assertMatrixArtifactHasNoSecrets(summary);
  return summary;
}

export async function writeZaiMatrixSummary(
  summary: ZaiMatrixSummary,
  options: { readonly repoRoot: string },
): Promise<{ readonly jsonPath: string; readonly markdownPath: string }> {
  const sanitized = sanitizeEvidenceStringLeaves(summary);
  assertMatrixArtifactHasNoSecrets(sanitized);
  const matrixDir = getZaiLiveMatrixEvidenceDir(options.repoRoot);
  await fs.mkdir(matrixDir, { recursive: true });
  const jsonPath = path.join(matrixDir, "matrix-summary.json");
  const markdownPath = path.join(matrixDir, "matrix-summary.md");
  await fs.writeFile(jsonPath, `${JSON.stringify(sanitized, null, 2)}\n`, "utf8");
  await fs.writeFile(markdownPath, formatZaiMatrixSummaryMarkdown(sanitized), "utf8");
  return { jsonPath, markdownPath };
}

export function formatZaiMatrixSummaryMarkdown(summary: ZaiMatrixSummary): string {
  const lines: string[] = [];
  lines.push("# Z.ai live model matrix summary");
  lines.push("");
  lines.push(`Generated: ${summary.generatedAt}`);
  lines.push(`Schema: ${summary.schemaVersion}`);
  lines.push(
    `Overall: **${summary.overallStatus}** (${summary.passedCount} pass / ${summary.failedCount} fail / ${summary.skippedProbeCount} skipped by probe)`,
  );
  lines.push(`Model source: ${summary.modelSource}`);
  lines.push(`Runs per model: ${summary.config.runsPerModel}`);
  lines.push("");
  lines.push(
    "> Matrix diagnostics **token totals** sum each campaign's gate `campaignTokens` only (when present and > 0). They do **not** include per-snapshot input/output breakdowns from isolated matrix copies; use per-model snapshot `latest.json` for full harness token detail.",
  );
  lines.push("");
  lines.push(renderZaiLiveDiagnosticsMarkdown(summary.diagnostics).trimEnd());
  lines.push("");
  lines.push("## Models");
  lines.push("");
  for (const model of summary.modelsRequested) {
    lines.push(`- ${model}`);
  }
  lines.push("");
  lines.push("## Campaigns");
  lines.push("");
  lines.push("| Model | Run | Status | Grade | Rating | Duration (ms) | Scenarios | Tokens |");
  lines.push("| --- | ---: | --- | --- | --- | ---: | --- | ---: |");
  for (const campaign of summary.campaigns) {
    const scenarios = campaign.gate
      ? `${campaign.gate.scenariosPassed}/${campaign.gate.scenariosTotal}`
      : "n/a";
    const tokens = campaign.gate?.campaignTokens?.toLocaleString() ?? "n/a";
    lines.push(
      `| ${campaign.modelId} | ${campaign.runIndex + 1} | ${campaign.status} | ${campaign.grade} | ${campaign.rating} | ${campaign.durationMs} | ${scenarios} | ${tokens} |`,
    );
  }
  lines.push("");
  lines.push("## Per-model evidence snapshots");
  lines.push("");
  for (const campaign of summary.campaigns) {
    lines.push(
      `- ${campaign.modelId} run ${campaign.runIndex + 1}: \`${campaign.evidenceSnapshotDir}/\` (latest: \`${campaign.reportPointers.latestJson}\`)`,
    );
  }
  lines.push("");
  lines.push("## Report pointers");
  lines.push("");
  lines.push("- `.rector/evidence/live/zai/matrix/matrix-summary.json` (authoritative multi-model rollup)");
  lines.push("- `.rector/evidence/live/zai/latest.json` (shared canonical rollup; last campaign wins)");
  if (summary.probePrefilter?.enabled) {
    lines.push(`- \`${summary.probePrefilter.probeReportPath}\` (optional pre-filter probe)`);
  }
  lines.push("");
  lines.push(
    "> Matrix comparison does **not** update `.rector/evidence/manifest.json`. Run single-model `npm run verify:zai-live` on a finalist for manifest-backed live verification.",
  );
  lines.push("");
  lines.push(
    "> Live verification remains **unverified** until a real non-fake provider passes `evidence:zai-live:gate` with `live_provider` evidence. This matrix report is for operator comparison only.",
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function sharedCanonicalReportPointers(): ZaiMatrixCampaignReportPointers {
  return {
    latestJson: ".rector/evidence/live/zai/latest.json",
    latestMd: ".rector/evidence/live/zai/latest.md",
    providerSmokeJson: ".rector/evidence/live/zai/provider-smoke.json",
    phase2ShadowJson: ".rector/evidence/phase2/live-fact-shadow-report.json",
  };
}

async function readHarnessScorecardPassed(repoRoot: string): Promise<boolean | undefined> {
  try {
    const raw = await fs.readFile(path.join(getZaiLiveEvidenceDir(repoRoot), "latest.json"), "utf8");
    const report = ZaiHarnessReportSchema.parse(JSON.parse(raw));
    return report.scorecard.passed;
  } catch {
    return undefined;
  }
}

function applyMaxModelsCap(models: readonly string[], env: Record<string, string | undefined>): string[] {
  const cap = env.ZAI_MATRIX_MAX_MODELS?.trim();
  if (!cap) return [...models];
  const max = positiveInt(cap, 0);
  if (max <= 0) return [...models];
  return models.slice(0, max);
}

function stringifyEnv(env: Record<string, string | undefined>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) output[key] = value;
  }
  return output;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function truthyEnv(raw: string | undefined): boolean {
  if (!raw?.trim()) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function buildMatrixDiagnostics(campaigns: readonly ZaiMatrixCampaignResult[]): ZaiLiveDiagnostics {
  const matrixStepDurationMs = campaigns.flatMap((campaign) => campaign.steps.map((step) => step.durationMs));
  const campaignDurationMs = campaigns.map((campaign) => campaign.durationMs);
  const campaignTokens = campaigns
    .map((campaign) => campaign.gate?.campaignTokens ?? 0)
    .filter((value) => value > 0);
  const totalTokens = campaignTokens.reduce((sum, value) => sum + value, 0);
  return ZaiLiveDiagnosticsSchema.parse(
    buildZaiLiveDiagnostics({
      matrixStepDurationMs,
      campaignDurationMs,
      tokens: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens,
        modelCalls: 0,
        estimatedCostUsd: 0,
      },
    }),
  );
}

function truncateRedactedTail(stderr: string, maxLen = 400): string {
  const redacted = String(sanitizeHarnessEvidenceValue(stderr));
  if (redacted.length <= maxLen) return redacted;
  return `${redacted.slice(0, maxLen)}…`;
}