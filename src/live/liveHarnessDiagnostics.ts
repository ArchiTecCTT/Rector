import { z } from "zod";

import { ProviderError } from "../providers";

export const ZAI_LIVE_DIAGNOSTICS_SCHEMA_VERSION = "rector.zai-live-diagnostics.v2";

/** Operator-facing provider failure taxonomy for live Z.ai paths (harness, smoke, matrix). */
export const ZAI_LIVE_PROVIDER_FAILURE_TAXONOMY = [
  "rate_limit",
  "quota",
  "timeout",
  "provider_http",
  "provider_json",
  "unknown",
] as const;

export type ZaiLiveProviderFailureTaxonomy = (typeof ZAI_LIVE_PROVIDER_FAILURE_TAXONOMY)[number];

/** Likely root-cause bucket for strict live harness failures (operator-facing, redacted). */
export const LIVE_HARNESS_BOTTLENECK_CLASSES = [
  "truncated_json",
  "schema_contract",
  "provider_timeout",
  "orchestration_timeout",
  "context_overflow",
  "max_tokens_rejected",
  "reasoning_content_present",
  "unknown",
] as const;

export type LiveHarnessBottleneckClass = (typeof LIVE_HARNESS_BOTTLENECK_CLASSES)[number];

export const LiveHarnessScenarioDiagnosticsSchema = z
  .object({
    scenarioId: z.string().min(1),
    firstFailingStep: z.string().min(1).optional(),
    bottleneckClass: z.enum(LIVE_HARNESS_BOTTLENECK_CLASSES).optional(),
    configuredMaxRuntimeMs: z.number().int().positive().optional(),
    repairAttemptsByRole: z
      .object({
        planner: z.number().int().nonnegative().optional(),
        skeptic: z.number().int().nonnegative().optional(),
        synthesizer: z.number().int().nonnegative().optional(),
        repair: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    providerCalls: z.number().int().nonnegative().optional(),
  })
  .strict();

export type LiveHarnessScenarioDiagnostics = z.infer<typeof LiveHarnessScenarioDiagnosticsSchema>;

export const NumericAggregateStatsSchema = z
  .object({
    count: z.number().int().nonnegative(),
    min: z.number().nonnegative(),
    max: z.number().nonnegative(),
    avg: z.number().nonnegative(),
    p50: z.number().nonnegative(),
    p95: z.number().nonnegative(),
  })
  .strict();

export type NumericAggregateStats = z.infer<typeof NumericAggregateStatsSchema>;

export const ZaiLiveTokenAggregateSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    modelCalls: z.number().int().nonnegative(),
    estimatedCostUsd: z.number().nonnegative(),
  })
  .strict();

export type ZaiLiveTokenAggregate = z.infer<typeof ZaiLiveTokenAggregateSchema>;

export const ZaiLiveDiagnosticsSchema = z
  .object({
    schemaVersion: z.literal(ZAI_LIVE_DIAGNOSTICS_SCHEMA_VERSION),
    failureTaxonomy: z.record(z.enum(ZAI_LIVE_PROVIDER_FAILURE_TAXONOMY), z.number().int().nonnegative()),
    latencyMs: z
      .object({
        providerCalls: NumericAggregateStatsSchema,
        scenarios: NumericAggregateStatsSchema,
        campaigns: NumericAggregateStatsSchema.optional(),
        matrixSteps: NumericAggregateStatsSchema.optional(),
      })
      .strict(),
    tokens: ZaiLiveTokenAggregateSchema,
    bottleneckTaxonomy: z.record(z.enum(LIVE_HARNESS_BOTTLENECK_CLASSES), z.number().int().nonnegative()),
    harnessMaxRuntimeMs: z.number().int().positive().optional(),
    scenarios: z.array(LiveHarnessScenarioDiagnosticsSchema).optional(),
  })
  .strict();

export type ZaiLiveDiagnostics = z.infer<typeof ZaiLiveDiagnosticsSchema>;

export interface LiveProviderFailureClassification {
  readonly taxonomy: ZaiLiveProviderFailureTaxonomy;
  readonly status?: number;
  readonly retryable?: boolean;
  readonly providerCode?: string;
}

export interface LiveProviderFailureSignal {
  readonly code?: string;
  readonly status?: number;
  readonly message?: string;
  readonly retryable?: boolean;
}

