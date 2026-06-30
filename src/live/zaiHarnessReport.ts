import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  DEFAULT_ZAI_CAMPAIGN_TOKEN_LIMIT,
  aggregateCampaignBudget,
  getZaiLiveEvidenceDir,
  getZaiLiveRunEvidenceDir,
} from "../evidence";
import { runEventToFacts } from "../facts/adapters/runEventFacts";
import { createInMemoryObservabilityTrace } from "../observability";
import { buildContextPack, createContextMaterial, type ContextMaterial } from "../orchestration/contextBuilder";
import {
  runOrchestratedChatRun,
  type ChatRunArgs,
  type ChatRunResult,
} from "../orchestration/chatRunner";
import { triageUserMessage } from "../orchestration/triage";
import {
  LLMUsageSchema,
  ProviderError,
  type LLMInvokeOptions,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  type LLMUsage,
  type ModelRoute,
  type ModelRouter,
} from "../providers/llm";
import { redactString } from "../security/redaction";
import { createRectorStore, type RectorStore } from "../store";
import type { RunEvent } from "../store/schemas";
import {
  isAcceptableLiveEvidenceProvider,
  isZaiCompatibleHost,
  normalizeRequestedLiveProvider,
  type DiscoveredLiveProvider,
  type LiveProviderDiscoveryResult,
  type LiveProviderRejection,
} from "./liveProviderDiscovery";
import { discoverLiveProviderFromRepo } from "./repoLiveProviderDiscovery";
import {
  buildWorkspaceManifestSeries,
  computeSourceWorkspaceManifest,
  diffWorkspaceManifests,
  sanitizeHarnessEvidenceValue,
  secretLeakFindings,
  writeJsonArtifact,
  writeJsonlArtifact,
  type SourceWorkspaceManifest,
  type WorkspaceManifestSeriesEntry,
} from "./harnessEvidence";
import {
  ZAI_HARNESS_FAILURE_KINDS,
  buildZaiHarnessScorecard,
  renderZaiHarnessScorecardMarkdown,
  type ZaiHarnessFailure,
  type ZaiHarnessFailureKind,
  type ZaiHarnessScorecard,
  type ZaiHarnessScenarioStatus,
} from "./harnessScorecard";
import { zaiHarnessScenarios, type ZaiHarnessScenario } from "./harnessScenarios";

export const ZAI_HARNESS_REPORT_SCHEMA_VERSION = "rector.zai-harness-smoke.v1";
const TOKEN_USAGE_SCHEMA_VERSION = "rector.zai-harness-token-usage.v1";
const PROVIDER_CALLS_SCHEMA_VERSION = "rector.zai-harness-provider-calls.v1";
const REDACTED_PROMPTS_SCHEMA_VERSION = "rector.zai-harness-redacted-prompts.v1";
const REDACTED_OUTPUTS_SCHEMA_VERSION = "rector.zai-harness-redacted-model-outputs.v1";

const HARNESS_REPORT_JSON = "harness-report.json";
const HARNESS_REPORT_MD = "harness-report.md";
const RUN_EVENTS_JSONL = "run-events.jsonl";
const FACT_LEDGER_JSONL = "fact-ledger.jsonl";
const PROVIDER_CALLS_JSON = "provider-calls.json";
const TOKEN_USAGE_JSON = "token-usage.json";
const COST_REPORT_JSON = "cost-report.json";
const REDACTED_PROMPTS_JSON = "redacted-prompts.json";
const REDACTED_OUTPUTS_JSON = "redacted-model-outputs.json";
const BEFORE_MANIFEST_JSON = "workspace-before-manifest.json";
const AFTER_MANIFEST_JSON = "workspace-after-manifest.json";
const SCORECARD_JSON = "scorecard.json";
const SCORECARD_MD = "scorecard.md";
const LATEST_JSON = "latest.json";
const LATEST_MD = "latest.md";
const INDEX_JSON = "index.json";

const ZERO_USAGE: LLMUsage = LLMUsageSchema.parse({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  estimatedUsd: 0,
  modelCalls: 0,
});

const TokenUsageShapeSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    estimatedUsd: z.number().nonnegative(),
    modelCalls: z.number().int().nonnegative(),
  })
  .strict();

const FailureSchema = z
  .object({
    kind: z.enum(ZAI_HARNESS_FAILURE_KINDS),
    message: z.string().min(1),
    detail: z.string().min(1).optional(),
  })
  .strict();

const ScenarioReportSchema = z
  .object({
    scenarioId: z.string().min(1),
    title: z.string().min(1),
    kind: z.string().min(1),
    status: z.enum(["passed", "failed", "skipped"]),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
    durationMs: z.number().int().nonnegative(),
    runId: z.string().min(1).nullable(),
    runStatus: z.string().min(1).nullable(),
    runPhase: z.string().min(1).nullable(),
    synthesisStatus: z.string().min(1).nullable(),
    workspaceMutation: z
      .object({
        mutationDetected: z.boolean(),
        mutatedPaths: z.array(z.string()),
        added: z.array(z.string()),
        removed: z.array(z.string()),
        changed: z.array(z.string()),
      })
      .strict(),
    evidence: z
      .object({
        runEventCount: z.number().int().nonnegative(),
        factCount: z.number().int().nonnegative(),
      })
      .strict(),
    tokenUsage: TokenUsageShapeSchema,
    estimatedCostUsd: z.number().nonnegative(),
    failures: z.array(FailureSchema),
  })
  .strict();

const TokenUsageReportSchema = z
  .object({
    schemaVersion: z.literal(TOKEN_USAGE_SCHEMA_VERSION),
    generatedAt: z.string().datetime(),
    limits: z.object({ maxTotalTokens: z.number().int().positive() }).strict(),
    total: TokenUsageShapeSchema,
    preflightEstimates: z.array(z.object({ scenarioId: z.string().min(1), usage: TokenUsageShapeSchema }).strict()),
    scenarios: z.array(z.object({ scenarioId: z.string().min(1), actual: TokenUsageShapeSchema }).strict()),
  })
  .strict();

const ScorecardSchema = z
  .object({
    schemaVersion: z.string().min(1),
    generatedAt: z.string().datetime(),
    passed: z.boolean(),
    scenarioCount: z.number().int().nonnegative(),
    passedCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(),
    skippedCount: z.number().int().nonnegative(),
    failureCounts: z.record(z.number().int().nonnegative()),
    mutationFree: z.boolean(),
    evidenceComplete: z.boolean(),
    noSecretLeaks: z.boolean(),
    withinTokenBudget: z.boolean(),
    notes: z.array(z.string()),
  })
  .strict();

