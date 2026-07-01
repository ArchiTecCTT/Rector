import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { getZaiLiveEvidenceDir, sanitizeEvidenceStringLeaves } from "../evidence";
import {
  ProviderError,
  type LLMRequest,
  type LLMResponse,
  type LLMUsage,
} from "../providers";
import {
  renderStrictJsonRepairCards,
  STRICT_JSON_REPAIR_OUTPUT_RULES,
} from "../orchestration/strictJsonRepairCards";
import {
  runBoundedStrictJsonRepairLoop,
  type StrictJsonAttemptReport,
  type StrictJsonEvidenceStatus,
  type StrictJsonPassClassification,
} from "../orchestration/strictJsonRepairLoop";
import {
  createStrictOutputDiagnostic,
  projectSafeStrictOutputDiagnostics,
  type StrictOutputRuntimeMetadata,
} from "../orchestration/strictOutputDiagnostics";
import { redactString } from "../security/redaction";
import {
  isAcceptableLiveEvidenceProvider,
  isZaiCompatibleHost,
  type DiscoveredLiveProvider,
  type LiveProviderDiscoveryResult,
  type LiveProviderRejection,
} from "./liveProviderDiscovery";
import { discoverLiveProviderFromRepo } from "./repoLiveProviderDiscovery";
import {
  buildZaiLiveDiagnostics,
  classifyLiveProviderFailureFromError,
  renderZaiLiveDiagnosticsMarkdown,
  ZaiLiveDiagnosticsSchema,
  type ZaiLiveDiagnostics,
  type ZaiLiveProviderFailureTaxonomy,
} from "./liveHarnessDiagnostics";

export const ZAI_PROVIDER_SMOKE_REPORT_SCHEMA_VERSION = "rector.zai-provider-smoke.v1";

const SmokeTokenUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    modelCalls: z.number().int().nonnegative(),
  })
  .strict();

const SmokeErrorSchema = z
  .object({
    kind: z.enum([
      "provider_config",
      "rate_limit",
      "quota",
      "provider_http",
      "provider_timeout",
      "provider_json",
      "provider_unknown",
    ]),
    message: z.string().min(1),
    host: z.string().min(1).optional(),
    providerCode: z.string().min(1).optional(),
    status: z.number().int().positive().optional(),
    retryable: z.boolean().optional(),
    taxonomy: z.string().min(1).optional(),
  })
  .strict();

export const ZAI_PROVIDER_SMOKE_PASS_CLASSIFICATIONS = [
  "first_pass",
  "repair_pass",
  "failed_after_repair",
] as const;

const ZaiProviderSmokeSafeDiagnosticSchema = z
  .object({
    kind: z.enum([
      "json_syntax",
      "schema",
      "semantic_invariant",
      "provenance",
      "grounding",
      "scope",
      "redaction",
      "truncation",
      "provider_runtime",
    ]),
    code: z.string().min(1),
    path: z.string().min(1),
    severity: z.enum(["error", "warning", "info"]),
  })
  .strict();

const ZaiProviderSmokeAttemptSummarySchema = z
  .object({
    attemptNumber: z.union([z.literal(1), z.literal(2)]),
    attemptKind: z.enum(["first", "repair"]),
    jsonParsed: z.boolean(),
    safeDiagnostics: z.array(ZaiProviderSmokeSafeDiagnosticSchema),
  })
  .strict();

export const ZaiProviderSmokeReportSchema = z
  .object({
    schemaVersion: z.literal(ZAI_PROVIDER_SMOKE_REPORT_SCHEMA_VERSION),
    generatedAt: z.string().datetime(),
    status: z.enum(["passed", "failed", "skipped"]),
    liveEvidenceStatus: z.enum(["live_provider", "test_only_injected", "skipped"]),
    skippedReason: z.string().min(1).optional(),
    providerId: z.string().min(1).nullable(),
    adapterId: z.string().min(1).nullable(),
    modelId: z.string().min(1).nullable(),
    host: z.string().min(1).nullable(),
    tokenUsage: SmokeTokenUsageSchema,
    estimatedCostUsd: z.number().nonnegative(),
    latencyMs: z.number().int().nonnegative(),
    error: SmokeErrorSchema.optional(),
    passClassification: z.enum(ZAI_PROVIDER_SMOKE_PASS_CLASSIFICATIONS).optional(),
    attempts: z.array(ZaiProviderSmokeAttemptSummarySchema).optional(),
    diagnostics: ZaiLiveDiagnosticsSchema,
    notes: z.array(z.string().min(1)),
  })
  .strict();