export function emptyFailureTaxonomyCounts(): Record<ZaiLiveProviderFailureTaxonomy, number> {
  return Object.fromEntries(ZAI_LIVE_PROVIDER_FAILURE_TAXONOMY.map((kind) => [kind, 0])) as Record<
    ZaiLiveProviderFailureTaxonomy,
    number
  >;
}

export function emptyBottleneckTaxonomyCounts(): Record<LiveHarnessBottleneckClass, number> {
  return Object.fromEntries(LIVE_HARNESS_BOTTLENECK_CLASSES.map((kind) => [kind, 0])) as Record<
    LiveHarnessBottleneckClass,
    number
  >;
}

export function incrementBottleneckTaxonomy(
  counts: Record<LiveHarnessBottleneckClass, number>,
  bottleneck: LiveHarnessBottleneckClass,
): void {
  counts[bottleneck] += 1;
}

/** Redacted metadata only — never returns reasoning text. */
export function providerRawHasReasoningContent(raw: unknown): boolean {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
  if (!record) return false;
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const first = choices[0];
  if (!first || typeof first !== "object") return false;
  const message = (first as Record<string, unknown>).message;
  if (!message || typeof message !== "object") return false;
  const msg = message as Record<string, unknown>;
  for (const key of ["reasoning_content", "reasoning", "reasoning_details"]) {
    const value = msg[key];
    if (typeof value === "string" && value.trim().length > 0) return true;
    if (Array.isArray(value) && value.length > 0) return true;
  }
  return false;
}

export interface LiveHarnessBottleneckSignal {
  readonly failureKind?: string;
  readonly failureMessage?: string;
  readonly finishReason?: string;
  readonly providerCode?: string;
  readonly reasoningContentPresent?: boolean;
  readonly orchestrationTimeout?: boolean;
}

export function classifyLiveHarnessBottleneck(signal: LiveHarnessBottleneckSignal): LiveHarnessBottleneckClass {
  const haystack = `${signal.failureKind ?? ""} ${signal.failureMessage ?? ""} ${signal.providerCode ?? ""}`.toLowerCase();
  const has = (...needles: string[]): boolean => needles.some((needle) => haystack.includes(needle));

  if (signal.reasoningContentPresent && (has("json", "parse", "schema", "invalid") || signal.finishReason === "length")) {
    return "reasoning_content_present";
  }

  if (signal.orchestrationTimeout || has("orchestration-timeout", "orchestration timeout exceeded")) {
    return "orchestration_timeout";
  }

  if (has("context length", "context_length", "maximum context", "context window", "too many tokens", "input is too long")) {
    return "context_overflow";
  }

  if (
    has("max_tokens", "max tokens", "max_output_tokens", "output tokens", "completion tokens")
    && has("exceed", "exceeded", "limit", "rejected", "invalid", "too large")
  ) {
    return "max_tokens_rejected";
  }

  if (signal.finishReason === "length") {
    if (has("json", "parse", "schema", "invalid")) {
      return "truncated_json";
    }
    return "truncated_json";
  }

  if (has("planner_invalid", "skeptic_invalid", "synthesis", "schema", "zod", "validation failed")) {
    return "schema_contract";
  }

  if (signal.failureKind === "timeout" || has("abort", "timed out")) {
    if (signal.orchestrationTimeout) return "orchestration_timeout";
    return "provider_timeout";
  }

  if (has("json", "parse", "provider_json", "provider_response_invalid")) {
    if (signal.finishReason === "length") return "truncated_json";
    return "schema_contract";
  }

  return "unknown";
}

export function inferFirstFailingOrchestrationStep(text: string): string | undefined {
  const lower = text.toLowerCase();
  if (lower.includes("orchestration-timeout") || lower.includes("orchestration timeout")) return "orchestration";
  if (lower.includes("planner_invalid") || lower.includes("planner failure") || lower.includes("\"planner\"")) {
    return "planner";
  }
  if (lower.includes("skeptic_invalid") || lower.includes("skeptic failure")) return "skeptic";
  if (lower.includes("crucible")) return "crucible";
  if (lower.includes("synthesis") || lower.includes("synthesizer")) return "synthesizer";
  if (lower.includes("provider_http") || lower.includes("provider error")) return "provider";
  return undefined;
}

export interface HarnessProviderCallRoleHint {
  readonly task?: string;
  readonly metadata?: Record<string, unknown>;
}

type StructuredHarnessRole = "planner" | "skeptic" | "synthesizer" | "repair";