export const ZaiHarnessReportSchema = z
  .object({
    schemaVersion: z.literal(ZAI_HARNESS_REPORT_SCHEMA_VERSION),
    generatedAt: z.string().datetime(),
    runId: z.string().min(1),
    status: z.enum(["passed", "failed", "skipped"]),
    liveEvidenceStatus: z.enum(["live_provider", "test_only_injected", "skipped"]),
    skippedReason: z.string().min(1).optional(),
    providerId: z.string().min(1).nullable(),
    adapterId: z.string().min(1).nullable(),
    modelId: z.string().min(1).nullable(),
    host: z.string().min(1).nullable(),
    scenarioCount: z.number().int().nonnegative(),
    passedCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(),
    skippedCount: z.number().int().nonnegative(),
    scenarios: z.array(ScenarioReportSchema),
    tokenUsage: TokenUsageReportSchema,
    costReport: z.unknown(),
    scorecard: ScorecardSchema,
    artifacts: z.record(z.string().min(1)),
    failures: z.array(FailureSchema),
    notes: z.array(z.string().min(1)),
  })
  .strict();

export type ZaiHarnessReport = Readonly<z.infer<typeof ZaiHarnessReportSchema>>;
export type ZaiHarnessScenarioReport = Readonly<z.infer<typeof ScenarioReportSchema>>;
export type ZaiHarnessTokenUsageReport = Readonly<z.infer<typeof TokenUsageReportSchema>>;
export type ZaiHarnessChatRunner = typeof runOrchestratedChatRun;

export const DEFAULT_ZAI_HARNESS_CHAT_RUNNER: ZaiHarnessChatRunner = runOrchestratedChatRun;

export interface ZaiHarnessSmokeOptions {
  readonly repoRoot?: string;
  readonly runId?: string;
  readonly env?: Record<string, string | undefined>;
  readonly now?: () => Date;
  readonly scenarios?: readonly ZaiHarnessScenario[];
  readonly write?: boolean;
  readonly campaignTokenLimit?: number;
  readonly providerDiscovery?: (env: Record<string, string | undefined>) => Promise<LiveProviderDiscoveryResult> | LiveProviderDiscoveryResult;
  readonly runner?: ZaiHarnessChatRunner;
}

interface ProviderCallRecord {
  readonly callId: string;
  readonly scenarioId: string;
  readonly task?: string;
  readonly route?: string;
  readonly modelRoute?: ModelRoute;
  readonly model?: string;
  readonly status: "passed" | "failed";
  readonly latencyMs: number;
  readonly estimatedUsage: LLMUsage;
  readonly actualUsage: LLMUsage;
  readonly failure?: ZaiHarnessFailure;
}

interface RedactedPromptRecord {
  readonly callId: string;
  readonly scenarioId: string;
  readonly task?: string;
  readonly route?: string;
  readonly modelRoute?: ModelRoute;
  readonly model?: string;
  readonly messages: readonly { readonly role: string; readonly content: string }[];
}

interface RedactedModelOutputRecord {
  readonly callId: string;
  readonly scenarioId: string;
  readonly provider: string;
  readonly model: string;
  readonly finishReason: string;
  readonly usage: LLMUsage;
  readonly content: string;
}

interface ScenarioExecutionArtifacts {
  readonly report: ZaiHarnessScenarioReport;
  readonly events: readonly RunEvent[];
  readonly facts: readonly unknown[];
  readonly beforeManifest: SourceWorkspaceManifest;
  readonly afterManifest: SourceWorkspaceManifest;
}

export async function runZaiHarnessSmoke(options: ZaiHarnessSmokeOptions = {}): Promise<ZaiHarnessReport> {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const generatedAt = now().toISOString();
  const runId = options.runId ?? defaultRunId(now());
  const runDir = getZaiLiveRunEvidenceDir(runId, repoRoot);
  const rootDir = getZaiLiveEvidenceDir(repoRoot);
  const write = options.write ?? true;
  const scenarios = options.scenarios ?? zaiHarnessScenarios();
  const campaignTokenLimit = Math.trunc(options.campaignTokenLimit ?? DEFAULT_ZAI_CAMPAIGN_TOKEN_LIMIT);

  if (env.LIVE_HARNESS_EVALS !== "1") {
    return writeHarnessReport(
      skippedReport({
        generatedAt,
        runId,
        scenarios,
        reason: "LIVE_HARNESS_EVALS must equal 1; Z.ai harness smoke is opt-in.",
        campaignTokenLimit,
      }),
      { repoRoot, rootDir, runDir, write },
    );
  }

  if (normalizeRequestedLiveProvider(env.RECTOR_LIVE_PROVIDER) !== "zai") {
    return writeHarnessReport(
      skippedReport({
        generatedAt,
        runId,
        scenarios,
        reason: "RECTOR_LIVE_PROVIDER must explicitly select Z.ai for the live harness smoke.",
        campaignTokenLimit,
      }),
      { repoRoot, rootDir, runDir, write },
    );
  }

  const discoveryWasInjected = options.providerDiscovery !== undefined;
  const discovery =
    options.providerDiscovery
    ?? ((currentEnv: Record<string, string | undefined>) => discoverLiveProviderFromRepo(repoRoot, currentEnv));
  const discovered = await discovery(env);
  const selected = discovered.selected;
  if (!selected) {
    const providerFailure = discovered.rejections[0]
      ? failureFromRejection(discovered.rejections[0])
      : failure("provider_config", "No configured Z.ai OpenAI-compatible live provider was available.");
    const report = failedBeforeScenarios({
      generatedAt,
      runId,
      scenarios,
      campaignTokenLimit,
      failure: providerFailure,
      skippedReason: discovered.rejections.length > 0 ? undefined : "No configured Z.ai OpenAI-compatible live provider was available.",
    });
    return writeHarnessReport(report, { repoRoot, rootDir, runDir, write });
  }

  const configFailure = validateSelectedProvider(selected);
  if (configFailure) {
    const report = failedBeforeScenarios({
      generatedAt,
      runId,
      scenarios,
      campaignTokenLimit,
      failure: configFailure,
    });
    return writeHarnessReport(report, { repoRoot, rootDir, runDir, write });
  }

  await fs.mkdir(runDir, { recursive: true });
  const store = createRectorStore({ driver: "sqlite", sqlitePath: path.join(runDir, "harness-store.sqlite") }, {
    now: () => now().toISOString(),
  });
  const tokenTracker = new HarnessTokenTracker(campaignTokenLimit);
  const recordingProvider = new RecordingBudgetedProvider(selected.provider, tokenTracker);
  const router = singleProviderRouter(selected, recordingProvider);
  const runner = options.runner ?? DEFAULT_ZAI_HARNESS_CHAT_RUNNER;
  const executed: ScenarioExecutionArtifacts[] = [];
  const beforeEntries: WorkspaceManifestSeriesEntry[] = [];
  const afterEntries: WorkspaceManifestSeriesEntry[] = [];

  for (const scenario of scenarios) {
    const scenarioResult = await runScenario({
      scenario,
      selected,
      repoRoot,
      store,
      runner,
      router,
      recordingProvider,
      tokenTracker,
      now,
    });
    executed.push(scenarioResult);
    beforeEntries.push({ scenarioId: scenario.id, manifest: scenarioResult.beforeManifest });
    afterEntries.push({ scenarioId: scenario.id, manifest: scenarioResult.afterManifest });
    if (!tokenTracker.withinBudget()) break;
  }
  if (executed.length < scenarios.length) {
    const remainingFailure = failure("token_budget", "Scenario was not run because the Z.ai harness campaign token budget was exhausted.");
    for (const scenario of scenarios.slice(executed.length)) {
      const manifest = await computeSourceWorkspaceManifest(repoRoot, { generatedAt });
      const blocked = blockedScenarioExecution(scenario, generatedAt, remainingFailure, manifest);
      executed.push(blocked);
      beforeEntries.push({ scenarioId: scenario.id, manifest });
      afterEntries.push({ scenarioId: scenario.id, manifest });
    }
  }

  const scenarioReports = executed.map((entry) => entry.report);
  const allEvents = executed.flatMap((entry) => [...entry.events]);
  const allFacts = executed.flatMap((entry) => [...entry.facts]);
  const tokenUsage = tokenTracker.report(generatedAt);
  const costReport = aggregateCampaignBudget(
    [{ source: "harness_smoke", ...usageToCampaign(tokenUsage.total) }],
    { generatedAt, limits: { maxTotalTokens: campaignTokenLimit } },
  );
  const secretLeakCount = secretLeakFindings({
    scenarios: scenarioReports,
    providerCalls: recordingProvider.providerCalls,
    prompts: recordingProvider.prompts,
    outputs: recordingProvider.outputs,
    tokenUsage,
    costReport,
  }).length;
  const scorecard = buildZaiHarnessScorecard({
    generatedAt,
    scenarios: scenarioReports.map((scenario) => ({
      scenarioId: scenario.scenarioId,
      status: scenario.status,
      failures: scenario.failures,
      mutationDetected: scenario.workspaceMutation.mutationDetected,
      runEventCount: scenario.evidence.runEventCount,
      factCount: scenario.evidence.factCount,
    })),
    secretLeakCount,
    withinTokenBudget: costReport.withinTokenBudget && tokenTracker.withinBudget(),
  });
  const topLevelFailures = reportFailures(scenarioReports, scorecard);
  if (secretLeakCount > 0) {
    topLevelFailures.push(failure("secret_leak", `Harness evidence secret scan found ${secretLeakCount} possible secret leak(s).`));
  }
  const report = buildReport({
    generatedAt,
    runId,
    liveEvidenceStatus: discoveryWasInjected || !selected.liveEvidence ? "test_only_injected" : "live_provider",
    selected,
    scenarioReports,
    tokenUsage,
    costReport,
    scorecard,
    failures: topLevelFailures,
  });

  return writeHarnessReport(report, {
    repoRoot,
    rootDir,
    runDir,
    write,
    events: allEvents,
    facts: allFacts,
    providerCalls: recordingProvider.providerCalls,
    prompts: recordingProvider.prompts,
    outputs: recordingProvider.outputs,
    beforeSeries: buildWorkspaceManifestSeries({ generatedAt, runId, scenarios: beforeEntries }),
    afterSeries: buildWorkspaceManifestSeries({ generatedAt, runId, scenarios: afterEntries }),
  });
}

