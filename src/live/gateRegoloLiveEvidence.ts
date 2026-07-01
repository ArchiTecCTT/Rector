import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  DEFAULT_ZAI_CAMPAIGN_TOKEN_LIMIT,
  aggregateCampaignBudget,
  buildEvidenceManifest,
  getEvidenceRoot,
  getEvidenceTrackDir,
  getRegoloLiveEvidenceDir,
  getRegoloLiveRunEvidenceDir,
  type CampaignBudgetUsage,
} from "../evidence";
import { ZAI_HARNESS_FAILURE_KINDS, ZAI_HARNESS_SCORECARD_SCHEMA_VERSION } from "./harnessScorecard";
import { secretLeakFindings } from "./harnessEvidence";
import { isAcceptableLiveEvidenceProvider, isRegoloCompatibleHost } from "./liveProviderDiscovery";
import { REGOLO_HARNESS_REPORT_SCHEMA_VERSION, RegoloHarnessReportSchema, type RegoloHarnessReport } from "./regoloHarnessReport";
import { RegoloProviderSmokeReportSchema } from "./regoloProviderSmokeReport";

const LATEST_JSON = "latest.json";
const LATEST_MD = "latest.md";
const PROVIDER_SMOKE_JSON = "provider-smoke.json";
const PHASE2_SHADOW_JSON = "live-fact-shadow-report.json";
const PHASE2_SHADOW_SUMMARY_JSON = "live-fact-shadow-summary.json";
const MANIFEST_JSON = "manifest.json";

/** Maximum spread between campaign track timestamps for a correlated live verification run. */
export const DEFAULT_REGOLO_CAMPAIGN_FRESHNESS_WINDOW_MS = 30 * 60 * 1000;

const REDACTED_PROMPTS_SCHEMA_VERSION = "rector.regolo-harness-redacted-prompts.v1";
const REDACTED_OUTPUTS_SCHEMA_VERSION = "rector.regolo-harness-redacted-model-outputs.v1";

export const REGOLO_LIVE_RUN_ARTIFACT_FILES = [
  "harness-report.json",
  "harness-report.md",
  "run-events.jsonl",
  "fact-ledger.jsonl",
  "provider-calls.json",
  "token-usage.json",
  "cost-report.json",
  "redacted-prompts.json",
  "redacted-model-outputs.json",
  "workspace-before-manifest.json",
  "workspace-after-manifest.json",
  "scorecard.json",
  "scorecard.md",
] as const;

const LiveFactShadowSummarySchema = z
  .object({
    generatedAt: z.string().datetime(),
    totalTokenUsage: z.object({
      modelCalls: z.number().int().nonnegative(),
      totalTokens: z.number().int().nonnegative(),
    }),
    liveEvidenceStatus: z.enum(["live_provider", "test_only_injected", "skipped"]),
    status: z.enum(["completed", "skipped"]),
    failedCount: z.number().int().nonnegative(),
  })
  .passthrough();

const LiveFactShadowGateSchema = z
  .object({
    generatedAt: z.string().datetime(),
    status: z.enum(["completed", "skipped"]),
    liveEvidenceStatus: z.enum(["live_provider", "test_only_injected", "skipped"]),
    providerId: z.string().nullable(),
    failedCount: z.number().int().nonnegative(),
    cases: z.array(
      z.object({
        status: z.enum(["passed", "failed", "skipped"]),
        failureReasons: z.array(z.string()),
      }),
    ),
  })
  .passthrough();

export interface GateRegoloLiveEvidenceOptions {
  readonly repoRoot?: string;
  readonly requireCampaignTracks?: boolean;
  readonly updateManifestOnPass?: boolean;
  readonly campaignFreshnessWindowMs?: number;
  readonly now?: () => Date;
}

export interface GateRegoloLiveEvidenceInvocation {
  readonly requireCampaignTracks: boolean;
  readonly updateManifestOnPass: boolean;
  readonly harnessOnlyDiagnostic: boolean;
}