export function countStructuredRoleAttempts(
  calls: readonly HarnessProviderCallRoleHint[],
): LiveHarnessScenarioDiagnostics["repairAttemptsByRole"] {
  const counts: Record<StructuredHarnessRole, number> = { planner: 0, skeptic: 0, synthesizer: 0, repair: 0 };
  for (const call of calls) {
    const role = structuredRoleFromCall(call);
    if (!role) continue;
    counts[role] += 1;
  }
  const hasAny = Object.values(counts).some((value) => value > 0);
  return hasAny ? counts : undefined;
}

function structuredRoleFromCall(call: HarnessProviderCallRoleHint): StructuredHarnessRole | undefined {
  const metadataRole = call.metadata?.structuredRole;
  if (
    metadataRole === "planner"
    || metadataRole === "skeptic"
    || metadataRole === "synthesizer"
    || metadataRole === "repair"
  ) {
    return metadataRole;
  }
  const task = call.task?.toLowerCase() ?? "";
  if (task.includes("planner")) return "planner";
  if (task.includes("skeptic")) return "skeptic";
  if (task.includes("synthesizer") || task.includes("synthesis")) return "synthesizer";
  if (task.includes("repair")) return "repair";
  return undefined;
}

export function classifyLiveProviderFailure(signal: LiveProviderFailureSignal): LiveProviderFailureClassification {
  const status = signal.status;
  const haystack = `${signal.code ?? ""} ${signal.message ?? ""}`.toLowerCase();
  const has = (...needles: string[]): boolean => needles.some((needle) => haystack.includes(needle));

  const base = {
    ...(status !== undefined ? { status } : {}),
    ...(signal.retryable !== undefined ? { retryable: signal.retryable } : {}),
    ...(signal.code ? { providerCode: signal.code } : {}),
  };

  if (signal.code === "ABORTED" || has("abort", "timeout", "timed out")) {
    return { taxonomy: "timeout", ...base };
  }
  if (signal.code === "PROVIDER_RESPONSE_INVALID" || has("provider_response_invalid")) {
    return { taxonomy: "provider_json", ...base };
  }

  const httpLike = signal.code === "PROVIDER_HTTP_ERROR" || (status !== undefined && status >= 400);
  if (httpLike) {
    if (status === 429 || has("rate limit", "rate_limit", "ratelimit", "too many requests")) {
      return { taxonomy: "rate_limit", ...base };
    }
    if (
      status === 402
      || has("insufficient_quota", "quota exceeded", "exceeded your current quota", "billing", "insufficient balance")
    ) {
      return { taxonomy: "quota", ...base };
    }
    if (status !== undefined && status >= 400) {
      return { taxonomy: "provider_http", ...base };
    }
    if (signal.code === "PROVIDER_HTTP_ERROR") {
      return { taxonomy: "provider_http", ...base };
    }
  }

  if (has("json", "parse", "provider_response_invalid")) {
    return { taxonomy: "provider_json", ...base };
  }

  return { taxonomy: "unknown", ...base };
}

export function classifyLiveProviderFailureFromError(error: unknown): LiveProviderFailureClassification {
  if (error instanceof ProviderError) {
    return classifyLiveProviderFailure({
      code: error.code,
      status: error.status,
      message: error.message,
      retryable: error.retryable,
    });
  }
  if (error && typeof error === "object") {
    const record = error as { name?: unknown; code?: unknown; message?: unknown };
    if (record.name === "AbortError" || record.code === "ABORT_ERR") {
      return classifyLiveProviderFailure({ code: "ABORTED", message: safeMessage(error) });
    }
  }
  return classifyLiveProviderFailure({ message: safeMessage(error) });
}

export function summarizeMatrixCampaignFailure(input: {
  readonly steps: readonly { readonly stepId: string; readonly exitCode: number }[];
  readonly campaignFailed: boolean;
  readonly gateOk?: boolean;
  readonly gateStepId?: string;
}): { readonly firstFailingStep?: string; readonly bottleneckClass?: LiveHarnessBottleneckClass } {
  const failedStep = input.steps.find((step) => step.exitCode !== 0);
  if (failedStep) {
    return { firstFailingStep: failedStep.stepId, bottleneckClass: "unknown" };
  }
  if (input.campaignFailed && input.gateOk === false) {
    return {
      firstFailingStep: input.gateStepId ?? "evidence:live:gate",
      bottleneckClass: "unknown",
    };
  }
  return {};
}