function blockedScenarioExecution(
  scenario: ZaiHarnessScenario,
  generatedAt: string,
  blockedFailure: ZaiHarnessFailure,
  manifest: SourceWorkspaceManifest,
): ScenarioExecutionArtifacts {
  return {
    beforeManifest: manifest,
    afterManifest: manifest,
    events: [],
    facts: [],
    report: ScenarioReportSchema.parse({
      scenarioId: scenario.id,
      title: scenario.title,
      kind: scenario.kind,
      status: "failed",
      startedAt: generatedAt,
      completedAt: generatedAt,
      durationMs: 0,
      runId: null,
      runStatus: null,
      runPhase: null,
      synthesisStatus: null,
      workspaceMutation: { mutationDetected: false, mutatedPaths: [], added: [], removed: [], changed: [] },
      evidence: { runEventCount: 0, factCount: 0 },
      tokenUsage: ZERO_USAGE,
      estimatedCostUsd: 0,
      failures: [blockedFailure],
    }),
  };
}

async function runScenario(input: {
  readonly scenario: ZaiHarnessScenario;
  readonly selected: DiscoveredLiveProvider;
  readonly repoRoot: string;
  readonly store: RectorStore;
  readonly runner: ZaiHarnessChatRunner;
  readonly router: ModelRouter;
  readonly recordingProvider: RecordingBudgetedProvider;
  readonly tokenTracker: HarnessTokenTracker;
  readonly now: () => Date;
}): Promise<ScenarioExecutionArtifacts> {
  const startedAt = input.now().toISOString();
  const startedMs = Date.now();
  input.recordingProvider.setScenario(input.scenario.id);
  const beforeManifest = await computeSourceWorkspaceManifest(input.repoRoot, { generatedAt: startedAt });
  const failures: ZaiHarnessFailure[] = [];
  let result: ChatRunResult | undefined;
  let events: RunEvent[] = [];
  let facts: unknown[] = [];
  const preflightUsage = estimateScenarioPreflight(input.selected, input.scenario);
  input.tokenTracker.recordPreflight(input.scenario.id, preflightUsage);
  if (!input.tokenTracker.canStart(preflightUsage)) {
    failures.push(failure(
      "token_budget",
      `Preflight estimate ${preflightUsage.totalTokens} tokens would exceed campaign limit ${input.tokenTracker.maxTotalTokens}.`,
    ));
  } else {
    try {
      const args = await buildScenarioArgs({
        store: input.store,
        scenario: input.scenario,
        manifest: beforeManifest,
        selected: input.selected,
        now: input.now,
      });
      result = await input.runner(input.store, args, {
        router: input.router,
        enableNetwork: true,
        sandboxConfigured: false,
        workspaceRoot: input.repoRoot,
        now: () => input.now().toISOString(),
        budget: {
          maxUsd: 2,
          maxInputTokens: input.tokenTracker.remainingTokens(),
          maxOutputTokens: input.tokenTracker.remainingTokens(),
          maxModelCalls: 20,
          maxRuntimeMs: 120_000,
          maxHealingAttempts: 0,
          allowedProviders: [input.selected.provider.metadata.id],
          approvalRequiredAboveUsd: 0,
        },
        neuroFlags: { preprocessor: false },
        contextCompressionEnabled: false,
      });
      events = await input.store.listEvents(result.run.id);
      facts = events.flatMap((event) => factsFromRunEvent(event));
      failures.push(...classifyRunResultFailures(result, events, input.tokenTracker));
    } catch (error) {
      failures.push(classifyThrownFailure(error));
    }
  }

  const completedAt = input.now().toISOString();
  const afterManifest = await computeSourceWorkspaceManifest(input.repoRoot, { generatedAt: completedAt });
  const diff = diffWorkspaceManifests(beforeManifest, afterManifest);
  if (diff.mutationDetected) {
    failures.push(failure(
      "unsafe_unexpected_mutation",
      "Read-only/plan-only/safety harness scenario mutated source workspace files.",
      diff.mutatedPaths.join(", "),
    ));
  }
  if (result && (events.length === 0 || facts.length === 0)) {
    failures.push(failure("missing_evidence", "Executed scenario did not produce required run events and fact-ledger rows."));
  }
  const scenarioUsage = input.tokenTracker.actualUsageForScenario(input.scenario.id);
  const status: ZaiHarnessScenarioStatus = failures.length === 0 ? "passed" : "failed";
  return {
    beforeManifest,
    afterManifest,
    events,
    facts,
    report: ScenarioReportSchema.parse({
      scenarioId: input.scenario.id,
      title: input.scenario.title,
      kind: input.scenario.kind,
      status,
      startedAt,
      completedAt,
      durationMs: Math.max(0, Date.now() - startedMs),
      runId: result?.run.id ?? null,
      runStatus: result?.run.status ?? null,
      runPhase: result?.run.phase ?? null,
      synthesisStatus: result?.synthesis.status ?? null,
      workspaceMutation: diff,
      evidence: { runEventCount: events.length, factCount: facts.length },
      tokenUsage: usageShape(scenarioUsage),
      estimatedCostUsd: scenarioUsage.estimatedUsd,
      failures,
    }),
  };
}