export type ZaiProviderSmokeReport = Readonly<z.infer<typeof ZaiProviderSmokeReportSchema>>;

export interface ZaiProviderSmokeOptions {
  readonly outputDir?: string;
  readonly repoRoot?: string;
  readonly write?: boolean;
  readonly env?: Record<string, string | undefined>;
  readonly now?: () => Date;
  readonly providerDiscovery?: (env: Record<string, string | undefined>) => Promise<LiveProviderDiscoveryResult> | LiveProviderDiscoveryResult;
  readonly timeoutMs?: number;
  readonly mkdir?: typeof fs.mkdir;
  readonly writeFile?: typeof fs.writeFile;
}

const ZERO_USAGE: LLMUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedUsd: 0, modelCalls: 0 };
const REPORT_JSON = "provider-smoke.json";
const REPORT_MD = "provider-smoke.md";
const DEFAULT_TIMEOUT_MS = 30_000;

export async function runZaiProviderSmoke(options: ZaiProviderSmokeOptions = {}): Promise<ZaiProviderSmokeReport> {
  const env = options.env ?? process.env;
  const outputDir = options.outputDir ?? getZaiLiveEvidenceDir(options.repoRoot);
  const write = options.write ?? true;
  const mkdir = options.mkdir ?? fs.mkdir;
  const writeFile = options.writeFile ?? fs.writeFile;
  const generatedAt = (options.now ?? (() => new Date()))().toISOString();

  if (env.RECTOR_ZAI_PROVIDER_SMOKE !== "1") {
    return writeReport(
      skippedReport(generatedAt, "RECTOR_ZAI_PROVIDER_SMOKE must equal 1; Z.ai provider smoke is opt-in."),
      { outputDir, write, mkdir, writeFile },
    );
  }

  const discoveryWasInjected = options.providerDiscovery !== undefined;
  const discovery =
    options.providerDiscovery
    ?? ((currentEnv: Record<string, string | undefined>) => discoverLiveProviderFromRepo(options.repoRoot, currentEnv));
  const discovered = await discovery(env);
  const selected = discovered.selected;
  if (!selected) {
    if (discovered.rejections.length > 0) {
      return writeReport(
        failedReportFromRejection(generatedAt, discovered.rejections[0]),
        { outputDir, write, mkdir, writeFile },
      );
    }
    return writeReport(
      skippedReport(generatedAt, "No configured Z.ai OpenAI-compatible live provider was available."),
      { outputDir, write, mkdir, writeFile },
    );
  }

  const liveEvidenceStatus = discoveryWasInjected || !selected.liveEvidence ? "test_only_injected" : "live_provider";
  const configError = validateSelectedProvider(selected);
  if (configError) {
    return writeReport(
      baseReport(generatedAt, "failed", liveEvidenceStatus, selected, ZERO_USAGE, 0, configError),
      { outputDir, write, mkdir, writeFile },
    );
  }

  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const strictEvidenceStatus: StrictJsonEvidenceStatus = liveEvidenceStatus;
  let aggregatedUsage = ZERO_USAGE;

  let loopResult: Awaited<ReturnType<typeof runBoundedStrictJsonRepairLoop<Record<string, unknown>>>>;
  try {
    loopResult = await runBoundedStrictJsonRepairLoop<Record<string, unknown>>({
      operation: "zai-provider-smoke",
      maxAttempts: 2,
      catchAttemptErrors: false,
      call: async (attemptContext) => {
        const repairAppendix =
          attemptContext.attemptKind === "repair"
            ? `\n\n${STRICT_JSON_REPAIR_OUTPUT_RULES}\n\n${renderStrictJsonRepairCards(attemptContext.priorDiagnostics)}`
            : "";
        const response = await invokeWithTimeout(
          selected,
          timeoutMs,
          buildSmokeRequest(selected, repairAppendix),
        );
        aggregatedUsage = sumTokenUsage(aggregatedUsage, response.usage);
        const metadata: StrictOutputRuntimeMetadata = {
          provider: response.provider,
          model: response.model,
          finishReason: response.finishReason,
          outputChars: response.content.length,
          maxOutputTokens: 64,
        };
        return {
          content: response.content,
          metadata,
          evidenceStatus: strictEvidenceStatus,
        };
      },
      validate: (value) => validateSmokeJsonObject(value),
    });
  } catch (error) {
    const latencyMs = Math.max(0, Date.now() - started);
    return writeReport(
      baseReport(generatedAt, "failed", liveEvidenceStatus, selected, aggregatedUsage, latencyMs, classifyProviderError(error, selected.host)),
      { outputDir, write, mkdir, writeFile },
    );
  }

  const latencyMs = Math.max(0, Date.now() - started);
  const passClassification = loopResult.classification;
  const attempts = attemptSummariesFromStrictJsonAttempts(loopResult.attempts);

  if (loopResult.status === "passed") {
    return writeReport(
      baseReport(generatedAt, "passed", liveEvidenceStatus, selected, aggregatedUsage, latencyMs, undefined, {
        passClassification,
        attempts,
      }),
      { outputDir, write, mkdir, writeFile },
    );
  }

  return writeReport(
    baseReport(
      generatedAt,
      "failed",
      liveEvidenceStatus,
      selected,
      aggregatedUsage,
      latencyMs,
      smokeJsonErrorFromLoop(loopResult, selected.host),
      { passClassification, attempts },
    ),
    { outputDir, write, mkdir, writeFile },
  );
}

