import fs from "node:fs/promises";
import path from "node:path";

import {
  getRegoloLiveEvidenceDir,
  SAFE_EVIDENCE_RUN_ID_PATTERN,
  sanitizeEvidenceStringLeaves,
} from "../evidence";
import type { ModelProbeReport } from "./regoloModelProbe";
import { callableModelsFromProbeReport, runRegoloModelProbe } from "./regoloModelProbe";
import { dedupeRegoloModelsPreserveOrder, parseRegoloModelsList } from "./regoloModelsEnv";

import {
  gateRegoloLiveEvidence,
  type GateRegoloLiveEvidenceResult,
  type GateRegoloLiveEvidenceSummary,
} from "./gateRegoloLiveEvidence";
import {
  assertLiveMatrixArtifactHasNoSecrets,
  LIVE_MATRIX_CREDENTIAL_ENV_KEYS,
  listMatrixStepReproEnvKeys,
  sanitizeHarnessEvidenceValue,
} from "./harnessEvidence";
import {
  beginMatrixCampaignSnapshotSession,
  copyMatrixCampaignArtifactsForStep,
  finalizeMatrixCampaignSnapshot,
  getMatrixCampaignSnapshotRelativeDir,
  snapshotMatrixCampaignEvidenceLegacy,
  type MatrixSkippedArtifact,
} from "./liveMatrixCampaignSnapshot";
import { RegoloHarnessReportSchema } from "./regoloHarnessReport";
import {
  buildZaiLiveDiagnostics,
  renderZaiLiveDiagnosticsMarkdown,
  ZaiLiveDiagnosticsSchema,
  type ZaiLiveDiagnostics,
} from "./liveHarnessDiagnostics";

export const REGOLO_MATRIX_SUMMARY_SCHEMA_VERSION = "rector.regolo-live-matrix-summary.v1";

/** @deprecated Prefer {@link LIVE_MATRIX_CREDENTIAL_ENV_KEYS} — kept for importers. */
export const REGOLO_MATRIX_SENSITIVE_ENV_KEYS = LIVE_MATRIX_CREDENTIAL_ENV_KEYS;

export type RegoloMatrixGrade = "A" | "B" | "C" | "D" | "F";

export interface RegoloMatrixCommandInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
}

export interface RegoloMatrixCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export type RegoloMatrixCommandRunner = (input: RegoloMatrixCommandInvocation) => Promise<RegoloMatrixCommandResult>;

export interface RegoloMatrixStepDefinition {
  readonly id: string;
  readonly npmScript: string;
  readonly npmArgs?: readonly string[];
}

export const REGOLO_MATRIX_OFFLINE_STEP: RegoloMatrixStepDefinition = {
  id: "verify:phase2",
  npmScript: "verify:phase2",
};

export const REGOLO_MATRIX_LIVE_CAMPAIGN_STEPS: readonly RegoloMatrixStepDefinition[] = [
  { id: "eval:facts:live", npmScript: "eval:facts:live" },
  { id: "test:live:regolo:provider", npmScript: "test:live:regolo:provider" },
  { id: "test:live:regolo:harness", npmScript: "test:live:regolo:harness" },
  {
    id: "evidence:regolo-live:gate",
    npmScript: "evidence:regolo-live:gate",
    npmArgs: ["--no-manifest-update"],
  },
];

export interface RegoloMatrixConfig {
  readonly runsPerModel: number;
  readonly maxModels?: number;
  readonly skipOffline: boolean;
  readonly continueOnFailure: boolean;
  readonly prefilterWithProbe: boolean;
  readonly probeJsonCapability: boolean;
}

export interface RegoloMatrixStepLogEntry {
  readonly stepId: string;
  readonly command: string;
  readonly envKeys: readonly string[];
  readonly exitCode: number;
  readonly durationMs: number;
  readonly stderrTail?: string;
}

export interface RegoloMatrixCampaignReportPointers {
  readonly latestJson: string;
  readonly latestMd: string;
  readonly providerSmokeJson: string;
  readonly phase2ShadowJson: string;
}