async function buildScenarioArgs(input: {
  readonly store: RectorStore;
  readonly scenario: ZaiHarnessScenario;
  readonly manifest: SourceWorkspaceManifest;
  readonly selected: DiscoveredLiveProvider;
  readonly now: () => Date;
}): Promise<ChatRunArgs> {
  const conversation = await input.store.createConversation({
    title: `Z.ai harness ${input.scenario.id}`,
    workspaceId: "zai-live-harness",
    retentionPolicy: "session",
  });
  const userMessage = await input.store.createMessage({
    conversationId: conversation.id,
    role: "user",
    content: input.scenario.prompt,
    status: "created",
    redactionState: "redacted",
    source: "zai-harness-smoke",
  });
  const triage = triageUserMessage(input.scenario.prompt);
  const materials: ContextMaterial[] = [];
  const manifestSummary = input.manifest.files
    .slice(0, 80)
    .map((entry) => `${entry.path} ${entry.sha256.slice(0, 12)} ${entry.sizeBytes}b`)
    .join("\n");
  materials.push(
    await createContextMaterial(input.store, {
      kind: "source_workspace_manifest",
      content: manifestSummary || "No source files found in manifest.",
      summary: "Sanitized source workspace manifest summary for live harness smoke.",
      thresholdBytes: 12_000,
      piiState: "redacted",
      retentionPolicy: "session",
      provenance: {
        source: "zai-harness-smoke",
        sourceType: "workspace_manifest",
        observedAt: input.now().toISOString(),
      },
    }),
  );
  const contextPack = await buildContextPack(input.store, {
    conversation,
    messages: [userMessage],
    userMessage,
    triage,
    materials,
    constraints: [
      "Harness B1-B3 are non-mutating live smoke scenarios.",
      "Do not write, rename, delete, patch, or execute mutating workspace operations.",
      "Use insufficient_evidence wording when repository evidence is not available.",
    ],
    providerInfo: {
      configured: [input.selected.providerId],
      unavailable: [],
      notes: ["Explicit Z.ai live provider selected for harness smoke."],
    },
    toolInfo: {
      names: [],
      notes: ["No mutating workspace sandbox is configured for these harness scenarios."],
    },
    now: () => input.now().toISOString(),
    contextBudget: { maxInlineChars: 12_000, maxArtifactHandles: 4, maxMemoryEntries: 0 },
  });
  return {
    conversationId: conversation.id,
    userMessageId: userMessage.id,
    prompt: input.scenario.prompt,
    triage,
    contextPack,
    observability: createInMemoryObservabilityTrace({ provider: input.selected.providerId }),
    options: {
      maxRuntimeMs: 120_000,
      maxHealingAttempts: 0,
      turnBudget: { maxIterations: 6 },
    },
  };
}

function factsFromRunEvent(event: RunEvent): unknown[] {
  try {
    return runEventToFacts(event);
  } catch (error) {
    return [{
      kind: "fact_adapter_failure",
      runId: event.runId,
      eventId: event.id,
      message: safeMessage(error),
    }];
  }
}

function singleProviderRouter(selected: DiscoveredLiveProvider, provider: LLMProvider): ModelRouter {
  return {
    select(): ReturnType<ModelRouter["select"]> {
      const modelRoute = selected.route;
      const model = selected.modelId || provider.metadata.models[modelRoute] || provider.metadata.models.cheap || Object.values(provider.metadata.models)[0] || provider.metadata.id;
      return {
        provider,
        providerId: selected.providerId,
        modelRoute,
        model,
        reason: "Z.ai harness smoke uses the explicitly selected live provider.",
      };
    },
  };
}

class RecordingBudgetedProvider implements LLMProvider {
  readonly metadata: LLMProvider["metadata"];
  readonly providerCalls: ProviderCallRecord[] = [];
  readonly prompts: RedactedPromptRecord[] = [];
  readonly outputs: RedactedModelOutputRecord[] = [];
  private scenarioId = "unknown";

  constructor(
    private readonly inner: LLMProvider,
    private readonly tokenTracker: HarnessTokenTracker,
  ) {
    this.metadata = inner.metadata;
  }

  setScenario(scenarioId: string): void {
    this.scenarioId = scenarioId;
  }

  validateConfig(): void {
    this.inner.validateConfig();
  }

  estimateRequest(request: LLMRequest): LLMUsage {
    return this.inner.estimateRequest(request);
  }