function buildSmokeRequest(selected: DiscoveredLiveProvider, repairAppendix = ""): LLMRequest {
  return {
    task: "zai-provider-smoke",
    route: "PROVIDER_SMOKE",
    modelRoute: "cheap",
    model: selected.modelId,
    maxOutputTokens: 64,
    temperature: 0,
    responseFormat: { type: "json_object" },
    metadata: { nonMutating: true, createdBy: "zai-provider-smoke" },
    messages: [
      { role: "system", content: "Return only a compact JSON object. Do not use Markdown." },
      {
        role: "user",
        content: `Return {"ok":true,"provider":"zai"}.${repairAppendix}`,
      },
    ],
  };
}

async function invokeWithTimeout(
  selected: DiscoveredLiveProvider,
  timeoutMs: number,
  request: LLMRequest,
): Promise<LLMResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await selected.provider.invoke(request, { abortSignal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function validateSelectedProvider(selected: DiscoveredLiveProvider): z.infer<typeof SmokeErrorSchema> | undefined {
  if (selected.requestedProvider !== "zai" || selected.adapterId !== "openai-compatible" || selected.provider.metadata.id !== "openai-compatible") {
    return {
      kind: "provider_config",
      message: "Z.ai smoke requires an OpenAI-compatible provider selection.",
      host: selected.host,
    };
  }
  if (!isZaiCompatibleHost(selected.host)) {
    return {
      kind: "provider_config",
      message: "Z.ai smoke requires a Z.ai-compatible base URL host.",
      host: selected.host,
    };
  }
  if (!isAcceptableLiveEvidenceProvider({ provider: selected.provider, providerId: selected.providerId, displayName: selected.displayName })) {
    return {
      kind: "provider_config",
      message: "Provider identity is a deterministic, fake, spy, mock, fixture, scripted, or test-double provider.",
      host: selected.host,
    };
  }
  try {
    selected.provider.validateConfig();
    return undefined;
  } catch (error) {
    return {
      kind: "provider_config",
      message: safeMessage(error),
      host: selected.host,
      providerCode: error instanceof ProviderError ? error.code : undefined,
    };
  }
}

function classifyProviderError(error: unknown, host: string): z.infer<typeof SmokeErrorSchema> {
  if (error instanceof ProviderError) {
    if (error.code === "CONFIG_INVALID" || error.code === "NETWORK_DISABLED") {
      return {
        kind: "provider_config",
        message: safeMessage(error),
        host,
        providerCode: error.code,
      };
    }
    const classified = classifyLiveProviderFailureFromError(error);
    return smokeErrorFromClassification(classified, safeMessage(error), host);
  }
  if (isAbortLike(error)) {
    const classified = classifyLiveProviderFailureFromError(error);
    return smokeErrorFromClassification(classified, safeMessage(error), host);
  }
  const classified = classifyLiveProviderFailureFromError(error);
  return smokeErrorFromClassification(classified, safeMessage(error), host);
}

function smokeErrorFromClassification(
  classification: ReturnType<typeof classifyLiveProviderFailureFromError>,
  message: string,
  host: string,
): z.infer<typeof SmokeErrorSchema> {
  return {
    kind: taxonomyToSmokeErrorKind(classification.taxonomy),
    message,
    host,
    taxonomy: classification.taxonomy,
    ...(classification.providerCode ? { providerCode: classification.providerCode } : {}),
    ...(classification.status !== undefined ? { status: classification.status } : {}),
    ...(classification.retryable !== undefined ? { retryable: classification.retryable } : {}),
  };
}

function taxonomyToSmokeErrorKind(taxonomy: ZaiLiveProviderFailureTaxonomy): z.infer<typeof SmokeErrorSchema>["kind"] {
  switch (taxonomy) {
    case "rate_limit":
      return "rate_limit";
    case "quota":
      return "quota";
    case "timeout":
      return "provider_timeout";
    case "provider_http":
      return "provider_http";
    case "provider_json":
      return "provider_json";
    default:
      return "provider_unknown";
  }
}

function validateSmokeJsonObject(value: unknown):
  | Readonly<{ ok: true; value: Record<string, unknown> }>
  | Readonly<{ ok: false; diagnostics: ReturnType<typeof createStrictOutputDiagnostic>[] }> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      diagnostics: [
        createStrictOutputDiagnostic({
          kind: "schema",
          code: "smoke_json_not_object",
          path: [],
          message: "Provider smoke response was JSON but not an object.",
        }),
      ],
    };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

function smokeJsonErrorFromLoop(
  loopResult: Readonly<{ classification: StrictJsonPassClassification; attempts: readonly StrictJsonAttemptReport[] }>,
  host: string,
): z.infer<typeof SmokeErrorSchema> {
  const lastAttempt = loopResult.attempts[loopResult.attempts.length - 1];
  const notObject = lastAttempt?.diagnostics.some((diagnostic) => diagnostic.code === "smoke_json_not_object");
  return {
    kind: "provider_json",
    message: notObject
      ? "Provider smoke response was JSON but not an object."
      : loopResult.classification === "failed_after_repair"
        ? "Provider smoke response was not parseable JSON after bounded repair."
        : "Provider smoke response was not parseable JSON.",
    host,
    taxonomy: "provider_json",
  };
}

function attemptSummariesFromStrictJsonAttempts(
  attempts: readonly StrictJsonAttemptReport[],
): z.infer<typeof ZaiProviderSmokeAttemptSummarySchema>[] {
  return attempts.map((attempt) => ({
    attemptNumber: attempt.attemptNumber === 2 ? 2 : 1,
    attemptKind: attempt.attemptKind,
    jsonParsed: attempt.jsonParsed,
    safeDiagnostics: [...projectSafeStrictOutputDiagnostics(attempt.diagnostics)],
  }));
}

function sumTokenUsage(left: LLMUsage, right: LLMUsage): LLMUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    estimatedUsd: left.estimatedUsd + right.estimatedUsd,
    modelCalls: left.modelCalls + right.modelCalls,
  };
}

