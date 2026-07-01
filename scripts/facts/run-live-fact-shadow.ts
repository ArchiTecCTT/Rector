import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ArtifactRefSchema,
  RectorFactSchema,
  createFactId,
  createFactScope,
  createFactTrust,
  validateFactArtifactRefs,
  validateFactGrounding,
  validateFactProvenance,
  validateFactRedactionState,
  validateFactSchema,
  validateFactScope,
  validateFactTrustTransition,
  validationErrorsForReport,
  type ArtifactRef,
  type FactValidationError,
  type RectorFact,
} from "../../src/facts";
import {
  AzureOpenAIProvider,
  CloudflareWorkersAIProvider,
  OpenAICompatibleProvider,
  TogetherAIProvider,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  type LLMUsage,
  type ModelRoute,
} from "../../src/providers";
import { getEvidenceTrackDir, sanitizeEvidencePayload, sanitizeEvidenceStringLeaves } from "../../src/evidence";
import {
  aggregateFailureCategoryCounts,
  attemptSummariesFromStrictJsonAttempts,
  classifySkippedCasePassClassification,
  diagnosticsFromShadowCaseEvaluation,
  passClassificationFromRepairLoop,
  rollupPassOutcomeCounts,
  type LiveFactShadowCaseEvaluation,
} from "../../src/facts/reports/liveFactShadowClassification";
import {
  LIVE_FACT_SHADOW_REPORT_SCHEMA_VERSION,
  LIVE_FACT_SHADOW_SUMMARY_SCHEMA_VERSION,
  LiveFactShadowCaseReportSchema,
  LiveFactShadowReportSchema,
  LiveFactShadowSummarySchema,
  type LiveFactShadowCaseReport,
  type LiveFactShadowReport,
} from "../../src/facts/reports/liveFactShadowReport";
import {
  isAcceptableLiveEvidenceProvider,
  normalizeRequestedLiveProvider,
} from "../../src/live/liveProviderDiscovery";
import { discoverLiveProviderFromRepo } from "../../src/live/repoLiveProviderDiscovery";
import { renderStrictJsonRepairCards, STRICT_JSON_REPAIR_OUTPUT_RULES } from "../../src/orchestration/strictJsonRepairCards";
import {
  runBoundedStrictJsonRepairLoop,
  type StrictJsonEvidenceStatus,
  type StrictJsonValidationResult,
} from "../../src/orchestration/strictJsonRepairLoop";
import type { StrictOutputRuntimeMetadata } from "../../src/orchestration/strictOutputDiagnostics";
import {
  buildLiveFactShadowScenarioGuidance,
  buildLiveFactShadowSystemContract,
} from "../../src/facts/liveFactShadowPrompt";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_OUTPUT_DIR = getEvidenceTrackDir("phase2", REPO_ROOT);
const REPORT_JSON = "live-fact-shadow-report.json";
const REPORT_MD = "live-fact-shadow-report.md";
const SUMMARY_JSON = "live-fact-shadow-summary.json";
const RAW_MODEL_OUTPUT_DIR = "live-fact-shadow-artifacts";
const CREATED_BY = "Phase 2F live fact shadow runner";

export { LIVE_FACT_SHADOW_REPORT_SCHEMA_VERSION, LiveFactShadowReportSchema };

export interface DiscoveredLiveFactProvider {
  readonly provider: LLMProvider;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly route?: ModelRoute;
  /** True only for default explicit env/runtime discovery. Contract-test injected providers remain test-only evidence. */
  readonly liveEvidence: boolean;
  readonly discoveryLabel: string;
}

export interface LiveFactShadowRunnerOptions {
  readonly outputDir?: string;
  readonly repoRoot?: string;
  readonly write?: boolean;
  readonly env?: Record<string, string | undefined>;
  readonly now?: () => Date;
  readonly providerDiscovery?: (env: Record<string, string | undefined>) => Promise<readonly DiscoveredLiveFactProvider[]> | readonly DiscoveredLiveFactProvider[];
  readonly readFile?: typeof fs.readFile;
  readonly writeFile?: typeof fs.writeFile;
  readonly mkdir?: typeof fs.mkdir;
}

type LiveScenario = Readonly<{
  id: string;
  title: string;
  route: ModelRoute;
  prompt: string;
  fixturePath?: string;
  fixtureArtifactUri?: string;
  expectedKinds: readonly string[];
  expectInsufficientEvidence?: boolean;
}>;

type FactDraft = Record<string, unknown>;

type RawShadowOutput = Readonly<{
  facts?: unknown;
  insufficient_evidence?: unknown;
}>;

type CaseEvaluation = LiveFactShadowCaseEvaluation;

const ZERO_USAGE: LLMUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedUsd: 0, modelCalls: 0 };