  async invoke(request: LLMRequest, options?: LLMInvokeOptions): Promise<LLMResponse> {
    const callId = `${this.scenarioId}-${this.providerCalls.length + 1}`;
    const estimatedUsage = this.inner.estimateRequest(request);
    this.prompts.push(redactedPrompt(callId, this.scenarioId, request));
    if (!this.tokenTracker.canStart(estimatedUsage)) {
      const budgetFailure = failure(
        "token_budget",
        `Provider call estimate ${estimatedUsage.totalTokens} tokens would exceed campaign limit ${this.tokenTracker.maxTotalTokens}.`,
      );
      this.providerCalls.push({
        callId,
        scenarioId: this.scenarioId,
        task: request.task,
        route: request.route,
        modelRoute: request.modelRoute,
        model: request.model,
        status: "failed",
        latencyMs: 0,
        estimatedUsage,
        actualUsage: ZERO_USAGE,
        failure: budgetFailure,
      });
      this.tokenTracker.recordDenial(this.scenarioId, budgetFailure);
      throw new ProviderError({
        code: "BUDGET_DENIED",
        provider: this.inner.metadata.id,
        message: budgetFailure.message,
      });
    }

    const started = Date.now();
    try {
      const response = await this.inner.invoke(request, options);
      const actualUsage = LLMUsageSchema.parse(response.usage);
      this.tokenTracker.recordActual(this.scenarioId, actualUsage);
      this.outputs.push(redactedOutput(callId, this.scenarioId, response));
      const overrun = this.tokenTracker.withinBudget()
        ? undefined
        : failure("token_budget", `Campaign token usage exceeded ${this.tokenTracker.maxTotalTokens} total tokens during scenario ${this.scenarioId}.`);
      if (overrun) this.tokenTracker.recordDenial(this.scenarioId, overrun);
      this.providerCalls.push({
        callId,
        scenarioId: this.scenarioId,
        task: request.task,
        route: request.route,
        modelRoute: request.modelRoute,
        model: request.model,
        status: overrun ? "failed" : "passed",
        latencyMs: Math.max(0, Date.now() - started),
        estimatedUsage,
        actualUsage,
        ...(overrun ? { failure: overrun } : {}),
      });
      return response;
    } catch (error) {
      const classified = classifyThrownFailure(error);
      this.providerCalls.push({
        callId,
        scenarioId: this.scenarioId,
        task: request.task,
        route: request.route,
        modelRoute: request.modelRoute,
        model: request.model,
        status: "failed",
        latencyMs: Math.max(0, Date.now() - started),
        estimatedUsage,
        actualUsage: ZERO_USAGE,
        failure: classified,
      });
      throw error;
    }
  }
}

class HarnessTokenTracker {
  readonly preflightEstimates: Array<{ scenarioId: string; usage: LLMUsage }> = [];
  readonly scenarioActuals = new Map<string, LLMUsage>();
  readonly denials: ZaiHarnessFailure[] = [];
  private totalUsage: LLMUsage = ZERO_USAGE;

  constructor(readonly maxTotalTokens: number) {}

  recordPreflight(scenarioId: string, usage: LLMUsage): void {
    this.preflightEstimates.push({ scenarioId, usage: usageShape(usage) });
  }

  canStart(usage: LLMUsage): boolean {
    return this.totalUsage.totalTokens + usage.totalTokens < this.maxTotalTokens;
  }

  recordActual(scenarioId: string, usage: LLMUsage): void {
    const normalized = usageShape(usage);
    this.totalUsage = addUsage(this.totalUsage, normalized);
    this.scenarioActuals.set(scenarioId, addUsage(this.scenarioActuals.get(scenarioId) ?? ZERO_USAGE, normalized));
  }

  recordDenial(_scenarioId: string, denial: ZaiHarnessFailure): void {
    this.denials.push(denial);
  }

  actualUsageForScenario(scenarioId: string): LLMUsage {
    return this.scenarioActuals.get(scenarioId) ?? ZERO_USAGE;
  }

  remainingTokens(): number {
    return Math.max(0, this.maxTotalTokens - this.totalUsage.totalTokens);
  }

  withinBudget(): boolean {
    return this.totalUsage.totalTokens < this.maxTotalTokens && this.denials.length === 0;
  }

  report(generatedAt: string): ZaiHarnessTokenUsageReport {
    return TokenUsageReportSchema.parse({
      schemaVersion: TOKEN_USAGE_SCHEMA_VERSION,
      generatedAt,
      limits: { maxTotalTokens: this.maxTotalTokens },
      total: usageShape(this.totalUsage),
      preflightEstimates: this.preflightEstimates.map((entry) => ({ scenarioId: entry.scenarioId, usage: usageShape(entry.usage) })),
      scenarios: [...this.scenarioActuals.entries()].map(([scenarioId, actual]) => ({ scenarioId, actual: usageShape(actual) })),
    });
  }
}

function estimateScenarioPreflight(selected: DiscoveredLiveProvider, scenario: ZaiHarnessScenario): LLMUsage {
  return selected.provider.estimateRequest({
    task: `zai-harness-smoke:${scenario.id}:preflight`,
    route: "HARNESS_PREFLIGHT",
    modelRoute: selected.route,
    model: selected.modelId,
    maxOutputTokens: scenario.maxOutputTokens,
    temperature: 0,
    messages: [
      { role: "system", content: "Estimate this non-mutating Rector harness smoke prompt." },
      { role: "user", content: scenario.prompt },
    ],
    metadata: { scenarioId: scenario.id, nonMutating: true },
  });
}

function classifyRunResultFailures(
  result: ChatRunResult,
  events: readonly RunEvent[],
  tokenTracker: HarnessTokenTracker,
): ZaiHarnessFailure[] {
  const failures: ZaiHarnessFailure[] = [];
  failures.push(...tokenTracker.denials);
  const run = result.run;
  if (run.status === "failed" || run.phase === "FAILED") {
    failures.push(classifyRunTextFailure(`${run.lastError ?? ""}\n${JSON.stringify(events)}\n${result.synthesis.evidence.join("\n")}`));
  }
  return dedupeFailures(failures);
}

function classifyThrownFailure(error: unknown): ZaiHarnessFailure {
  if (error instanceof ProviderError) {
    if (error.code === "BUDGET_DENIED") return failure("token_budget", safeMessage(error));
    if (error.code === "PROVIDER_HTTP_ERROR") return failure("http", safeMessage(error), error.status ? `HTTP ${error.status}` : undefined);
    if (error.code === "ABORTED") return failure("timeout", safeMessage(error));
    if (error.code === "PROVIDER_RESPONSE_INVALID") return failure("json", safeMessage(error));
    if (error.code === "CONFIG_INVALID" || error.code === "NETWORK_DISABLED") return failure("provider_config", safeMessage(error));
  }
  if (isAbortLike(error)) return failure("timeout", safeMessage(error));
  return classifyRunTextFailure(safeMessage(error));
}

function classifyRunTextFailure(text: string): ZaiHarnessFailure {
  const lower = text.toLowerCase();
  if (lower.includes("budget_denied") || lower.includes("token budget") || lower.includes("exceed") && lower.includes("token")) {
    return failure("token_budget", firstLine(text) || "Token budget failure.");
  }
  if (lower.includes("provider_http_error") || lower.includes("http ")) return failure("http", firstLine(text) || "Provider HTTP failure.");
  if (lower.includes("abort") || lower.includes("timeout")) return failure("timeout", firstLine(text) || "Provider timeout.");
  if (lower.includes("json") || lower.includes("parse")) return failure("json", firstLine(text) || "JSON/schema failure.");
  if (lower.includes("planner") || lower.includes("planner_invalid")) return failure("planner", firstLine(text) || "Planner failure.");
  if (lower.includes("skeptic") || lower.includes("skeptic_invalid")) return failure("skeptic", firstLine(text) || "Skeptic failure.");
  if (lower.includes("crucible")) return failure("crucible", firstLine(text) || "Crucible failure.");
  if (lower.includes("config")) return failure("provider_config", firstLine(text) || "Provider configuration failure.");
  return failure("unknown", firstLine(text) || "Unknown harness failure.");
}