export interface RegoloMatrixCampaignResult {
  readonly modelId: string;
  readonly safeModelId: string;
  readonly runIndex: number;
  readonly status: "pass" | "fail" | "skipped_probe";
  readonly durationMs: number;
  readonly steps: readonly RegoloMatrixStepLogEntry[];
  readonly gate?: GateRegoloLiveEvidenceSummary;
  readonly gateViolations?: readonly string[];
  readonly grade: RegoloMatrixGrade;
  readonly rating: string;
  readonly evidenceSnapshotDir: string;
  readonly reportPointers: RegoloMatrixCampaignReportPointers;
  readonly snapshotCopiedFiles?: readonly string[];
  readonly snapshotSkippedArtifacts?: readonly MatrixSkippedArtifact[];
  readonly probePrefilterSkipped?: boolean;
}

export interface RegoloMatrixProbePrefilterSummary {
  readonly enabled: boolean;
  readonly modelsSkipped: readonly string[];
  readonly probeReportPath: string;
  readonly rows: ModelProbeReport["rows"];
}

export interface RegoloMatrixSummary {
  readonly schemaVersion: typeof REGOLO_MATRIX_SUMMARY_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly repoRoot: string;
  readonly modelSource: "REGOLO_MODELS" | "REGOLO_MODEL";
  readonly config: RegoloMatrixConfig;
  readonly modelsRequested: readonly string[];
  readonly modelsExecuted: readonly string[];
  readonly campaigns: readonly RegoloMatrixCampaignResult[];
  readonly overallStatus: "pass" | "fail" | "partial";
  readonly passedCount: number;
  readonly failedCount: number;
  readonly skippedProbeCount: number;
  readonly probePrefilter?: RegoloMatrixProbePrefilterSummary;
  readonly diagnostics: ZaiLiveDiagnostics;
}

export function getRegoloLiveMatrixEvidenceDir(repoRoot?: string): string {
  return path.join(getRegoloLiveEvidenceDir(repoRoot), "matrix");
}

export function getRegoloMatrixCampaignSnapshotRelativeDir(safeModelId: string, runIndex: number): string {
  return getMatrixCampaignSnapshotRelativeDir("regolo", safeModelId, runIndex);
}

export async function snapshotRegoloMatrixCampaignEvidence(input: {
  readonly repoRoot: string;
  readonly safeModelId: string;
  readonly runIndex: number;
  readonly modelId?: string;
}): Promise<{
  readonly evidenceSnapshotDir: string;
  readonly reportPointers: RegoloMatrixCampaignReportPointers;
  readonly copiedFiles: readonly string[];
  readonly skippedArtifacts: readonly MatrixSkippedArtifact[];
}> {
  const snapshot = await snapshotMatrixCampaignEvidenceLegacy({
    track: "regolo",
    repoRoot: input.repoRoot,
    safeModelId: input.safeModelId,
    runIndex: input.runIndex,
    modelId: input.modelId ?? input.safeModelId,
  });
  return {
    evidenceSnapshotDir: snapshot.evidenceSnapshotDir,
    reportPointers: snapshot.reportPointers,
    copiedFiles: snapshot.copiedFiles,
    skippedArtifacts: snapshot.skippedArtifacts,
  };
}

export { dedupeRegoloModelsPreserveOrder, parseRegoloModelsList } from "./regoloModelsEnv";

export function toSafeModelEvidenceId(modelId: string): string {
  const trimmed = modelId.trim();
  if (!trimmed) {
    throw new Error("Regolo live matrix model id must not be empty.");
  }
  let sanitized = trimmed.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  if (!sanitized || sanitized === "." || sanitized === "..") {
    throw new Error(`Regolo live matrix model id cannot be converted to a safe evidence segment: ${modelId}`);
  }
  if (!/^[A-Za-z0-9]/.test(sanitized)) {
    sanitized = `m_${sanitized}`;
  }
  if (!SAFE_EVIDENCE_RUN_ID_PATTERN.test(sanitized)) {
    throw new Error(`Regolo live matrix model id is not a safe evidence segment after sanitization: ${modelId}`);
  }
  return sanitized;
}