export function buildLiveHarnessScenarioDiagnostics(input: {
  readonly scenarioId: string;
  readonly failures: readonly { readonly kind: string; readonly message: string }[];
  readonly eventText: string;
  readonly providerCalls: readonly HarnessProviderCallRoleHint[];
  readonly lastFinishReason?: string;
  readonly lastReasoningContentPresent?: boolean;
  readonly configuredMaxRuntimeMs: number;
  readonly orchestrationTimeout?: boolean;
}): LiveHarnessScenarioDiagnostics {
  const primaryFailure = input.failures[0];
  const bottleneckClass = classifyLiveHarnessBottleneck({
    failureKind: primaryFailure?.kind,
    failureMessage: primaryFailure?.message,
    finishReason: input.lastFinishReason,
    reasoningContentPresent: input.lastReasoningContentPresent,
    orchestrationTimeout: input.orchestrationTimeout,
  });
  const firstFailingStep = inferFirstFailingOrchestrationStep(
    `${input.eventText}\n${input.failures.map((failure) => `${failure.kind}:${failure.message}`).join("\n")}`,
  );
  return LiveHarnessScenarioDiagnosticsSchema.parse({
    scenarioId: input.scenarioId,
    ...(firstFailingStep ? { firstFailingStep } : {}),
    ...(input.failures.length > 0 ? { bottleneckClass } : {}),
    configuredMaxRuntimeMs: input.configuredMaxRuntimeMs,
    repairAttemptsByRole: countStructuredRoleAttempts(input.providerCalls),
    providerCalls: input.providerCalls.length,
  });
}

export function aggregateNumericStats(samples: readonly number[]): NumericAggregateStats {
  const values = samples.filter((value) => Number.isFinite(value) && value >= 0).map((value) => Math.trunc(value));
  if (values.length === 0) {
    return { count: 0, min: 0, max: 0, avg: 0, p50: 0, p95: 0 };
  }
  const sorted = [...values].sort((left, right) => left - right);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: Math.round((sum / sorted.length) * 100) / 100,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
  };
}

export function buildZaiLiveDiagnostics(input: {
  readonly failureTaxonomy?: Partial<Record<ZaiLiveProviderFailureTaxonomy, number>>;
  readonly bottleneckTaxonomy?: Partial<Record<LiveHarnessBottleneckClass, number>>;
  readonly providerCallLatencyMs?: readonly number[];
  readonly scenarioDurationMs?: readonly number[];
  readonly campaignDurationMs?: readonly number[];
  readonly matrixStepDurationMs?: readonly number[];
  readonly tokens: ZaiLiveTokenAggregate;
  readonly harnessMaxRuntimeMs?: number;
  readonly scenarios?: readonly LiveHarnessScenarioDiagnostics[];
}): ZaiLiveDiagnostics {
  const failureTaxonomy = emptyFailureTaxonomyCounts();
  for (const kind of ZAI_LIVE_PROVIDER_FAILURE_TAXONOMY) {
    failureTaxonomy[kind] = input.failureTaxonomy?.[kind] ?? 0;
  }
  const bottleneckTaxonomy = emptyBottleneckTaxonomyCounts();
  for (const kind of LIVE_HARNESS_BOTTLENECK_CLASSES) {
    bottleneckTaxonomy[kind] = input.bottleneckTaxonomy?.[kind] ?? 0;
  }

  return ZaiLiveDiagnosticsSchema.parse({
    schemaVersion: ZAI_LIVE_DIAGNOSTICS_SCHEMA_VERSION,
    failureTaxonomy,
    bottleneckTaxonomy,
    latencyMs: {
      providerCalls: aggregateNumericStats(input.providerCallLatencyMs ?? []),
      scenarios: aggregateNumericStats(input.scenarioDurationMs ?? []),
      ...(input.campaignDurationMs?.length
        ? { campaigns: aggregateNumericStats(input.campaignDurationMs) }
        : {}),
      ...(input.matrixStepDurationMs?.length
        ? { matrixSteps: aggregateNumericStats(input.matrixStepDurationMs) }
        : {}),
    },
    tokens: input.tokens,
    ...(input.harnessMaxRuntimeMs !== undefined ? { harnessMaxRuntimeMs: input.harnessMaxRuntimeMs } : {}),
    ...(input.scenarios?.length ? { scenarios: [...input.scenarios] } : {}),
  });
}