function validateSelectedProvider(selected: DiscoveredLiveProvider): ZaiHarnessFailure | undefined {
  if (selected.requestedProvider !== "zai") {
    return failure("provider_config", "Harness requires an explicit Z.ai provider selection.");
  }
  if (selected.adapterId !== "openai-compatible" || selected.provider.metadata.id !== "openai-compatible") {
    return failure("provider_config", "Z.ai harness requires an OpenAI-compatible provider selection.");
  }
  if (!isZaiCompatibleHost(selected.host)) {
    return failure("provider_config", "Z.ai harness requires a Z.ai-compatible base URL host.", selected.host);
  }
  if (!isAcceptableLiveEvidenceProvider({ provider: selected.provider, providerId: selected.providerId, displayName: selected.displayName })) {
    return failure("provider_config", "Provider identity is fake, deterministic, spy, mock, fixture, scripted, or test-only.");
  }
  try {
    selected.provider.validateConfig();
  } catch (error) {
    return failure("provider_config", safeMessage(error));
  }
  return undefined;
}

function skippedReport(input: {
  readonly generatedAt: string;
  readonly runId: string;
  readonly scenarios: readonly ZaiHarnessScenario[];
  readonly reason: string;
  readonly campaignTokenLimit: number;
}): ZaiHarnessReport {
  const scenarioReports = input.scenarios.map((scenario) => skippedScenarioReport(scenario, input.generatedAt));
  const tokenUsage = emptyTokenUsage(input.generatedAt, input.campaignTokenLimit);
  const costReport = aggregateCampaignBudget([], { generatedAt: input.generatedAt, limits: { maxTotalTokens: input.campaignTokenLimit } });
  const scorecard = buildZaiHarnessScorecard({
    generatedAt: input.generatedAt,
    scenarios: scenarioReports.map((scenario) => ({
      scenarioId: scenario.scenarioId,
      status: scenario.status,
      failures: scenario.failures,
      mutationDetected: false,
      runEventCount: 0,
      factCount: 0,
    })),
    secretLeakCount: 0,
    withinTokenBudget: true,
  });
  return buildReport({
    generatedAt: input.generatedAt,
    runId: input.runId,
    liveEvidenceStatus: "skipped",
    selected: undefined,
    skippedReason: input.reason,
    scenarioReports,
    tokenUsage,
    costReport,
    scorecard,
    failures: [],
  });
}

function failedBeforeScenarios(input: {
  readonly generatedAt: string;
  readonly runId: string;
  readonly scenarios: readonly ZaiHarnessScenario[];
  readonly campaignTokenLimit: number;
  readonly failure: ZaiHarnessFailure;
  readonly skippedReason?: string;
}): ZaiHarnessReport {
  const scenarioReports = input.scenarios.map((scenario) => skippedScenarioReport(scenario, input.generatedAt));
  const tokenUsage = emptyTokenUsage(input.generatedAt, input.campaignTokenLimit);
  const costReport = aggregateCampaignBudget([], { generatedAt: input.generatedAt, limits: { maxTotalTokens: input.campaignTokenLimit } });
  const scorecard = buildZaiHarnessScorecard({
    generatedAt: input.generatedAt,
    scenarios: scenarioReports.map((scenario) => ({
      scenarioId: scenario.scenarioId,
      status: scenario.status,
      failures: scenario.failures,
      mutationDetected: false,
      runEventCount: 0,
      factCount: 0,
    })),
    secretLeakCount: 0,
    withinTokenBudget: true,
  });
  return buildReport({
    generatedAt: input.generatedAt,
    runId: input.runId,
    liveEvidenceStatus: "skipped",
    selected: undefined,
    skippedReason: input.skippedReason,
    scenarioReports,
    tokenUsage,
    costReport,
    scorecard,
    failures: [input.failure],
  });
}

function buildReport(input: {
  readonly generatedAt: string;
  readonly runId: string;
  readonly liveEvidenceStatus: "live_provider" | "test_only_injected" | "skipped";
  readonly selected?: DiscoveredLiveProvider;
  readonly skippedReason?: string;
  readonly scenarioReports: readonly ZaiHarnessScenarioReport[];
  readonly tokenUsage: ZaiHarnessTokenUsageReport;
  readonly costReport: unknown;
  readonly scorecard: ZaiHarnessScorecard;
  readonly failures: readonly ZaiHarnessFailure[];
}): ZaiHarnessReport {
  const passedCount = input.scenarioReports.filter((scenario) => scenario.status === "passed").length;
  const failedCount = input.scenarioReports.filter((scenario) => scenario.status === "failed").length;
  const skippedCount = input.scenarioReports.filter((scenario) => scenario.status === "skipped").length;
  const status = input.liveEvidenceStatus === "skipped" && input.failures.length === 0
    ? "skipped"
    : input.failures.length === 0 && input.scorecard.passed
      ? "passed"
      : "failed";
  return ZaiHarnessReportSchema.parse(sanitizeHarnessEvidenceValue({
    schemaVersion: ZAI_HARNESS_REPORT_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    runId: input.runId,
    status,
    liveEvidenceStatus: input.liveEvidenceStatus,
    ...(input.skippedReason ? { skippedReason: input.skippedReason } : {}),
    providerId: input.selected?.providerId ?? null,
    adapterId: input.selected?.adapterId ?? null,
    modelId: input.selected?.modelId ?? null,
    host: input.selected?.host ?? null,
    scenarioCount: input.scenarioReports.length,
    passedCount,
    failedCount,
    skippedCount,
    scenarios: input.scenarioReports,
    tokenUsage: input.tokenUsage,
    costReport: input.costReport,
    scorecard: input.scorecard,
    artifacts: artifactPointers(input.runId),
    failures: input.failures,
    notes: [
      "Z.ai harness smoke uses runOrchestratedChatRun by default and never creates a parallel fake chat product path.",
      "B1-B3 run with sandboxConfigured:false and are scored as non-mutating source-workspace smoke scenarios.",
      "Reports intentionally omit API keys, auth headers, and provider base URL paths.",
    ],
  }));
}