export function liveFactShadowScenarios(): readonly LiveScenario[] {
  return [
    {
      id: "intent_extraction_stress",
      title: "Intent extraction stress",
      route: "fast",
      prompt: "Messy request: 'uh make rector less flaky maybe provider thing? don't touch billing or memory, ask if unclear, and prove with tests if you change code.' Extract typed facts without inventing scope.",
      expectedKinds: ["intent", "task_constraint", "unknown_or_ambiguity"],
    },
    {
      id: "rg_artifact_evidence_extraction",
      title: "Evidence extraction from committed raw rg artifact",
      route: "fast",
      fixturePath: "tests/fixtures/eval-corpus/cases/rg-orchestration-search/artifact.txt",
      fixtureArtifactUri: "artifact://fixtures/eval-corpus/rg-orchestration-search/artifact.txt",
      prompt: "Extract grounded capability evidence from this rg artifact. Cite only path/line spans that appear in the artifact.",
      expectedKinds: ["capability_evidence"],
    },
    {
      id: "test_log_diagnosis",
      title: "Test log diagnosis from real fixture log",
      route: "fast",
      fixturePath: "tests/fixtures/eval-corpus/cases/vitest-failing-log/artifact.txt",
      fixtureArtifactUri: "artifact://fixtures/eval-corpus/vitest-failing-log/artifact.txt",
      prompt: "Diagnose the root failing test or report insufficient evidence from this Vitest log. Do not summarize downstream noise as a root cause.",
      expectedKinds: ["capability_evidence", "capability_failure"],
    },
    {
      id: "tsc_diagnostic_grouping",
      title: "TypeScript diagnostic grouping",
      route: "fast",
      fixturePath: "tests/fixtures/eval-corpus/cases/tsc-runtime-mode-error/artifact.txt",
      fixtureArtifactUri: "artifact://fixtures/eval-corpus/tsc-runtime-mode-error/artifact.txt",
      prompt: "Group TypeScript diagnostics into root candidates and cascades. Do not claim a fix without evidence.",
      expectedKinds: ["capability_evidence", "capability_warning"],
    },
    {
      id: "insufficient_evidence",
      title: "Insufficient evidence",
      route: "fast",
      fixturePath: "tests/fixtures/eval-corpus/cases/live-shadow-insufficient/artifact.txt",
      fixtureArtifactUri: "artifact://fixtures/eval-corpus/live-shadow-insufficient/artifact.txt",
      prompt: "This artifact is intentionally incomplete. Return insufficient_evidence rather than guessing a root cause, file, or fix.",
      expectedKinds: ["capability_failure"],
      expectInsufficientEvidence: true,
    },
  ];
}

function envString(env: Record<string, string | undefined>, key: string): string {
  return env[key] ?? "";
}

export async function discoverLiveFactProviders(
  env: Record<string, string | undefined> = process.env,
  repoRoot?: string,
): Promise<DiscoveredLiveFactProvider[]> {
  const requested = normalizeRequestedLiveProvider(env.RECTOR_LIVE_PROVIDER);
  if (requested === "zai" || requested === "regolo") {
    const result = await discoverLiveProviderFromRepo(repoRoot, env);
    if (!result.selected) return [];
    return [{
      provider: result.selected.provider,
      route: result.selected.route,
      modelId: result.selected.modelId,
      providerId: result.selected.providerId,
      liveEvidence: result.selected.liveEvidence,
      discoveryLabel: result.selected.discoveryLabel,
    }];
  }

  const providers: DiscoveredLiveFactProvider[] = [];
  const candidates: Array<{ provider: LLMProvider; route: ModelRoute; label: string }> = [
    {
      provider: new TogetherAIProvider({
        apiKey: envString(env, "TOGETHER_API_KEY"),
        baseUrl: envString(env, "TOGETHER_BASE_URL"),
        enableNetwork: true,
      }),
      route: "fast",
      label: "TOGETHER_API_KEY",
    },
    {
      provider: new AzureOpenAIProvider({
        apiKey: envString(env, "AZURE_OPENAI_API_KEY"),
        endpoint: envString(env, "AZURE_OPENAI_ENDPOINT"),
        apiVersion: envString(env, "AZURE_OPENAI_API_VERSION"),
        deployments: {
          cheap: envString(env, "AZURE_OPENAI_CHEAP_DEPLOYMENT"),
          fast: envString(env, "AZURE_OPENAI_FAST_DEPLOYMENT") || envString(env, "AZURE_OPENAI_DEPLOYMENT"),
          flagship: envString(env, "AZURE_OPENAI_FLAGSHIP_DEPLOYMENT") || envString(env, "AZURE_OPENAI_DEPLOYMENT"),
          research: envString(env, "AZURE_OPENAI_RESEARCH_DEPLOYMENT"),
        },
        enableNetwork: true,
      }),
      route: "fast",
      label: "AZURE_OPENAI_*",
    },
    {
      provider: new CloudflareWorkersAIProvider({
        accountId: envString(env, "CLOUDFLARE_ACCOUNT_ID"),
        apiToken: envString(env, "CLOUDFLARE_API_TOKEN"),
        baseUrl: envString(env, "CLOUDFLARE_BASE_URL"),
        enableNetwork: true,
      }),
      route: "fast",
      label: "CLOUDFLARE_*",
    },
    {
      provider: new OpenAICompatibleProvider({
        apiKey: envString(env, "OPENAI_COMPATIBLE_API_KEY"),
        baseUrl: envString(env, "OPENAI_COMPATIBLE_BASE_URL"),
        model: envString(env, "OPENAI_COMPATIBLE_MODEL"),
        enableNetwork: true,
      }),
      route: "fast",
      label: "OPENAI_COMPATIBLE_*",
    },
  ];

  for (const candidate of candidates) {
    if (!isAcceptableLiveShadowProvider(candidate.provider)) continue;
    try {
      candidate.provider.validateConfig();
    } catch {
      continue;
    }
    providers.push({
      provider: candidate.provider,
      route: candidate.route,
      modelId: modelForRoute(candidate.provider, candidate.route),
      providerId: candidate.provider.metadata.id,
      liveEvidence: true,
      discoveryLabel: candidate.label,
    });
  }
  return providers;
}