export function resolveGateRegoloLiveEvidenceInvocation(options: {
  readonly harnessOnly?: boolean;
  readonly noManifestUpdate?: boolean;
} = {}): GateRegoloLiveEvidenceInvocation {
  const harnessOnly = options.harnessOnly ?? false;
  return {
    requireCampaignTracks: !harnessOnly,
    updateManifestOnPass: !harnessOnly && !(options.noManifestUpdate ?? false),
    harnessOnlyDiagnostic: harnessOnly,
  };
}

export interface GateRegoloLiveEvidenceResult {
  readonly ok: boolean;
  readonly violations: readonly string[];
  readonly summary: GateRegoloLiveEvidenceSummary;
}

export interface GateRegoloLiveEvidenceSummary {
  readonly providerId: string | null;
  readonly adapterId: string | null;
  readonly modelId: string | null;
  readonly host: string | null;
  readonly harnessStatus: string | null;
  readonly scenariosPassed: number;
  readonly scenariosTotal: number;
  readonly campaignTokens: number;
  readonly campaignTokenLimit: number;
  readonly campaignModelCalls: number;
  readonly estimatedCostUsd: number;
  readonly latestMarkdown: string;
  readonly manifestUpdated: boolean;
}

export async function gateRegoloLiveEvidence(
  options: GateRegoloLiveEvidenceOptions = {},
): Promise<GateRegoloLiveEvidenceResult> {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const requireCampaignTracks = options.requireCampaignTracks ?? true;
  const updateManifestOnPass = options.updateManifestOnPass ?? true;
  const regoloDir = getRegoloLiveEvidenceDir(repoRoot);
  const violations: string[] = [];
  const scannedBodies: unknown[] = [];

  let latest: RegoloHarnessReport | undefined;
  try {
    const rawLatest = await fs.readFile(path.join(regoloDir, LATEST_JSON), "utf8");
    scannedBodies.push(rawLatest);
    latest = RegoloHarnessReportSchema.parse(JSON.parse(rawLatest));
  } catch (error) {
    violations.push(`missing or invalid ${LATEST_JSON}: ${errorMessage(error)}`);
  }

  let providerSmoke: z.infer<typeof RegoloProviderSmokeReportSchema> | undefined;
  let phase2Report: z.infer<typeof LiveFactShadowGateSchema> | undefined;
  let phase2Summary: z.infer<typeof LiveFactShadowSummarySchema> | undefined;

  if (requireCampaignTracks) {
    providerSmoke = await readProviderSmoke(regoloDir, violations, scannedBodies);
    phase2Report = await readPhase2Shadow(repoRoot, violations, scannedBodies);
    phase2Summary = await readPhase2Summary(repoRoot, violations, scannedBodies);
  }

  if (latest) {
    validateHarnessReport(latest, violations);
    await validateRunArtifacts(repoRoot, regoloDir, latest, violations, scannedBodies);
  }

  if (requireCampaignTracks) {
    validateProviderSmokeTrack(providerSmoke, violations);
    validatePhase2Track(phase2Report, violations);
    validatePhase2SummaryTrack(phase2Report, phase2Summary, violations);
    validateCampaignTrackFreshness(
      {
        harnessGeneratedAt: latest?.generatedAt,
        providerSmokeGeneratedAt: providerSmoke?.generatedAt,
        phase2ReportGeneratedAt: phase2Report?.generatedAt,
        phase2SummaryGeneratedAt: phase2Summary?.generatedAt,
      },
      options.campaignFreshnessWindowMs ?? DEFAULT_REGOLO_CAMPAIGN_FRESHNESS_WINDOW_MS,
      violations,
    );
  }

  const campaignUsage = buildCampaignUsage(latest, providerSmoke, phase2Summary);
  const campaignRollup = aggregateCampaignBudget(campaignUsage, {
    generatedAt: latest?.generatedAt,
    limits: { maxTotalTokens: DEFAULT_ZAI_CAMPAIGN_TOKEN_LIMIT },
  });
  scannedBodies.push(campaignRollup);

  if (campaignRollup.total.modelCalls <= 0) {
    violations.push("campaign modelCalls must be greater than zero");
  }
  if (!campaignRollup.withinTokenBudget) {
    violations.push(
      `campaign totalTokens ${campaignRollup.total.totalTokens} exceeds limit ${campaignRollup.limits.maxTotalTokens}`,
    );
  }

  const secretFindings = scannedBodies.flatMap((body) => secretLeakFindings(body));
  if (secretFindings.length > 0) {
    violations.push(`secret-like values detected in evidence (${secretFindings.length} finding(s))`);
  }

  const ok = violations.length === 0;
  let manifestUpdated = false;
  if (ok && updateManifestOnPass) {
    manifestUpdated = await tryUpdateManifest(repoRoot, {
      liveEvidenceStatus: "live_provider",
      campaignRollup,
      now: options.now,
    });
  }

  const summary: GateRegoloLiveEvidenceSummary = {
    providerId: latest?.providerId ?? null,
    adapterId: latest?.adapterId ?? null,
    modelId: latest?.modelId ?? null,
    host: latest?.host ?? null,
    harnessStatus: latest?.status ?? null,
    scenariosPassed: latest?.passedCount ?? 0,
    scenariosTotal: latest?.scenarioCount ?? 0,
    campaignTokens: campaignRollup.total.totalTokens,
    campaignTokenLimit: campaignRollup.limits.maxTotalTokens,
    campaignModelCalls: campaignRollup.total.modelCalls,
    estimatedCostUsd: campaignRollup.total.estimatedCostUsd,
    latestMarkdown: path.join(".rector", "evidence", "live", "regolo", LATEST_MD),
    manifestUpdated,
  };

  return { ok, violations, summary };
}