async function writeHarnessReport(
  report: ZaiHarnessReport,
  io: {
    readonly repoRoot: string;
    readonly rootDir: string;
    readonly runDir: string;
    readonly write: boolean;
    readonly events?: readonly RunEvent[];
    readonly facts?: readonly unknown[];
    readonly providerCalls?: readonly ProviderCallRecord[];
    readonly prompts?: readonly RedactedPromptRecord[];
    readonly outputs?: readonly RedactedModelOutputRecord[];
    readonly beforeSeries?: unknown;
    readonly afterSeries?: unknown;
  },
): Promise<ZaiHarnessReport> {
  const safeReport = ZaiHarnessReportSchema.parse(sanitizeHarnessEvidenceValue(report));
  if (!io.write) return safeReport;
  await fs.mkdir(io.runDir, { recursive: true });

  const emptyBefore = buildWorkspaceManifestSeries({ generatedAt: report.generatedAt, runId: report.runId, scenarios: [] });
  const emptyAfter = buildWorkspaceManifestSeries({ generatedAt: report.generatedAt, runId: report.runId, scenarios: [] });
  const providerCalls = {
    schemaVersion: PROVIDER_CALLS_SCHEMA_VERSION,
    generatedAt: report.generatedAt,
    calls: io.providerCalls ?? [],
  };
  const prompts = {
    schemaVersion: REDACTED_PROMPTS_SCHEMA_VERSION,
    generatedAt: report.generatedAt,
    prompts: io.prompts ?? [],
  };
  const outputs = {
    schemaVersion: REDACTED_OUTPUTS_SCHEMA_VERSION,
    generatedAt: report.generatedAt,
    outputs: io.outputs ?? [],
  };

  await writeJsonArtifact(path.join(io.runDir, HARNESS_REPORT_JSON), safeReport);
  await fs.writeFile(path.join(io.runDir, HARNESS_REPORT_MD), renderZaiHarnessMarkdown(safeReport), "utf8");
  await writeJsonlArtifact(path.join(io.runDir, RUN_EVENTS_JSONL), io.events ?? []);
  await writeJsonlArtifact(path.join(io.runDir, FACT_LEDGER_JSONL), io.facts ?? []);
  await writeJsonArtifact(path.join(io.runDir, PROVIDER_CALLS_JSON), providerCalls);
  await writeJsonArtifact(path.join(io.runDir, TOKEN_USAGE_JSON), safeReport.tokenUsage);
  await writeJsonArtifact(path.join(io.runDir, COST_REPORT_JSON), safeReport.costReport);
  await writeJsonArtifact(path.join(io.runDir, REDACTED_PROMPTS_JSON), prompts);
  await writeJsonArtifact(path.join(io.runDir, REDACTED_OUTPUTS_JSON), outputs);
  await writeJsonArtifact(path.join(io.runDir, BEFORE_MANIFEST_JSON), io.beforeSeries ?? emptyBefore);
  await writeJsonArtifact(path.join(io.runDir, AFTER_MANIFEST_JSON), io.afterSeries ?? emptyAfter);
  await writeJsonArtifact(path.join(io.runDir, SCORECARD_JSON), safeReport.scorecard);
  await fs.writeFile(path.join(io.runDir, SCORECARD_MD), renderZaiHarnessScorecardMarkdown(safeReport.scorecard as ZaiHarnessScorecard), "utf8");

  await fs.mkdir(io.rootDir, { recursive: true });
  await writeJsonArtifact(path.join(io.rootDir, LATEST_JSON), safeReport);
  await fs.writeFile(path.join(io.rootDir, LATEST_MD), renderZaiHarnessMarkdown(safeReport), "utf8");
  await writeJsonArtifact(path.join(io.rootDir, INDEX_JSON), await buildIndex(io.rootDir, safeReport));
  return safeReport;
}

async function buildIndex(rootDir: string, latest: ZaiHarnessReport): Promise<unknown> {
  let existingRuns: unknown[] = [];
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(rootDir, INDEX_JSON), "utf8"));
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as { runs?: unknown }).runs)) {
      existingRuns = (parsed as { runs: unknown[] }).runs;
    }
  } catch {
    existingRuns = [];
  }
  const current = {
    runId: latest.runId,
    generatedAt: latest.generatedAt,
    status: latest.status,
    liveEvidenceStatus: latest.liveEvidenceStatus,
    reportJson: `runs/${latest.runId}/${HARNESS_REPORT_JSON}`,
    reportMarkdown: `runs/${latest.runId}/${HARNESS_REPORT_MD}`,
  };
  const runs = [current, ...existingRuns.filter((entry) => !sameRun(entry, latest.runId))].slice(0, 50);
  return {
    schemaVersion: "rector.zai-harness-index.v1",
    generatedAt: latest.generatedAt,
    latestRunId: latest.runId,
    runs,
  };
}