export function isAcceptableLiveShadowProvider(provider: LLMProvider): boolean {
  return isAcceptableLiveEvidenceProvider({ provider });
}

export async function runLiveFactShadow(options: LiveFactShadowRunnerOptions = {}): Promise<LiveFactShadowReport> {
  const env = options.env ?? process.env;
  const outputDir = options.outputDir ?? DEFAULT_OUTPUT_DIR;
  const write = options.write ?? true;
  const now = options.now ?? (() => new Date());
  const generatedAt = now().toISOString();
  const mkdir = options.mkdir ?? fs.mkdir;
  const writeFile = options.writeFile ?? fs.writeFile;

  if (env.LIVE_FACT_EVALS !== "1") {
    return writeReport(skippedReport(generatedAt, "LIVE_FACT_EVALS must equal 1; live fact shadow is opt-in."), { outputDir, write, mkdir, writeFile });
  }

  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const discoveryWasInjected = options.providerDiscovery !== undefined;
  const discovery = options.providerDiscovery ?? ((currentEnv: Record<string, string | undefined>) => discoverLiveFactProviders(currentEnv, repoRoot));
  const discovered = (await discovery(env)).filter((candidate) => isAcceptableLiveShadowProvider(candidate.provider));
  const selected = discovered[0];
  if (!selected) {
    return writeReport(skippedReport(generatedAt, "No configured non-fake live provider was available; wrote skipped report instead."), { outputDir, write, mkdir, writeFile });
  }

  const providerId = selected.providerId ?? selected.provider.metadata.id;
  const route = selected.route ?? "fast";
  const modelId = selected.modelId ?? modelForRoute(selected.provider, route);
  const cases: LiveFactShadowCaseReport[] = [];
  const strictEvidenceStatus: StrictJsonEvidenceStatus =
    discoveryWasInjected || !selected.liveEvidence ? "test_only_injected" : "live_provider";
  for (const scenario of liveFactShadowScenarios()) {
    cases.push(
      await runScenario(scenario, selected.provider, {
        providerId,
        modelId,
        route,
        outputDir,
        readFile: options.readFile ?? fs.readFile,
        writeFile,
        mkdir,
        write,
        now,
        strictEvidenceStatus,
      }),
    );
  }

  const passedCount = cases.filter((caseReport) => caseReport.status === "passed").length;
  const failedCount = cases.filter((caseReport) => caseReport.status === "failed").length;
  const skippedCount = cases.filter((caseReport) => caseReport.status === "skipped").length;
  const outcomeRollup = rollupPassOutcomeCounts(cases);
  const failureCategoryCounts = aggregateFailureCategoryCounts(cases);
  const report = LiveFactShadowReportSchema.parse({
    schemaVersion: LIVE_FACT_SHADOW_REPORT_SCHEMA_VERSION,
    generatedAt,
    status: "completed",
    liveEvidenceStatus: discoveryWasInjected || !selected.liveEvidence ? "test_only_injected" : "live_provider",
    providerId,
    modelId,
    route,
    caseCount: cases.length,
    passedCount,
    failedCount,
    skippedCount,
    firstPassCases: outcomeRollup.firstPassCases,
    repairPassCases: outcomeRollup.repairPassCases,
    failedAfterRepairCases: outcomeRollup.failedAfterRepairCases,
    failureCategoryCounts,
    cases,
    notes: [
      "Phase 2F live shadow is opt-in, non-mutating, and writes only .rector/evidence/phase2 report artifacts.",
      discoveryWasInjected || !selected.liveEvidence
        ? "Provider was dependency-injected for deterministic contract tests and must not be counted as live verification."
        : "Provider was discovered through explicit live environment/configuration and is not a fake/spy/deterministic double.",
      "Model claims remain shadow evidence only; schema/provenance/grounding checks decide case results.",
    ],
  });
  return writeReport(report, { outputDir, write, mkdir, writeFile });
}