export function formatGateRegoloLiveEvidenceResult(result: GateRegoloLiveEvidenceResult): string {
  const lines: string[] = [];
  lines.push(result.ok ? "Z.ai live verification: PASS" : "Z.ai live verification: FAIL");
  if (result.summary.providerId) {
    lines.push(`provider: ${result.summary.adapterId ?? "n/a"} / Z.ai (${result.summary.providerId})`);
  }
  if (result.summary.modelId) lines.push(`model: ${result.summary.modelId}`);
  lines.push(`scenarios: ${result.summary.scenariosPassed}/${result.summary.scenariosTotal} pass`);
  lines.push(
    `tokens: ${result.summary.campaignTokens.toLocaleString()} / ${result.summary.campaignTokenLimit.toLocaleString()}`,
  );
  lines.push(`cost: $${result.summary.estimatedCostUsd.toFixed(4)}`);
  lines.push(`report: ${result.summary.latestMarkdown}`);
  if (result.summary.manifestUpdated) lines.push("manifest: updated");
  if (!result.ok) {
    lines.push("violations:");
    for (const violation of result.violations) lines.push(`- ${violation}`);
  }
  return `${lines.join("\n")}\n`;
}

function validateHarnessReport(report: RegoloHarnessReport, violations: string[]): void {
  if (report.liveEvidenceStatus !== "live_provider") {
    violations.push(`liveEvidenceStatus must be live_provider (got ${report.liveEvidenceStatus})`);
  }
  if (report.status !== "passed") {
    violations.push(`harness status must be passed (got ${report.status})`);
  }
  validateProviderIdentity(
    {
      providerId: report.providerId ?? undefined,
      adapterId: report.adapterId ?? undefined,
      host: report.host ?? undefined,
    },
    violations,
    "harness",
  );
  if (!report.scorecard.passed) {
    violations.push("harness scorecard.passed must be true");
  }
  if (report.scorecard.schemaVersion !== ZAI_HARNESS_SCORECARD_SCHEMA_VERSION) {
    violations.push("harness scorecard schema is missing or invalid");
  }

  const readOnlyKinds = new Set([
    "read_only_repository_inspection",
    "plan_only_improvement",
    "forbidden_mutation_safety",
  ]);
  for (const scenario of report.scenarios) {
    if (scenario.status !== "skipped" && scenario.status !== "passed") {
      violations.push(`scenario ${scenario.scenarioId} must pass (got ${scenario.status})`);
    }
    if (readOnlyKinds.has(scenario.kind) && scenario.workspaceMutation.mutationDetected) {
      violations.push(`read-only/plan-only/safety scenario ${scenario.scenarioId} mutated source files`);
    }
    for (const failure of scenario.failures) {
      if (failure.kind === "unknown") {
        violations.push(`scenario ${scenario.scenarioId} has unclassified (unknown) failure`);
      }
    }
  }

  for (const failure of report.failures) {
    if (failure.kind === "unknown") {
      violations.push("harness report has unclassified (unknown) failure");
    }
    if (failure.kind === "provider_config" && report.status === "passed") {
      violations.push("provider config failure recorded while harness status is passed");
    }
  }

  if (report.status === "passed" && report.failures.length > 0) {
    violations.push("harness failures present while status is passed");
  }
}