export function incrementFailureTaxonomy(
  counts: Record<ZaiLiveProviderFailureTaxonomy, number>,
  taxonomy: ZaiLiveProviderFailureTaxonomy,
): void {
  counts[taxonomy] += 1;
}

export function taxonomyFromHarnessFailureKind(kind: string): ZaiLiveProviderFailureTaxonomy | undefined {
  switch (kind) {
    case "rate_limit":
      return "rate_limit";
    case "quota":
      return "quota";
    case "timeout":
      return "timeout";
    case "provider_http":
    case "http":
      return "provider_http";
    case "provider_json":
    case "json":
      return "provider_json";
    case "unknown":
      return "unknown";
    default:
      return undefined;
  }
}

export function renderZaiLiveDiagnosticsMarkdown(diagnostics: ZaiLiveDiagnostics): string {
  const lines: string[] = [];
  lines.push("## Diagnostics", "");
  lines.push("### Provider failure taxonomy", "");
  lines.push("| taxonomy | count |");
  lines.push("| --- | ---: |");
  for (const kind of ZAI_LIVE_PROVIDER_FAILURE_TAXONOMY) {
    lines.push(`| \`${kind}\` | ${diagnostics.failureTaxonomy[kind]} |`);
  }
  lines.push("", "### Bottleneck taxonomy", "");
  lines.push("| bottleneck | count |");
  lines.push("| --- | ---: |");
  for (const kind of LIVE_HARNESS_BOTTLENECK_CLASSES) {
    lines.push(`| \`${kind}\` | ${diagnostics.bottleneckTaxonomy[kind]} |`);
  }
  if (diagnostics.harnessMaxRuntimeMs !== undefined) {
    lines.push("", `Configured harness max runtime (ms): ${diagnostics.harnessMaxRuntimeMs}`);
  }
  if (diagnostics.scenarios?.length) {
    lines.push("", "### Scenario diagnostics", "");
    lines.push("| scenario | first failing step | bottleneck | repair attempts | provider calls |");
    lines.push("| --- | --- | --- | --- | ---: |");
    for (const scenario of diagnostics.scenarios) {
      const repairs = scenario.repairAttemptsByRole
        ? `planner=${scenario.repairAttemptsByRole.planner ?? 0}, skeptic=${scenario.repairAttemptsByRole.skeptic ?? 0}, synth=${scenario.repairAttemptsByRole.synthesizer ?? 0}, repair=${scenario.repairAttemptsByRole.repair ?? 0}`
        : "n/a";
      lines.push(
        `| \`${scenario.scenarioId}\` | ${scenario.firstFailingStep ?? "n/a"} | ${scenario.bottleneckClass ?? "n/a"} | ${repairs} | ${scenario.providerCalls ?? 0} |`,
      );
    }
  }
  lines.push("", "### Latency (ms)", "");
  lines.push("| scope | count | min | avg | p50 | p95 | max |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  const latencyRows: Array<{ readonly label: string; readonly stats: NumericAggregateStats }> = [
    { label: "provider calls", stats: diagnostics.latencyMs.providerCalls },
    { label: "scenarios", stats: diagnostics.latencyMs.scenarios },
  ];
  if (diagnostics.latencyMs.campaigns) {
    latencyRows.push({ label: "campaigns", stats: diagnostics.latencyMs.campaigns });
  }
  if (diagnostics.latencyMs.matrixSteps) {
    latencyRows.push({ label: "matrix steps", stats: diagnostics.latencyMs.matrixSteps });
  }
  for (const { label, stats } of latencyRows) {
    lines.push(
      `| ${label} | ${stats.count} | ${stats.min} | ${stats.avg} | ${stats.p50} | ${stats.p95} | ${stats.max} |`,
    );
  }
  lines.push("", "### Tokens", "");
  lines.push(`- Input: ${diagnostics.tokens.inputTokens}`);
  lines.push(`- Output: ${diagnostics.tokens.outputTokens}`);
  lines.push(`- Total: ${diagnostics.tokens.totalTokens}`);
  lines.push(`- Model calls: ${diagnostics.tokens.modelCalls}`);
  lines.push(`- Estimated cost USD: ${diagnostics.tokens.estimatedCostUsd.toFixed(6)}`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  const index = Math.max(0, Math.min(sorted.length - 1, rank));
  return sorted[index];
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}