function failedReportFromRejection(generatedAt: string, rejection: LiveProviderRejection): ZaiProviderSmokeReport {
  return ZaiProviderSmokeReportSchema.parse({
    schemaVersion: ZAI_PROVIDER_SMOKE_REPORT_SCHEMA_VERSION,
    generatedAt,
    status: "failed",
    liveEvidenceStatus: "skipped",
    providerId: null,
    adapterId: null,
    modelId: null,
    host: rejection.host ?? null,
    tokenUsage: tokenUsage(ZERO_USAGE),
    estimatedCostUsd: 0,
    latencyMs: 0,
    diagnostics: buildProviderSmokeDiagnostics(ZERO_USAGE, 0),
    error: {
      kind: "provider_config",
      message: messageForRejection(rejection),
      ...(rejection.host ? { host: rejection.host } : {}),
    },
    notes: [
      "Z.ai smoke was explicitly enabled but provider discovery rejected the configuration.",
      "Only the host is recorded; API keys, auth headers, and base URL paths are not persisted.",
    ],
  });
}

function skippedReport(generatedAt: string, skippedReason: string): ZaiProviderSmokeReport {
  return ZaiProviderSmokeReportSchema.parse({
    schemaVersion: ZAI_PROVIDER_SMOKE_REPORT_SCHEMA_VERSION,
    generatedAt,
    status: "skipped",
    liveEvidenceStatus: "skipped",
    skippedReason,
    providerId: null,
    adapterId: null,
    modelId: null,
    host: null,
    tokenUsage: tokenUsage(ZERO_USAGE),
    estimatedCostUsd: 0,
    latencyMs: 0,
    diagnostics: buildProviderSmokeDiagnostics(ZERO_USAGE, 0),
    notes: [
      "Z.ai provider smoke did not run model calls.",
      "Set RECTOR_LIVE_PROVIDER=zai and RECTOR_ZAI_PROVIDER_SMOKE=1 with OpenAI-compatible Z.ai credentials to run it.",
    ],
  });
}