async function validateRunArtifacts(
  repoRoot: string,
  regoloDir: string,
  report: RegoloHarnessReport,
  violations: string[],
  scannedBodies: unknown[],
): Promise<void> {
  let runDir: string;
  try {
    runDir = getRegoloLiveRunEvidenceDir(report.runId, repoRoot);
  } catch (error) {
    violations.push(`invalid harness runId: ${errorMessage(error)}`);
    return;
  }
  const regoloRoot = path.resolve(regoloDir);
  if (!isResolvedPathInsideDirectory(runDir, regoloRoot)) {
    violations.push("harness runId resolves outside live/regolo evidence directory");
    return;
  }
  for (const name of REGOLO_LIVE_RUN_ARTIFACT_FILES) {
    const filePath = path.join(runDir, name);
    try {
      const content = await fs.readFile(filePath, "utf8");
      scannedBodies.push(content);
      if (content.trim().length === 0) {
        violations.push(`required artifact is empty: runs/${report.runId}/${name}`);
      }
    } catch {
      violations.push(`missing required artifact: runs/${report.runId}/${name}`);
    }
  }

  const promptsPath = path.join(runDir, "redacted-prompts.json");
  const outputsPath = path.join(runDir, "redacted-model-outputs.json");
  try {
    const prompts = JSON.parse(await fs.readFile(promptsPath, "utf8")) as { prompts?: unknown[]; schemaVersion?: string };
    if (!Array.isArray(prompts.prompts) || prompts.prompts.length === 0) {
      violations.push("redacted-prompts.json must include at least one prompt for executed harness scenarios");
    }
    if (prompts.schemaVersion !== REDACTED_PROMPTS_SCHEMA_VERSION) {
      violations.push("redacted-prompts.json schemaVersion is missing or invalid");
    }
  } catch {
    // missing file already recorded
  }
  try {
    const outputs = JSON.parse(await fs.readFile(outputsPath, "utf8")) as { outputs?: unknown[]; schemaVersion?: string };
    if (!Array.isArray(outputs.outputs) || outputs.outputs.length === 0) {
      violations.push("redacted-model-outputs.json must include at least one model output for executed harness scenarios");
    }
    if (outputs.schemaVersion !== REDACTED_OUTPUTS_SCHEMA_VERSION) {
      violations.push("redacted-model-outputs.json schemaVersion is missing or invalid");
    }
  } catch {
    // missing file already recorded
  }

  for (const [key, relative] of Object.entries(report.artifacts)) {
    const resolved = path.resolve(regoloDir, relative);
    if (!isResolvedPathInsideDirectory(resolved, regoloRoot)) {
      violations.push(`artifact pointer ${key} escapes live/regolo evidence directory`);
      continue;
    }
    if (!(await fileExists(resolved))) {
      violations.push(`artifact pointer ${key} missing at ${relative}`);
    }
  }
}