export function resolveRegoloMatrixConfig(env: Record<string, string | undefined> = process.env): RegoloMatrixConfig {
  const runsPerModel = positiveInt(env.REGOLO_MATRIX_RUNS_PER_MODEL, 1);
  const maxModelsRaw = env.REGOLO_MATRIX_MAX_MODELS?.trim();
  const maxModels = maxModelsRaw ? positiveInt(maxModelsRaw, 0) : undefined;
  const skipOffline = truthyEnv(env.REGOLO_MATRIX_SKIP_OFFLINE);
  const continueOnFailure = env.REGOLO_MATRIX_CONTINUE_ON_FAILURE === undefined
    ? true
    : truthyEnv(env.REGOLO_MATRIX_CONTINUE_ON_FAILURE);
  const prefilterWithProbe = truthyEnv(env.REGOLO_MATRIX_PREFILTER_PROBE);
  const probeJsonCapability = truthyEnv(env.REGOLO_MATRIX_PROBE_JSON) || truthyEnv(env.REGOLO_MODEL_PROBE_JSON);
  return {
    runsPerModel: Math.max(1, runsPerModel),
    ...(maxModels !== undefined && maxModels > 0 ? { maxModels } : {}),
    skipOffline,
    continueOnFailure,
    prefilterWithProbe,
    probeJsonCapability,
  };
}