function baseReport(
  generatedAt: string,
  status: "passed" | "failed",
  liveEvidenceStatus: "live_provider" | "test_only_injected",
  selected: DiscoveredLiveProvider,
  usage: LLMUsage,
  latencyMs: number,
  error?: z.infer<typeof SmokeErrorSchema>,
  strictJson?: Readonly<{
    passClassification: StrictJsonPassClassification;
    attempts: z.infer<typeof ZaiProviderSmokeAttemptSummarySchema>[];
  }>,
): ZaiProviderSmokeReport {
  const attemptCount = strictJson?.attempts.length ?? (usage.modelCalls > 0 ? 1 : 0);
  return ZaiProviderSmokeReportSchema.parse({
    schemaVersion: ZAI_PROVIDER_SMOKE_REPORT_SCHEMA_VERSION,
    generatedAt,
    status,
    liveEvidenceStatus,
    providerId: selected.providerId,
    adapterId: selected.adapterId,
    modelId: selected.modelId,
    host: selected.host,
    tokenUsage: tokenUsage(usage),
    estimatedCostUsd: usage.estimatedUsd,
    latencyMs,
    diagnostics: buildProviderSmokeDiagnostics(usage, latencyMs, error),
    ...(error ? { error } : {}),
    ...(strictJson?.passClassification ? { passClassification: strictJson.passClassification } : {}),
    ...(strictJson?.attempts ? { attempts: strictJson.attempts } : {}),
    notes: [
      attemptCount <= 1
        ? "Z.ai smoke performs one non-mutating JSON-only chat completion with bounded strict JSON repair on failure."
        : `Z.ai smoke performed ${attemptCount} non-mutating JSON-only chat completion attempts (bounded strict JSON repair).`,
      liveEvidenceStatus === "live_provider"
        ? "Provider was discovered from explicit live configuration and passed the test-double predicate."
        : "Provider was dependency-injected for contract tests and must not be counted as live verification.",
      "Report fields intentionally omit auth headers, API keys, and base URL paths.",
    ],
  });
}

async function writeReport(
  report: ZaiProviderSmokeReport,
  io: { readonly outputDir: string; readonly write: boolean; readonly mkdir: typeof fs.mkdir; readonly writeFile: typeof fs.writeFile },
): Promise<ZaiProviderSmokeReport> {
  const safeReport = ZaiProviderSmokeReportSchema.parse(sanitizeEvidenceStringLeaves(report));
  if (!io.write) return safeReport;
  await io.mkdir(io.outputDir, { recursive: true });
  await io.writeFile(path.join(io.outputDir, REPORT_JSON), `${JSON.stringify(safeReport, null, 2)}\n`, "utf8");
  await io.writeFile(path.join(io.outputDir, REPORT_MD), renderZaiProviderSmokeMarkdown(safeReport), "utf8");
  return safeReport;
}