function validateProviderIdentity(
  identity: { providerId?: string | null; adapterId?: string | null; host?: string | null },
  violations: string[],
  label: string,
  options: { requireOpenAiAdapterAndRegoloHost?: boolean } = {},
): void {
  const requireAdapterAndHost = options.requireOpenAiAdapterAndRegoloHost ?? true;
  const providerId = identity.providerId?.trim();
  if (!providerId) {
    violations.push(`${label} providerId is required for live evidence`);
  } else if (!isAcceptableLiveEvidenceProvider({ providerId })) {
    violations.push(`${label} provider is fake/deterministic/spy/mock/fixture/scripted/test-double`);
  }

  if (!requireAdapterAndHost) return;

  const adapterId = identity.adapterId?.trim();
  if (!adapterId) {
    violations.push(`${label} adapterId is required for live evidence`);
  } else if (adapterId !== "openai-compatible") {
    violations.push(`${label} adapter must be openai-compatible for Z.ai live evidence (got ${adapterId})`);
  }

  const host = identity.host?.trim();
  if (!host) {
    violations.push(`${label} host is required for live evidence`);
  } else if (!isRegoloCompatibleHost(host)) {
    violations.push(`${label} host is not an intended Z.ai OpenAI-compatible route (${host})`);
  }
}

function validateProviderSmokeTrack(
  report: z.infer<typeof RegoloProviderSmokeReportSchema> | undefined,
  violations: string[],
): void {
  if (!report) return;
  if (report.liveEvidenceStatus !== "live_provider") {
    violations.push(`provider-smoke liveEvidenceStatus must be live_provider (got ${report.liveEvidenceStatus})`);
  }
  if (report.status !== "passed") {
    violations.push(`provider-smoke status must be passed (got ${report.status})`);
  }
  if (report.error) {
    violations.push("provider-smoke records provider error while status claims success");
  }
  validateProviderIdentity(
    {
      providerId: report.providerId ?? undefined,
      adapterId: report.adapterId ?? undefined,
      host: report.host ?? undefined,
    },
    violations,
    "provider-smoke",
  );
  if (report.tokenUsage.modelCalls <= 0) {
    violations.push("provider-smoke modelCalls must be greater than zero");
  }
}

function validatePhase2Track(
  report: z.infer<typeof LiveFactShadowGateSchema> | undefined,
  violations: string[],
): void {
  if (!report) return;
  if (report.liveEvidenceStatus !== "live_provider") {
    violations.push(`phase2 live fact shadow liveEvidenceStatus must be live_provider (got ${report.liveEvidenceStatus})`);
  }
  if (report.status !== "completed") {
    violations.push(`phase2 live fact shadow status must be completed (got ${report.status})`);
  }
  if (report.failedCount > 0) {
    violations.push(`phase2 live fact shadow failedCount must be 0 (got ${report.failedCount})`);
  }
  validateProviderIdentity(
    { providerId: report.providerId },
    violations,
    "phase2f",
    { requireOpenAiAdapterAndRegoloHost: false },
  );
  for (const caseReport of report.cases) {
    if (caseReport.status === "failed") {
      violations.push("phase2 live fact shadow includes failed case while report claims success");
    }
    for (const reason of caseReport.failureReasons) {
      if (/unknown_failure/i.test(reason)) {
        violations.push(`phase2 case has unclassified failure: ${reason}`);
      }
    }
  }
}