async function runScenario(
  scenario: LiveScenario,
  provider: LLMProvider,
  context: {
    readonly providerId: string;
    readonly modelId: string;
    readonly route: ModelRoute;
    readonly outputDir: string;
    readonly readFile: typeof fs.readFile;
    readonly writeFile: typeof fs.writeFile;
    readonly mkdir: typeof fs.mkdir;
    readonly write: boolean;
    readonly now: () => Date;
    readonly strictEvidenceStatus: StrictJsonEvidenceStatus;
  },
): Promise<LiveFactShadowCaseReport> {
  const started = Date.now();
  const rawArtifactRefs = scenario.fixtureArtifactUri ? [scenario.fixtureArtifactUri] : [];
  const artifactText = scenario.fixturePath ? await context.readFile(path.join(REPO_ROOT, scenario.fixturePath), "utf8") : "";
  const outputArtifact = ArtifactRefSchema.parse({
    refType: "artifact",
    uri: `artifact://live-fact-shadow/${scenario.id}-model-output.json`,
    contentType: "application/json",
  });
  rawArtifactRefs.push(outputArtifact.uri);

  const attemptResponses: Array<LLMResponse | undefined> = [];
  const loopResult = await runBoundedStrictJsonRepairLoop<CaseEvaluation>({
    operation: `live-fact-shadow:${scenario.id}`,
    maxAttempts: 2,
    catchAttemptErrors: true,
    call: async (attemptContext) => {
      const repairAppendix =
        attemptContext.attemptKind === "repair"
          ? `\n\n${STRICT_JSON_REPAIR_OUTPUT_RULES}\n\n${renderStrictJsonRepairCards(attemptContext.priorDiagnostics)}`
          : "";
      let response: LLMResponse | undefined;
      try {
        response = await provider.invoke(
          buildRequest(scenario, context.modelId, context.route, artifactText, repairAppendix),
          {},
        );
      } catch {
        response = undefined;
      }
      attemptResponses.push(response);
      const metadata: StrictOutputRuntimeMetadata | undefined = response
        ? {
            provider: response.provider,
            model: response.model,
            finishReason: response.finishReason,
            outputChars: response.content.length,
            maxOutputTokens: 800,
          }
        : {
            provider: context.providerId,
            model: context.modelId,
            finishReason: "error",
            errorCode: "provider_invocation_failed",
            errorMessage: "Provider invocation failed during live fact shadow attempt",
          };
      return {
        content: response?.content ?? "",
        metadata,
        evidenceStatus: context.strictEvidenceStatus,
      };
    },
    validate: (value, attemptContext) => validateShadowParsedOutput(value, scenario, {
      outputArtifact,
      fixtureArtifactUri: scenario.fixtureArtifactUri,
      generatedAt: context.now().toISOString(),
      providerId: context.providerId,
      modelId: context.modelId,
      attemptKind: attemptContext.attemptKind,
    }),
  });

  const latencyMs = Math.max(0, Date.now() - started);
  const evaluation =
    loopResult.status === "passed"
      ? loopResult.value
      : evaluateModelOutput({
          scenario,
          content: attemptResponses[attemptResponses.length - 1]?.content ?? "",
          outputArtifact,
          fixtureArtifactUri: scenario.fixtureArtifactUri,
          generatedAt: context.now().toISOString(),
          providerId: context.providerId,
          modelId: context.modelId,
        });

  const failureReasons: string[] = [];
  if (loopResult.status === "failed") {
    const providerFailures = loopResult.diagnostics.filter((diagnostic) => diagnostic.kind === "provider_runtime");
    if (providerFailures.length > 0 && attemptResponses.every((response) => response === undefined)) {
      failureReasons.push(
        `provider invocation failed: ${providerFailures[providerFailures.length - 1]?.message ?? "unknown provider error"}`,
      );
    }
    failureReasons.push(...caseFailureReasons(scenario, evaluation));
    if (failureReasons.length === 0) {
      failureReasons.push("strict JSON repair loop failed without case-specific failure reasons");
    }
  }

  const usage = attemptResponses.reduce(
    (total, response) => mergeUsage(total, response?.usage ?? ZERO_USAGE),
    ZERO_USAGE,
  );
  const status = loopResult.status === "passed" ? "passed" : "failed";
  const passClassification = passClassificationFromRepairLoop(loopResult.status, loopResult.classification);
  const attempts = attemptSummariesFromStrictJsonAttempts(loopResult.attempts);
  const lastResponse = attemptResponses[attemptResponses.length - 1];

  if (context.write) {
    const rawDir = path.join(context.outputDir, RAW_MODEL_OUTPUT_DIR);
    await context.mkdir(rawDir, { recursive: true });
    const artifactPayload = sanitizeEvidencePayload({
      caseId: scenario.id,
      passClassification,
      attempts: loopResult.attempts.map((attempt) => ({
        attemptNumber: attempt.attemptNumber,
        attemptKind: attempt.attemptKind,
        jsonParsed: attempt.jsonParsed,
        diagnosticSummary: attempt.diagnosticSummary,
      })),
      responses: attemptResponses.map((response) => (response ? sanitizeResponse(response) : null)),
      failureReasons,
    });
    await context.writeFile(path.join(rawDir, `${scenario.id}.json`), `${JSON.stringify(artifactPayload, null, 2)}\n`, "utf8");
  }

  return LiveFactShadowCaseReportSchema.parse({
    caseId: scenario.id,
    title: scenario.title,
    status,
    passClassification,
    providerId: context.providerId,
    modelId: lastResponse?.model ?? context.modelId,
    route: context.route,
    schemaValidity: evaluation.schemaValidity,
    provenanceCompleteness: evaluation.provenanceCompleteness,
    hallucinatedRefs: [...evaluation.hallucinatedRefs],
    insufficientEvidenceCorrect: evaluation.insufficientEvidenceCorrect,
    tokenUsage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      modelCalls: usage.modelCalls,
    },
    estimatedCostUsd: usage.estimatedUsd,
    latencyMs,
    rawArtifactRefs,
    factRefs: evaluation.facts.map((fact) => ({ factId: fact.factId, kind: fact.kind, trustLevel: fact.trust.level })),
    validationErrors: validationErrorsForReport(evaluation.errors),
    failureReasons,
    attempts,
  });
}