export function resolveRegoloMatrixModels(env: Record<string, string | undefined> = process.env): {
  readonly models: readonly string[];
  readonly source: "REGOLO_MODELS" | "REGOLO_MODEL" | "empty";
} {
  const fromList = dedupeRegoloModelsPreserveOrder(parseRegoloModelsList(env.REGOLO_MODELS));
  if (fromList.length > 0) {
    return { models: applyMaxModelsCap(fromList, env), source: "REGOLO_MODELS" };
  }
  const single = env.REGOLO_MODEL?.trim();
  if (single) {
    return { models: [single], source: "REGOLO_MODEL" };
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
  output.REGOLO_MODEL = modelId;
  output.RECTOR_LIVE_PROVIDER = "regolo";
  return output;
}

export function buildStepCommandLog(
  step: RegoloMatrixStepDefinition,
  result: RegoloMatrixCommandResult,
  env: Record<string, string>,
): RegoloMatrixStepLogEntry {
  const args = step.npmArgs?.length ? ["--", ...step.npmArgs] : [];
  const command = `npm run ${step.npmScript}${args.length ? ` ${args.join(" ")}` : ""}`;
  return sanitizeEvidenceStringLeaves({
    stepId: step.id,
    command,
    envKeys: listMatrixStepReproEnvKeys(env),
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    ...(result.stderr.trim()
      ? { stderrTail: truncateRedactedTail(result.stderr) }
      : {}),
  });
}

export function deriveRegoloModelCampaignRating(input: {
  readonly gateOk: boolean;
  readonly gateSummary?: GateRegoloLiveEvidenceSummary;
  readonly scorecardPassed?: boolean;
}): { readonly grade: RegoloMatrixGrade; readonly rating: string } {
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
  assertLiveMatrixArtifactHasNoSecrets(value, { artifactLabel: "Regolo live matrix" });
}

export async function runRegoloModelMatrix(options: {
  readonly repoRoot: string;
  readonly env?: Record<string, string | undefined>;
  readonly config?: RegoloMatrixConfig;
  readonly models?: readonly string[];
  readonly modelSource?: "REGOLO_MODELS" | "REGOLO_MODEL";
  readonly runCommand: RegoloMatrixCommandRunner;
  readonly now?: () => Date;
  readonly gateEvaluator?: (input: { repoRoot: string }) => Promise<GateRegoloLiveEvidenceResult>;
  readonly probeRunner?: (input: {
    readonly models: readonly string[];
    readonly env: Record<string, string | undefined>;
    readonly config: RegoloMatrixConfig;
    readonly repoRoot: string;
  }) => Promise<ModelProbeReport>;
  readonly snapshotCampaignEvidence?: (input: {
    readonly repoRoot: string;
    readonly safeModelId: string;
    readonly runIndex: number;
  }) => ReturnType<typeof snapshotRegoloMatrixCampaignEvidence>;
}): Promise<RegoloMatrixSummary> {
  const repoRoot = path.resolve(options.repoRoot);
  const env = options.env ?? process.env;
  const config = options.config ?? resolveRegoloMatrixConfig(env);
  const resolved = options.models
    ? {
        models: [...options.models],
        source: options.modelSource ?? ("REGOLO_MODELS" as const),
      }
    : resolveRegoloMatrixModels(env);
  if (resolved.models.length === 0 || resolved.source === "empty") {
    throw new Error("Regolo live matrix requires REGOLO_MODELS or REGOLO_MODEL to be set.");
  }

  const gateEvaluator = options.gateEvaluator ?? ((input) =>
    gateRegoloLiveEvidence({
      repoRoot: input.repoRoot,
      updateManifestOnPass: false,
      requireCampaignTracks: true,
    }));

  const generatedAt = (options.now?.() ?? new Date()).toISOString();
  const campaigns: RegoloMatrixCampaignResult[] = [];
  let offlineFailed = false;
  const snapshotCampaignEvidence = options.snapshotCampaignEvidence ?? snapshotRegoloMatrixCampaignEvidence;
  const probeRunner = options.probeRunner ?? ((input) =>
    runRegoloModelProbe({
      env: input.env,
      models: [...input.models],
      repoRoot: input.repoRoot,
      write: true,
      probeJsonCapability: input.config.probeJsonCapability,
    }));

  let probePrefilter: RegoloMatrixProbePrefilterSummary | undefined;
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
      probeReportPath: ".rector/evidence/live/regolo/model-probe/latest.json",
      rows: probeReport.rows,
    };
    if (modelsToRun.length === 0 && !config.continueOnFailure) {
      throw new Error("Regolo live matrix probe pre-filter found no callable models.");
    }
  }

  if (!config.skipOffline) {
    const offlineResult = await options.runCommand({
      command: "npm",
      args: ["run", REGOLO_MATRIX_OFFLINE_STEP.npmScript],
      cwd: repoRoot,
      env: stringifyEnv(env),
    });
    if (offlineResult.exitCode !== 0) {
      offlineFailed = true;
      if (!config.continueOnFailure) {
        throw new Error(
          `Regolo live matrix offline step ${REGOLO_MATRIX_OFFLINE_STEP.id} failed with exit ${offlineResult.exitCode}.`,
        );
      }
    }
  }

  for (const modelId of resolved.models) {
    if (skippedByProbe.has(modelId)) {
      const safeModelId = toSafeModelEvidenceId(modelId);
      for (let runIndex = 0; runIndex < config.runsPerModel; runIndex += 1) {
        const evidenceSnapshotDir = getRegoloMatrixCampaignSnapshotRelativeDir(safeModelId, runIndex);
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
      const steps: RegoloMatrixStepLogEntry[] = [];
      let campaignFailed = offlineFailed;
      const snapshotSession = await beginMatrixCampaignSnapshotSession({
        track: "regolo",
        repoRoot,
        safeModelId,
        runIndex,
        modelId,
      });

      for (const step of REGOLO_MATRIX_LIVE_CAMPAIGN_STEPS) {
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
        if (result.exitCode === 0) {
          await copyMatrixCampaignArtifactsForStep(snapshotSession, step.id);
        }
        if (result.exitCode !== 0) {
          campaignFailed = true;
          break;
        }
      }

      let gateResult: GateRegoloLiveEvidenceResult | undefined;
      let scorecardPassed: boolean | undefined;
      if (!campaignFailed) {
        gateResult = await gateEvaluator({ repoRoot });
        scorecardPassed = await readHarnessScorecardPassed(repoRoot);
        if (!gateResult.ok) {
          campaignFailed = true;
        }
      }

      const { grade, rating } = deriveRegoloModelCampaignRating({
        gateOk: gateResult?.ok ?? false,
        gateSummary: gateResult?.summary,
        scorecardPassed,
      });

      const snapshot = options.snapshotCampaignEvidence
        ? await snapshotCampaignEvidence({ repoRoot, safeModelId, runIndex })
        : await finalizeMatrixCampaignSnapshot(snapshotSession);

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
        ...("copiedFiles" in snapshot && snapshot.copiedFiles.length > 0
          ? { snapshotCopiedFiles: snapshot.copiedFiles }
          : {}),
        ...("skippedArtifacts" in snapshot && snapshot.skippedArtifacts.length > 0
          ? { snapshotSkippedArtifacts: snapshot.skippedArtifacts }
          : {}),
      });

      if (campaignFailed && !config.continueOnFailure) {
        break modelLoop;
      }
    }
  }

  const passedCount = campaigns.filter((c) => c.status === "pass").length;
  const failedCount = campaigns.filter((c) => c.status === "fail").length;
  const skippedProbeCount = campaigns.filter((c) => c.status === "skipped_probe").length;
  const overallStatus: RegoloMatrixSummary["overallStatus"] = failedCount === 0 && skippedProbeCount === 0
    ? "pass"
    : passedCount === 0
      ? "fail"
      : "partial";

  const summary: RegoloMatrixSummary = {
    schemaVersion: REGOLO_MATRIX_SUMMARY_SCHEMA_VERSION,
    generatedAt,
    repoRoot: ".",
    modelSource: resolved.source,
    config,
    modelsRequested: [...resolved.models],
    modelsExecuted: dedupeRegoloModelsPreserveOrder(
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

export async function writeRegoloMatrixSummary(
  summary: RegoloMatrixSummary,
  options: { readonly repoRoot: string },
): Promise<{ readonly jsonPath: string; readonly markdownPath: string }> {
  const sanitized = sanitizeEvidenceStringLeaves(summary);
  assertMatrixArtifactHasNoSecrets(sanitized);
  const matrixDir = getRegoloLiveMatrixEvidenceDir(options.repoRoot);
  await fs.mkdir(matrixDir, { recursive: true });
  const jsonPath = path.join(matrixDir, "matrix-summary.json");
  const markdownPath = path.join(matrixDir, "matrix-summary.md");
  await fs.writeFile(jsonPath, `${JSON.stringify(sanitized, null, 2)}\n`, "utf8");
  await fs.writeFile(markdownPath, formatRegoloMatrixSummaryMarkdown(sanitized), "utf8");
  return { jsonPath, markdownPath };
}

export function formatRegoloMatrixSummaryMarkdown(summary: RegoloMatrixSummary): string {
  const lines: string[] = [];
  lines.push("# Regolo live model matrix summary");
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
  lines.push(
    "> Snapshots are copied **incrementally after each successful live step** into isolated matrix directories. `latest.json` / `provider-smoke.json` are only copied when their embedded `modelId` matches the campaign model (stale shared rollups are skipped).",
  );
  lines.push("");
  for (const campaign of summary.campaigns) {
    const skipped = campaign.snapshotSkippedArtifacts?.length
      ? ` (skipped: ${campaign.snapshotSkippedArtifacts.map((entry) => entry.destName).join(", ")})`
      : "";
    lines.push(
      `- ${campaign.modelId} run ${campaign.runIndex + 1}: \`${campaign.evidenceSnapshotDir}/\` (latest: \`${campaign.reportPointers.latestJson}\`)${skipped}`,
    );
  }
  lines.push("");
  lines.push("## Report pointers");
  lines.push("");
  lines.push("- `.rector/evidence/live/regolo/matrix/matrix-summary.json` (authoritative multi-model rollup)");
  lines.push("- `.rector/evidence/live/regolo/latest.json` (shared canonical rollup; last campaign wins)");
  if (summary.probePrefilter?.enabled) {
    lines.push(`- \`${summary.probePrefilter.probeReportPath}\` (optional pre-filter probe)`);
  }
  lines.push("");
  lines.push(
    "> Matrix comparison does **not** update `.rector/evidence/manifest.json`. Run single-model `npm run verify:regolo-live` on a finalist for manifest-backed live verification.",
  );
  lines.push("");
  lines.push(
    "> Live verification remains **unverified** until a real non-fake provider passes `evidence:regolo-live:gate` with `live_provider` evidence. This matrix report is for operator comparison only.",
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function sharedCanonicalReportPointers(): RegoloMatrixCampaignReportPointers {
  return {
    latestJson: ".rector/evidence/live/regolo/latest.json",
    latestMd: ".rector/evidence/live/regolo/latest.md",
    providerSmokeJson: ".rector/evidence/live/regolo/provider-smoke.json",
    phase2ShadowJson: ".rector/evidence/phase2/live-fact-shadow-report.json",
  };
}

async function readHarnessScorecardPassed(repoRoot: string): Promise<boolean | undefined> {
  try {
    const raw = await fs.readFile(path.join(getRegoloLiveEvidenceDir(repoRoot), "latest.json"), "utf8");
    const report = RegoloHarnessReportSchema.parse(JSON.parse(raw));
    return report.scorecard.passed;
  } catch {
    return undefined;
  }
}

function applyMaxModelsCap(models: readonly string[], env: Record<string, string | undefined>): string[] {
  const cap = env.REGOLO_MATRIX_MAX_MODELS?.trim();
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

export function buildMatrixDiagnostics(campaigns: readonly RegoloMatrixCampaignResult[]): ZaiLiveDiagnostics {
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