function validatePhase2SummaryTrack(
  report: z.infer<typeof LiveFactShadowGateSchema> | undefined,
  summary: z.infer<typeof LiveFactShadowSummarySchema> | undefined,
  violations: string[],
): void {
  if (!report || !summary) return;
  if (summary.liveEvidenceStatus !== "live_provider") {
    violations.push(
      `phase2 live-fact-shadow-summary liveEvidenceStatus must be live_provider (got ${summary.liveEvidenceStatus})`,
    );
  }
  if (summary.status !== "completed") {
    violations.push(`phase2 live-fact-shadow-summary status must be completed (got ${summary.status})`);
  }
  if (summary.failedCount > 0) {
    violations.push(`phase2 live-fact-shadow-summary failedCount must be 0 (got ${summary.failedCount})`);
  }
  if (summary.liveEvidenceStatus !== report.liveEvidenceStatus) {
    violations.push("phase2 live-fact-shadow-summary liveEvidenceStatus does not match live-fact-shadow-report.json");
  }
  if (summary.status !== report.status) {
    violations.push("phase2 live-fact-shadow-summary status does not match live-fact-shadow-report.json");
  }
  if (summary.failedCount !== report.failedCount) {
    violations.push("phase2 live-fact-shadow-summary failedCount does not match live-fact-shadow-report.json");
  }
  if (summary.generatedAt !== report.generatedAt) {
    violations.push("phase2 live-fact-shadow-summary generatedAt does not match live-fact-shadow-report.json");
  }
  if (summary.totalTokenUsage.modelCalls <= 0) {
    violations.push("phase2 live-fact-shadow-summary modelCalls must be greater than zero");
  }
}

function buildCampaignUsage(
  latest: RegoloHarnessReport | undefined,
  providerSmoke: z.infer<typeof RegoloProviderSmokeReportSchema> | undefined,
  phase2Summary: z.infer<typeof LiveFactShadowSummarySchema> | undefined,
): CampaignBudgetUsage[] {
  const usage: CampaignBudgetUsage[] = [];
  if (providerSmoke) {
    usage.push({
      source: "provider_smoke",
      modelCalls: providerSmoke.tokenUsage.modelCalls,
      inputTokens: providerSmoke.tokenUsage.inputTokens,
      outputTokens: providerSmoke.tokenUsage.outputTokens,
      totalTokens: providerSmoke.tokenUsage.totalTokens,
      estimatedCostUsd: providerSmoke.estimatedCostUsd,
    });
  }
  if (phase2Summary) {
    usage.push({
      source: "phase2f_shadow",
      modelCalls: phase2Summary.totalTokenUsage.modelCalls,
      totalTokens: phase2Summary.totalTokenUsage.totalTokens,
    });
  }
  if (latest) {
    usage.push({
      source: "harness_smoke",
      modelCalls: latest.tokenUsage.total.modelCalls,
      inputTokens: latest.tokenUsage.total.inputTokens,
      outputTokens: latest.tokenUsage.total.outputTokens,
      totalTokens: latest.tokenUsage.total.totalTokens,
      estimatedCostUsd: latest.tokenUsage.total.estimatedUsd,
    });
  }
  return usage;
}

async function readProviderSmoke(
  regoloDir: string,
  violations: string[],
  scannedBodies: unknown[],
): Promise<z.infer<typeof RegoloProviderSmokeReportSchema> | undefined> {
  const filePath = path.join(regoloDir, PROVIDER_SMOKE_JSON);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    scannedBodies.push(raw);
    return RegoloProviderSmokeReportSchema.parse(JSON.parse(raw));
  } catch (error) {
    violations.push(`missing or invalid ${PROVIDER_SMOKE_JSON}: ${errorMessage(error)}`);
    return undefined;
  }
}

async function readPhase2Shadow(
  repoRoot: string,
  violations: string[],
  scannedBodies: unknown[],
): Promise<z.infer<typeof LiveFactShadowGateSchema> | undefined> {
  const filePath = path.join(getEvidenceTrackDir("phase2", repoRoot), PHASE2_SHADOW_JSON);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    scannedBodies.push(raw);
    return LiveFactShadowGateSchema.parse(JSON.parse(raw));
  } catch (error) {
    violations.push(`missing or invalid phase2/${PHASE2_SHADOW_JSON}: ${errorMessage(error)}`);
    return undefined;
  }
}