function validateShadowParsedOutput(
  value: unknown,
  scenario: LiveScenario,
  context: {
    readonly outputArtifact: ArtifactRef;
    readonly fixtureArtifactUri?: string;
    readonly generatedAt: string;
    readonly providerId: string;
    readonly modelId: string;
    readonly attemptKind: "first" | "repair";
  },
): StrictJsonValidationResult<CaseEvaluation> {
  if (!isRecord(value)) {
    return {
      ok: false,
      diagnostics: diagnosticsFromShadowCaseEvaluation(emptyEvaluation(), { expectInsufficientEvidence: scenario.expectInsufficientEvidence }),
    };
  }
  const evaluation = evaluateParsedShadowOutput({
    scenario,
    parsed: value as RawShadowOutput,
    outputArtifact: context.outputArtifact,
    fixtureArtifactUri: context.fixtureArtifactUri,
    generatedAt: context.generatedAt,
    providerId: context.providerId,
    modelId: context.modelId,
  });
  const diagnostics = diagnosticsFromShadowCaseEvaluation(evaluation, { expectInsufficientEvidence: scenario.expectInsufficientEvidence });
  const caseReasons = caseFailureReasons(scenario, evaluation);
  if (caseReasons.length === 0) {
    return { ok: true, value: evaluation, diagnostics };
  }
  return { ok: false, diagnostics };
}

function mergeUsage(left: LLMUsage, right: LLMUsage): LLMUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    estimatedUsd: left.estimatedUsd + right.estimatedUsd,
    modelCalls: left.modelCalls + right.modelCalls,
  };
}

function buildRequest(
  scenario: LiveScenario,
  model: string,
  route: ModelRoute,
  artifactText: string,
  repairAppendix = "",
): LLMRequest {
  const contract = buildLiveFactShadowSystemContract();
  const scenarioGuidance = buildLiveFactShadowScenarioGuidance({
    id: scenario.id,
    expectedKinds: scenario.expectedKinds,
  });
  const artifactBlock = artifactText ? `\n\nCommitted raw artifact:\n---\n${artifactText.slice(0, 12_000)}\n---` : "";
  return {
    task: `phase-2f-live-fact-shadow:${scenario.id}`,
    route: "FACT_SHADOW",
    modelRoute: route,
    model,
    maxOutputTokens: 800,
    temperature: 0,
    responseFormat: { type: "json_object" },
    metadata: { caseId: scenario.id, nonMutating: true, createdBy: CREATED_BY },
    messages: [
      { role: "system", content: contract },
      {
        role: "user",
        content: `${scenario.prompt}\n\n${scenarioGuidance}${artifactBlock}${repairAppendix}`,
      },
    ],
  };
}

function evaluateModelOutput(input: {
  readonly scenario: LiveScenario;
  readonly content: string;
  readonly outputArtifact: ArtifactRef;
  readonly fixtureArtifactUri?: string;
  readonly generatedAt: string;
  readonly providerId: string;
  readonly modelId: string;
}): CaseEvaluation {
  const parsed = parseJsonObject(input.content);
  if (!parsed) {
    return {
      facts: [],
      errors: [{ code: "model_json_invalid", message: "Model response was not parseable JSON", path: [], severity: "error" }],
      schemaValidity: false,
      provenanceCompleteness: false,
      hallucinatedRefs: [],
      insufficientEvidenceCorrect: input.scenario.expectInsufficientEvidence ? false : null,
    };
  }
  return evaluateParsedShadowOutput({ ...input, parsed });
}

function evaluateParsedShadowOutput(input: {
  readonly scenario: LiveScenario;
  readonly parsed: RawShadowOutput;
  readonly outputArtifact: ArtifactRef;
  readonly fixtureArtifactUri?: string;
  readonly generatedAt: string;
  readonly providerId: string;
  readonly modelId: string;
}): CaseEvaluation {
  const proposedFacts = proposalFacts(input.parsed).map((draft, index) => normalizeFactDraft(draft, { ...input, index }));
  const validFacts: RectorFact[] = [];
  const errors: FactValidationError[] = [];
  const hallucinatedRefs: string[] = [];

  for (const fact of proposedFacts) {
    const parsedFact = RectorFactSchema.safeParse(fact);
    if (!parsedFact.success) {
      errors.push(...parsedFact.error.issues.map((issue) => ({ code: issue.code, message: issue.message, path: issue.path, severity: "error" as const })));
      continue;
    }
    const validationChecks = [
      validateFactSchema(parsedFact.data),
      validateFactProvenance(parsedFact.data),
      validateFactArtifactRefs(parsedFact.data),
      validateFactGrounding(parsedFact.data),
      validateFactScope(parsedFact.data),
      validateFactRedactionState(parsedFact.data),
      validateFactTrustTransition({ fact: parsedFact.data }),
    ];
    const validationErrors = validationChecks.flatMap((check) => [...check.errors]);
    if (validationErrors.length > 0) {
      errors.push(...validationErrors);
    } else {
      validFacts.push(parsedFact.data);
    }
    hallucinatedRefs.push(...detectHallucinatedRefs(parsedFact.data, input.scenario));
  }

  const hasSchemaValidExpectedKind = validFacts.some((fact) => input.scenario.expectedKinds.includes(fact.kind));
  const insufficientEvidenceCorrect = input.scenario.expectInsufficientEvidence
    ? validFacts.some((fact) => fact.trust.level === "insufficient_evidence" || hasInsufficientEvidenceRef(fact))
    : null;
  return {
    facts: validFacts,
    errors,
    schemaValidity: hasSchemaValidExpectedKind && errors.filter((entry) => entry.code === "invalid_union_discriminator" || entry.code === "invalid_type").length === 0,
    provenanceCompleteness: validFacts.length > 0 && validFacts.every((fact) => validateFactProvenance(fact).ok),
    hallucinatedRefs: [...new Set(hallucinatedRefs)],
    insufficientEvidenceCorrect,
  };
}

