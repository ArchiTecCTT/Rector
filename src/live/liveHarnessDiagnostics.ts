import { z } from "zod";

import { ProviderError } from "../providers/llm";

export const ZAI_LIVE_DIAGNOSTICS_SCHEMA_VERSION = "rector.zai-live-diagnostics.v1";

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
  readonly providerCallLatencyMs?: readonly number[];
  readonly scenarioDurationMs?: readonly number[];
  readonly campaignDurationMs?: readonly number[];
  readonly matrixStepDurationMs?: readonly number[];
  readonly tokens: ZaiLiveTokenAggregate;
}): ZaiLiveDiagnostics {
  const failureTaxonomy = emptyFailureTaxonomyCounts();
  for (const kind of ZAI_LIVE_PROVIDER_FAILURE_TAXONOMY) {
    failureTaxonomy[kind] = input.failureTaxonomy?.[kind] ?? 0;
  }

  return ZaiLiveDiagnosticsSchema.parse({
    schemaVersion: ZAI_LIVE_DIAGNOSTICS_SCHEMA_VERSION,
    failureTaxonomy,
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