async function readPhase2Summary(
  repoRoot: string,
  violations: string[],
  scannedBodies: unknown[],
): Promise<z.infer<typeof LiveFactShadowSummarySchema> | undefined> {
  const filePath = path.join(getEvidenceTrackDir("phase2", repoRoot), PHASE2_SHADOW_SUMMARY_JSON);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    scannedBodies.push(raw);
    return LiveFactShadowSummarySchema.parse(JSON.parse(raw));
  } catch (error) {
    violations.push(`missing or invalid phase2/${PHASE2_SHADOW_SUMMARY_JSON}: ${errorMessage(error)}`);
    return undefined;
  }
}

async function tryUpdateManifest(
  repoRoot: string,
  input: {
    liveEvidenceStatus: "live_provider";
    campaignRollup: ReturnType<typeof aggregateCampaignBudget>;
    now?: () => Date;
  },
): Promise<boolean> {
  const evidenceRoot = getEvidenceRoot(repoRoot);
  const manifestPath = path.join(evidenceRoot, MANIFEST_JSON);
  let existing: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    existing = isPlainObjectRecord(parsed) ? parsed : undefined;
  } catch {
    existing = undefined;
  }

  const generatedAt = (input.now?.() ?? new Date()).toISOString();
  const existingRepoRef = existing?.repoRef;
  const manifest = buildEvidenceManifest({
    generatedAt,
    liveEvidenceStatus: input.liveEvidenceStatus,
    secretScanPassedAt: generatedAt,
    campaignBudget: input.campaignRollup,
    ...(typeof existingRepoRef === "string" ? { repoRef: existingRepoRef } : {}),
  });

  await fs.mkdir(evidenceRoot, { recursive: true });
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return true;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPlainObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isResolvedPathInsideDirectory(candidatePath: string, directoryPath: string): boolean {
  const resolvedDir = path.resolve(directoryPath);
  const resolvedCandidate = path.resolve(candidatePath);
  const relative = path.relative(resolvedDir, resolvedCandidate);
  if (relative === "") return true;
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function validateCampaignTrackFreshness(
  timestamps: {
    readonly harnessGeneratedAt?: string;
    readonly providerSmokeGeneratedAt?: string;
    readonly phase2ReportGeneratedAt?: string;
    readonly phase2SummaryGeneratedAt?: string;
  },
  windowMs: number,
  violations: string[],
): void {
  const entries: Array<{ label: string; raw: string | undefined }> = [
    { label: "harness latest.json", raw: timestamps.harnessGeneratedAt },
    { label: "provider-smoke.json", raw: timestamps.providerSmokeGeneratedAt },
    { label: "phase2 live-fact-shadow-report.json", raw: timestamps.phase2ReportGeneratedAt },
    { label: "phase2 live-fact-shadow-summary.json", raw: timestamps.phase2SummaryGeneratedAt },
  ];

  const parsed: Array<{ label: string; ms: number }> = [];
  for (const entry of entries) {
    if (!entry.raw?.trim()) {
      violations.push(`campaign track ${entry.label} is missing generatedAt`);
      continue;
    }
    const ms = Date.parse(entry.raw);
    if (!Number.isFinite(ms)) {
      violations.push(`campaign track ${entry.label} has unparseable generatedAt`);
      continue;
    }
    parsed.push({ label: entry.label, ms });
  }

  if (parsed.length < entries.length) return;

  const minMs = Math.min(...parsed.map((entry) => entry.ms));
  const maxMs = Math.max(...parsed.map((entry) => entry.ms));
  const spreadMs = maxMs - minMs;
  if (spreadMs > windowMs) {
    violations.push(
      `campaign evidence timestamps span ${Math.round(spreadMs / 1000)}s (max ${Math.round(windowMs / 1000)}s); tracks may be from different runs`,
    );
  }
}

export const GATE_FAILURE_KINDS = ZAI_HARNESS_FAILURE_KINDS;
export const GATE_HARNESS_SCHEMA = REGOLO_HARNESS_REPORT_SCHEMA_VERSION;