export function renderZaiHarnessMarkdown(report: ZaiHarnessReport): string {
  const lines: string[] = [];
  lines.push("# Z.ai Harness Smoke", "");
  lines.push(`- Schema: \`${report.schemaVersion}\``);
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Run ID: \`${safeMarkdown(report.runId)}\``);
  lines.push(`- Status: ${report.status}`);
  lines.push(`- Live evidence status: ${report.liveEvidenceStatus}`);
  if (report.skippedReason) lines.push(`- Skipped reason: ${safeMarkdown(report.skippedReason)}`);
  lines.push(`- Provider: ${safeMarkdown(report.providerId ?? "n/a")}`);
  lines.push(`- Adapter: ${safeMarkdown(report.adapterId ?? "n/a")}`);
  lines.push(`- Model: ${safeMarkdown(report.modelId ?? "n/a")}`);
  lines.push(`- Host: ${safeMarkdown(report.host ?? "n/a")}`);
  lines.push(`- Scenarios: ${report.passedCount} passed / ${report.failedCount} failed / ${report.skippedCount} skipped`);
  lines.push(`- Tokens: ${report.tokenUsage.total.totalTokens} / ${report.tokenUsage.limits.maxTotalTokens}`);
  lines.push(`- Scorecard passed: ${report.scorecard.passed}`);
  lines.push("", "## Scenarios", "");
  lines.push("| scenario | status | run phase | mutations | events | facts | tokens | failures |");
  lines.push("| --- | --- | --- | ---: | ---: | ---: | ---: | --- |");
  for (const scenario of report.scenarios) {
    lines.push(`| \`${safeMarkdown(scenario.scenarioId)}\` ${safeMarkdown(scenario.title)} | ${scenario.status} | ${safeMarkdown(scenario.runPhase ?? "n/a")} | ${scenario.workspaceMutation.mutatedPaths.length} | ${scenario.evidence.runEventCount} | ${scenario.evidence.factCount} | ${scenario.tokenUsage.totalTokens} | ${safeMarkdown(scenario.failures.map((entry) => entry.kind).join(", ") || "none")} |`);
  }
  lines.push("", "## Failures", "");
  const failures = [...report.failures, ...report.scenarios.flatMap((scenario) => scenario.failures)];
  if (failures.length === 0) lines.push("No failures recorded.");
  for (const item of failures) {
    lines.push(`- \`${item.kind}\`: ${safeMarkdown(item.message)}`);
  }
  lines.push("", "## Notes", "");
  for (const note of report.notes) lines.push(`> ${safeMarkdown(note)}`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function skippedScenarioReport(scenario: ZaiHarnessScenario, generatedAt: string): ZaiHarnessScenarioReport {
  return ScenarioReportSchema.parse({
    scenarioId: scenario.id,
    title: scenario.title,
    kind: scenario.kind,
    status: "skipped",
    startedAt: generatedAt,
    completedAt: generatedAt,
    durationMs: 0,
    runId: null,
    runStatus: null,
    runPhase: null,
    synthesisStatus: null,
    workspaceMutation: { mutationDetected: false, mutatedPaths: [], added: [], removed: [], changed: [] },
    evidence: { runEventCount: 0, factCount: 0 },
    tokenUsage: ZERO_USAGE,
    estimatedCostUsd: 0,
    failures: [],
  });
}

function emptyTokenUsage(generatedAt: string, maxTotalTokens: number): ZaiHarnessTokenUsageReport {
  return TokenUsageReportSchema.parse({
    schemaVersion: TOKEN_USAGE_SCHEMA_VERSION,
    generatedAt,
    limits: { maxTotalTokens },
    total: ZERO_USAGE,
    preflightEstimates: [],
    scenarios: [],
  });
}

function reportFailures(scenarios: readonly ZaiHarnessScenarioReport[], scorecard: ZaiHarnessScorecard): ZaiHarnessFailure[] {
  const failures = scenarios.flatMap((scenario) => [...scenario.failures]);
  if (!scorecard.passed && failures.length === 0) {
    failures.push(failure("scorecard", "Harness scorecard did not pass."));
  }
  return dedupeFailures(failures);
}

function failure(kind: ZaiHarnessFailureKind, message: string, detail?: string): ZaiHarnessFailure {
  return { kind, message: redactHarnessString(message), ...(detail ? { detail: redactHarnessString(detail) } : {}) };
}

function failureFromRejection(rejection: LiveProviderRejection): ZaiHarnessFailure {
  return failure("provider_config", messageForRejection(rejection), rejection.host);
}

function messageForRejection(rejection: LiveProviderRejection): string {
  if (rejection.message) return rejection.message;
  if (rejection.reason === "zai_host_required") return "Z.ai live provider requires a Z.ai-compatible base URL host.";
  if (rejection.reason === "missing_env") return "Z.ai live provider requires complete OpenAI-compatible Z.ai credentials.";
  if (rejection.reason === "runtime_not_configured") return "Runtime settings are not configured.";
  if (rejection.reason === "no_configured_zai_provider") return "No configured Z.ai OpenAI-compatible provider was found.";
  return `Z.ai live provider discovery failed: ${rejection.reason}`;
}

function redactedPrompt(callId: string, scenarioId: string, request: LLMRequest): RedactedPromptRecord {
  return sanitizeHarnessEvidenceValue({
    callId,
    scenarioId,
    task: request.task,
    route: request.route,
    modelRoute: request.modelRoute,
    model: request.model,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: redactHarnessString(message.content).slice(0, 20_000),
    })),
  });
}

function redactedOutput(callId: string, scenarioId: string, response: LLMResponse): RedactedModelOutputRecord {
  return sanitizeHarnessEvidenceValue({
    callId,
    scenarioId,
    provider: response.provider,
    model: response.model,
    finishReason: response.finishReason,
    usage: usageShape(response.usage),
    content: redactHarnessString(response.content).slice(0, 20_000),
  });
}

function usageShape(usage: LLMUsage): LLMUsage {
  return LLMUsageSchema.parse({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    estimatedUsd: usage.estimatedUsd,
    modelCalls: usage.modelCalls,
  });
}

function addUsage(left: LLMUsage, right: LLMUsage): LLMUsage {
  return LLMUsageSchema.parse({
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    estimatedUsd: Math.round((left.estimatedUsd + right.estimatedUsd) * 1_000_000) / 1_000_000,
    modelCalls: left.modelCalls + right.modelCalls,
  });
}

function usageToCampaign(usage: LLMUsage): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  modelCalls: number;
} {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    estimatedCostUsd: usage.estimatedUsd,
    modelCalls: usage.modelCalls,
  };
}

function artifactPointers(runId: string): Record<string, string> {
  const inRun = (name: string) => `runs/${runId}/${name}`;
  return {
    harnessReportJson: inRun(HARNESS_REPORT_JSON),
    harnessReportMarkdown: inRun(HARNESS_REPORT_MD),
    runEventsJsonl: inRun(RUN_EVENTS_JSONL),
    factLedgerJsonl: inRun(FACT_LEDGER_JSONL),
    providerCallsJson: inRun(PROVIDER_CALLS_JSON),
    tokenUsageJson: inRun(TOKEN_USAGE_JSON),
    costReportJson: inRun(COST_REPORT_JSON),
    redactedPromptsJson: inRun(REDACTED_PROMPTS_JSON),
    redactedModelOutputsJson: inRun(REDACTED_OUTPUTS_JSON),
    workspaceBeforeManifestJson: inRun(BEFORE_MANIFEST_JSON),
    workspaceAfterManifestJson: inRun(AFTER_MANIFEST_JSON),
    scorecardJson: inRun(SCORECARD_JSON),
    scorecardMarkdown: inRun(SCORECARD_MD),
  };
}

function defaultRunId(now: Date): string {
  const stamp = now.toISOString().replace(/[^0-9A-Za-z]/g, "").slice(0, 15);
  return `zai-harness-${stamp}-${process.pid}`;
}

function dedupeFailures(failures: readonly ZaiHarnessFailure[]): ZaiHarnessFailure[] {
  const seen = new Set<string>();
  const output: ZaiHarnessFailure[] = [];
  for (const item of failures) {
    const key = `${item.kind}:${item.message}:${item.detail ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function sameRun(entry: unknown, runId: string): boolean {
  return !!entry && typeof entry === "object" && (entry as { runId?: unknown }).runId === runId;
}

function firstLine(value: string): string {
  return redactHarnessString(value).split(/\r?\n/).find((line) => line.trim().length > 0)?.trim().slice(0, 240) ?? "";
}

function safeMessage(error: unknown): string {
  return redactHarnessString(error instanceof Error ? error.message : String(error));
}

function redactHarnessString(value: string): string {
  return sanitizeHarnessEvidenceValue(redactString(value)) as string;
}

function isAbortLike(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { name?: unknown; code?: unknown };
  return record.name === "AbortError" || record.code === "ABORT_ERR";
}

function safeMarkdown(value: string): string {
  return value.replace(/[|\n\r]/g, " ").slice(0, 240);
}