function proposalFacts(parsed: RawShadowOutput): FactDraft[] {
  if (Array.isArray(parsed.facts)) return parsed.facts.filter(isRecord).map((entry) => ({ ...entry }));
  if (parsed.insufficient_evidence === true || isRecord(parsed.insufficient_evidence)) {
    return [{ kind: "capability_failure", capabilityId: "live_shadow", reason: "insufficient evidence", retryable: false, evidence: [{ refType: "insufficient_evidence", reason: "model reported insufficient evidence", missing: ["grounded source artifact"], searched: [] }] }];
  }
  return [];
}

function normalizeFactDraft(draft: FactDraft, context: {
  readonly scenario: LiveScenario;
  readonly outputArtifact: ArtifactRef;
  readonly fixtureArtifactUri?: string;
  readonly generatedAt: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly index: number;
}): Record<string, unknown> {
  const kind = typeof draft.kind === "string" ? draft.kind : "capability_failure";
  const fixtureArtifact = context.fixtureArtifactUri ? ArtifactRefSchema.parse({ refType: "artifact", uri: context.fixtureArtifactUri, contentType: "text/plain" }) : undefined;
  const provenance = [
    { sourceType: "llm_shadow" as const, providerId: context.providerId, modelId: context.modelId, artifact: context.outputArtifact },
    ...(fixtureArtifact ? [{ sourceType: "artifact" as const, artifact: fixtureArtifact }] : []),
  ];
  const base = {
    schemaVersion: "rector.fact.v1",
    kind,
    runId: "run-live-fact-shadow",
    taskId: context.scenario.id,
    createdAt: context.generatedAt,
    producer: "llm_shadow" as const,
    provenance,
    trust: kind === "capability_failure" && containsInsufficientEvidence(draft)
      ? createFactTrust("insufficient_evidence", "Model explicitly reported insufficient evidence in live shadow")
      : createFactTrust("schema_valid", "Live shadow output was parsed into a typed fact but remains untrusted shadow evidence"),
    scope: createFactScope({ scopeType: "run", taskIds: [context.scenario.id] }),
    redactionState: "redacted" as const,
  };

  const normalized = { ...base, ...pickAllowedFields(kind, draft) };
  return { ...normalized, factId: createFactId({ ...normalized, proposalIndex: context.index }) };
}

function pickAllowedFields(kind: string, draft: FactDraft): Record<string, unknown> {
  if (kind === "intent") return { intent: stringField(draft.intent, "unspecified intent"), ...(numberField(draft.confidence) !== undefined ? { confidence: numberField(draft.confidence) } : {}) };
  if (kind === "task_constraint") return { constraint: stringField(draft.constraint, "Do not mutate source files during live shadow") };
  if (kind === "unknown_or_ambiguity") return { question: stringField(draft.question, "What evidence is missing?"), options: stringArray(draft.options) };
  if (kind === "capability_evidence") return { capabilityId: stringField(draft.capabilityId, "live_shadow"), summary: stringField(draft.summary, "Live shadow evidence extraction"), evidence: evidenceArray(draft.evidence) };
  if (kind === "capability_warning") return { capabilityId: stringField(draft.capabilityId, "live_shadow"), warning: stringField(draft.warning, "Live shadow warning"), severity: severityField(draft.severity) };
  if (kind === "capability_failure") return { capabilityId: stringField(draft.capabilityId, "live_shadow"), reason: stringField(draft.reason, "Insufficient evidence"), retryable: booleanField(draft.retryable, false), evidence: evidenceArray(draft.evidence) };
  return { capabilityId: "live_shadow", reason: `Unsupported model fact kind: ${kind}`, retryable: false, evidence: [{ refType: "insufficient_evidence", reason: "unsupported fact kind", missing: [kind], searched: [] }] };
}

function evidenceArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [{ refType: "insufficient_evidence", reason: "model omitted evidence refs", missing: ["evidence"], searched: [] }];
  return value.filter(isRecord).map((entry) => {
    if (entry.refType === "source_span") {
      return { refType: "source_span", path: stringField(entry.path, "unknown"), startLine: integerField(entry.startLine, 1), endLine: integerField(entry.endLine, integerField(entry.startLine, 1)) };
    }
    if (entry.refType === "insufficient_evidence") {
      return { refType: "insufficient_evidence", reason: stringField(entry.reason, "insufficient evidence"), missing: stringArray(entry.missing), searched: stringArray(entry.searched) };
    }
    return entry;
  });
}

function detectHallucinatedRefs(fact: RectorFact, scenario: LiveScenario): string[] {
  if (!scenario.fixturePath) return [];
  const allowed = allowedRefsForScenario(scenario.id);
  const refs: string[] = [];
  collectSourceSpanRefs(fact, refs);
  return refs.filter((ref) => !allowed.has(ref));
}

function allowedRefsForScenario(caseId: string): ReadonlySet<string> {
  if (caseId === "rg_artifact_evidence_extraction") return new Set(["src/notes.md:1", "src/notes.md:3"]);
  if (caseId === "test_log_diagnosis") return new Set(["/tmp/vitest-case/failing.test.ts:1", "tests/**/*.test.ts:1"]);
  if (caseId === "tsc_diagnostic_grouping") return new Set(["src/index.ts:2"]);
  return new Set<string>();
}