export function renderZaiProviderSmokeMarkdown(report: ZaiProviderSmokeReport): string {
  const lines: string[] = [];
  lines.push("# Z.ai Provider Smoke", "");
  lines.push(`- Schema: \`${report.schemaVersion}\``);
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Status: ${report.status}`);
  lines.push(`- Live evidence status: ${report.liveEvidenceStatus}`);
  if (report.skippedReason) lines.push(`- Skipped reason: ${safeMarkdown(report.skippedReason)}`);
  lines.push(`- Provider: ${safeMarkdown(report.providerId ?? "n/a")}`);
  lines.push(`- Adapter: ${safeMarkdown(report.adapterId ?? "n/a")}`);
  lines.push(`- Model: ${safeMarkdown(report.modelId ?? "n/a")}`);
  lines.push(`- Host: ${safeMarkdown(report.host ?? "n/a")}`);
  lines.push(`- Tokens: ${report.tokenUsage.totalTokens}`);
  lines.push(`- Cost USD: ${report.estimatedCostUsd.toFixed(6)}`);
  lines.push(`- Latency ms: ${report.latencyMs}`);
  if (report.passClassification) lines.push(`- Pass classification: ${report.passClassification}`);
  if (report.attempts && report.attempts.length > 0) {
    lines.push(`- Attempts: ${report.attempts.length}`);
  }
  lines.push(renderZaiLiveDiagnosticsMarkdown(report.diagnostics).trimEnd());
  if (report.error) {
    lines.push("", "## Error", "");
    lines.push(`- Kind: ${report.error.kind}`);
    lines.push(`- Message: ${safeMarkdown(report.error.message)}`);
    if (report.error.status) lines.push(`- HTTP status: ${report.error.status}`);
    if (report.error.retryable !== undefined) lines.push(`- Retryable: ${report.error.retryable}`);
  }
  lines.push("", "## Notes", "");
  for (const note of report.notes) lines.push(`> ${safeMarkdown(note)}`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function buildProviderSmokeDiagnostics(
  usage: LLMUsage,
  latencyMs: number,
  error?: z.infer<typeof SmokeErrorSchema>,
): ZaiLiveDiagnostics {
  const failureTaxonomy = error?.taxonomy
    ? { [error.taxonomy as ZaiLiveProviderFailureTaxonomy]: 1 }
    : undefined;
  return buildZaiLiveDiagnostics({
    failureTaxonomy,
    providerCallLatencyMs: latencyMs > 0 ? [latencyMs] : [],
    tokens: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      modelCalls: usage.modelCalls,
      estimatedCostUsd: usage.estimatedUsd,
    },
  });
}

function tokenUsage(usage: LLMUsage): z.infer<typeof SmokeTokenUsageSchema> {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    modelCalls: usage.modelCalls,
  };
}

function messageForRejection(rejection: LiveProviderRejection): string {
  if (rejection.message) return redactString(rejection.message);
  if (rejection.reason === "zai_host_required") return "Z.ai live provider requires a Z.ai-compatible base URL host.";
  if (rejection.reason === "missing_env") {
    return "Z.ai live provider requires ZAI_API_KEY, ZAI_BASE_URL, and ZAI_MODEL (or OPENAI_COMPATIBLE_* equivalents).";
  }
  if (rejection.reason === "runtime_not_configured") return "Runtime settings are not configured.";
  if (rejection.reason === "no_configured_zai_provider") return "No configured Z.ai OpenAI-compatible provider was found.";
  return `Z.ai live provider discovery failed: ${rejection.reason}`;
}

function safeMessage(error: unknown): string {
  return redactString(error instanceof Error ? error.message : String(error));
}

function isAbortLike(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { name?: unknown; code?: unknown };
  return record.name === "AbortError" || record.code === "ABORT_ERR";
}

function safeMarkdown(value: string): string {
  return value.replace(/[|\n\r]/g, " ").slice(0, 240);
}