function collectSourceSpanRefs(value: unknown, refs: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectSourceSpanRefs(item, refs);
    return;
  }
  if (!isRecord(value)) return;
  if (value.refType === "source_span" && typeof value.path === "string" && typeof value.startLine === "number") refs.push(`${value.path}:${value.startLine}`);
  for (const nested of Object.values(value)) collectSourceSpanRefs(nested, refs);
}

function caseFailureReasons(scenario: LiveScenario, evaluation: CaseEvaluation): string[] {
  const reasons: string[] = [];
  if (!evaluation.schemaValidity) reasons.push("no schema-valid expected fact was produced");
  if (!evaluation.provenanceCompleteness) reasons.push("provenance completeness check failed");
  if (evaluation.hallucinatedRefs.length > 0) reasons.push(`hallucinated refs: ${evaluation.hallucinatedRefs.join(", ")}`);
  if (scenario.expectInsufficientEvidence && evaluation.insufficientEvidenceCorrect !== true) reasons.push("insufficient_evidence correctness failed");
  return reasons;
}

function skippedReport(generatedAt: string, skippedReason: string): LiveFactShadowReport {
  const cases = liveFactShadowScenarios().map((scenario) => LiveFactShadowCaseReportSchema.parse({
    caseId: scenario.id,
    title: scenario.title,
    status: "skipped",
    passClassification: classifySkippedCasePassClassification(),
    providerId: null,
    modelId: null,
    route: scenario.route,
    schemaValidity: false,
    provenanceCompleteness: false,
    hallucinatedRefs: [],
    insufficientEvidenceCorrect: scenario.expectInsufficientEvidence ? false : null,
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, modelCalls: 0 },
    estimatedCostUsd: 0,
    latencyMs: 0,
    rawArtifactRefs: scenario.fixtureArtifactUri ? [scenario.fixtureArtifactUri] : [],
    factRefs: [],
    validationErrors: [],
    failureReasons: [skippedReason],
    attempts: [],
  }));
  const failureCategoryCounts = aggregateFailureCategoryCounts(cases);
  return LiveFactShadowReportSchema.parse({
    schemaVersion: LIVE_FACT_SHADOW_REPORT_SCHEMA_VERSION,
    generatedAt,
    status: "skipped",
    liveEvidenceStatus: "skipped",
    skippedReason,
    providerId: null,
    modelId: null,
    route: null,
    caseCount: cases.length,
    passedCount: 0,
    failedCount: 0,
    skippedCount: cases.length,
    firstPassCases: 0,
    repairPassCases: 0,
    failedAfterRepairCases: 0,
    failureCategoryCounts,
    cases,
    notes: [
      "Live fact shadow did not run model calls; this is an honest skipped report.",
      "Set LIVE_FACT_EVALS=1 and configure a non-fake live provider to run the shadow suite.",
      "Reports are written under .rector/evidence/phase2 by default.",
    ],
  });
}

async function writeReport(report: LiveFactShadowReport, io: { readonly outputDir: string; readonly write: boolean; readonly mkdir: typeof fs.mkdir; readonly writeFile: typeof fs.writeFile }): Promise<LiveFactShadowReport> {
  const safeReport = LiveFactShadowReportSchema.parse(sanitizeEvidenceStringLeaves(report));
  if (!io.write) return safeReport;
  await io.mkdir(io.outputDir, { recursive: true });
  await io.writeFile(path.join(io.outputDir, REPORT_JSON), `${JSON.stringify(safeReport, null, 2)}\n`, "utf8");
  await io.writeFile(path.join(io.outputDir, REPORT_MD), renderLiveFactShadowMarkdown(safeReport), "utf8");
  await io.writeFile(path.join(io.outputDir, SUMMARY_JSON), `${JSON.stringify(buildLiveFactShadowSummary(safeReport), null, 2)}\n`, "utf8");
  return safeReport;
}

function buildLiveFactShadowSummary(report: LiveFactShadowReport): import("zod").infer<typeof LiveFactShadowSummarySchema> {
  const totalTokenUsage = report.cases.reduce(
    (total, caseReport) => ({
      inputTokens: total.inputTokens + caseReport.tokenUsage.inputTokens,
      outputTokens: total.outputTokens + caseReport.tokenUsage.outputTokens,
      totalTokens: total.totalTokens + caseReport.tokenUsage.totalTokens,
      modelCalls: total.modelCalls + caseReport.tokenUsage.modelCalls,
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0, modelCalls: 0 },
  );
  const totalEstimatedCostUsd = report.cases.reduce(
    (total, caseReport) => total + caseReport.estimatedCostUsd,
    0,
  );
  return LiveFactShadowSummarySchema.parse({
    schemaVersion: LIVE_FACT_SHADOW_SUMMARY_SCHEMA_VERSION,
    generatedAt: report.generatedAt,
    status: report.status,
    liveEvidenceStatus: report.liveEvidenceStatus,
    caseCount: report.caseCount,
    passedCount: report.passedCount,
    failedCount: report.failedCount,
    skippedCount: report.skippedCount,
    firstPassCases: report.firstPassCases,
    repairPassCases: report.repairPassCases,
    failedAfterRepairCases: report.failedAfterRepairCases,
    failureCategoryCounts: report.failureCategoryCounts,
    totalTokenUsage,
    totalEstimatedCostUsd: Math.round(totalEstimatedCostUsd * 1_000_000) / 1_000_000,
    reportJson: REPORT_JSON,
    reportMarkdown: REPORT_MD,
  });
}

export function renderLiveFactShadowMarkdown(report: LiveFactShadowReport): string {
  const lines: string[] = [];
  lines.push("# Live Fact Shadow Report (Phase 2F)", "");
  lines.push(`- Schema: \`${report.schemaVersion}\``);
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Status: ${report.status}`);
  lines.push(`- Live evidence status: ${report.liveEvidenceStatus}`);
  if (report.skippedReason) lines.push(`- Skipped reason: ${report.skippedReason}`);
  lines.push(`- Provider: ${report.providerId ?? "n/a"}`);
  lines.push(`- Model: ${report.modelId ?? "n/a"}`);
  lines.push(`- Route: ${report.route ?? "n/a"}`);
  lines.push(`- Cases: ${report.passedCount} passed / ${report.failedCount} failed / ${report.skippedCount} skipped`);
  lines.push(
    `- Outcomes: ${report.firstPassCases} first-pass / ${report.repairPassCases} repair-pass / ${report.failedAfterRepairCases} failed-after-repair`,
  );
  lines.push(
    `- Failure categories (failed cases): schema/semantic=${report.failureCategoryCounts.semanticOrSchema}, grounding/provenance=${report.failureCategoryCounts.groundingOrProvenance}, provider/runtime=${report.failureCategoryCounts.providerOrRuntime}`,
  );
  lines.push("", "## Safety Notes", "");
  for (const note of report.notes) lines.push(`> ${safeMarkdown(note)}`);
  lines.push("", "## Cases", "");
  lines.push("| case | status | pass class | attempts | provider | model | route | schema valid | provenance complete | hallucinated refs | insufficient evidence correct | tokens | cost usd | latency ms | raw artifact refs |");
  lines.push("| --- | --- | --- | ---: | --- | --- | --- | --- | --- | ---: | --- | ---: | ---: | ---: | --- |");
  for (const caseReport of report.cases) {
    lines.push(`| \`${safeMarkdown(caseReport.caseId)}\` | ${caseReport.status} | ${caseReport.passClassification} | ${caseReport.attempts.length} | ${safeMarkdown(caseReport.providerId ?? "n/a")} | ${safeMarkdown(caseReport.modelId ?? "n/a")} | ${safeMarkdown(caseReport.route)} | ${caseReport.schemaValidity} | ${caseReport.provenanceCompleteness} | ${caseReport.hallucinatedRefs.length} | ${String(caseReport.insufficientEvidenceCorrect)} | ${caseReport.tokenUsage.totalTokens} | ${caseReport.estimatedCostUsd.toFixed(6)} | ${caseReport.latencyMs} | ${safeMarkdown(caseReport.rawArtifactRefs.join(", ") || "n/a")} |`);
  }
  lines.push("", "## Failures", "");
  const failures = report.cases.filter((caseReport) => caseReport.status === "failed" && caseReport.failureReasons.length > 0);
  if (failures.length === 0) lines.push("No case failures recorded.");
  for (const failure of failures) {
    lines.push(`- \`${safeMarkdown(failure.caseId)}\``);
    for (const reason of failure.failureReasons) lines.push(`  - ${safeMarkdown(reason)}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function emptyEvaluation(): CaseEvaluation {
  return { facts: [], errors: [], schemaValidity: false, provenanceCompleteness: false, hallucinatedRefs: [], insufficientEvidenceCorrect: null };
}

function parseJsonObject(content: string): RawShadowOutput | undefined {
  try {
    const parsed = JSON.parse(content);
    return isRecord(parsed) ? parsed as RawShadowOutput : undefined;
  } catch {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start === -1 || end <= start) return undefined;
    try {
      const parsed = JSON.parse(content.slice(start, end + 1));
      return isRecord(parsed) ? parsed as RawShadowOutput : undefined;
    } catch {
      return undefined;
    }
  }
}

function hasInsufficientEvidenceRef(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasInsufficientEvidenceRef);
  if (!isRecord(value)) return false;
  if (value.refType === "insufficient_evidence") return true;
  return Object.values(value).some(hasInsufficientEvidenceRef);
}

function containsInsufficientEvidence(draft: FactDraft): boolean {
  return hasInsufficientEvidenceRef(draft) || draft.insufficient_evidence === true;
}

function modelForRoute(provider: LLMProvider, route: ModelRoute): string {
  return provider.metadata.models[route] ?? provider.metadata.models.fast ?? Object.values(provider.metadata.models)[0] ?? provider.metadata.id;
}

function sanitizeResponse(response: LLMResponse): Record<string, unknown> {
  return sanitizeEvidencePayload({
    provider: response.provider,
    model: response.model,
    finishReason: response.finishReason,
    usage: response.usage,
    content: response.content.slice(0, 20_000),
  });
}

function safeMarkdown(value: string): string {
  return value.replace(/[|\n\r]/g, " ").slice(0, 240);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, 500) : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim().slice(0, 240)) : [];
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : undefined;
}

function integerField(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function booleanField(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function severityField(value: unknown): "low" | "medium" | "high" {
  return value === "low" || value === "medium" || value === "high" ? value : "medium";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLiveFactShadow().then((report) => {
    console.log(JSON.stringify({ status: report.status, liveEvidenceStatus: report.liveEvidenceStatus, skippedReason: report.skippedReason, reportPath: path.join(DEFAULT_OUTPUT_DIR, REPORT_JSON) }));
    if (report.status !== "completed" || report.liveEvidenceStatus !== "live_provider" || report.failedCount > 0) process.exitCode = 1;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
