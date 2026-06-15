import crypto from "node:crypto";
import { z } from "zod";

export const OBSERVABILITY_SPAN_STATUSES = ["OK", "ERROR"] as const;

export const ObservabilitySpanSchema = z.object({
  traceId: z.string().min(1),
  spanId: z.string().min(1),
  parentSpanId: z.string().min(1).optional(),
  phase: z.string().min(1),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  durationMs: z.number().nonnegative(),
  status: z.enum(OBSERVABILITY_SPAN_STATUSES),
  modelCallCount: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().nonnegative(),
  provider: z.string().min(1),
  error: z.string().optional(),
});
export type ObservabilitySpan = z.infer<typeof ObservabilitySpanSchema>;

export const ObservabilityEventSchema = ObservabilitySpanSchema;
export type ObservabilityEvent = ObservabilitySpan;

export const ObservabilitySummarySchema = z.object({
  traceId: z.string().min(1),
  spanCount: z.number().int().nonnegative(),
  startedAt: z.string().datetime().optional(),
  endedAt: z.string().datetime().optional(),
  durationMs: z.number().nonnegative(),
  status: z.enum(OBSERVABILITY_SPAN_STATUSES),
  modelCallCount: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().nonnegative(),
  providers: z.array(z.string().min(1)),
  spans: z.array(ObservabilitySpanSchema),
});
export type ObservabilitySummary = z.infer<typeof ObservabilitySummarySchema>;

export interface ObservabilityTraceOptions {
  traceId?: string;
  provider?: string;
  now?: () => Date;
  idFactory?: () => string;
}

export interface ObservabilityAdapter {
  readonly name: string;
  captureSpan(span: ObservabilitySpan): Promise<void>;
  captureSummary(summary: ObservabilitySummary): Promise<void>;
}

export type LlmObservabilitySpan = ObservabilitySpan;
export type LlmObservabilityAdapter = ObservabilityAdapter;

export interface NoopObservabilityAdapters {
  sentry: LlmObservabilityAdapter;
  postHog: LlmObservabilityAdapter;
  openTelemetry: LlmObservabilityAdapter;
}

type OpenSpan = {
  spanId: string;
  parentSpanId?: string;
  phase: string;
  startedAt: Date;
};

export class InMemoryObservabilityTrace {
  readonly traceId: string;
  private readonly provider: string;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly openSpans = new Map<string, OpenSpan>();
  private readonly spans: ObservabilitySpan[] = [];

  constructor(options: ObservabilityTraceOptions = {}) {
    this.traceId = options.traceId ?? `trace-${crypto.randomUUID()}`;
    this.provider = options.provider ?? "local";
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => `span-${crypto.randomUUID()}`);
  }

  startSpan(phase: string, parentSpanId?: string): string {
    const spanId = this.idFactory();
    this.openSpans.set(spanId, {
      spanId,
      parentSpanId,
      phase,
      startedAt: this.now(),
    });
    return spanId;
  }

  endSpan(spanId: string, status: ObservabilitySpan["status"] = "OK", error?: unknown): ObservabilitySpan {
    const open = this.openSpans.get(spanId);
    if (!open) {
      throw new Error(`Unknown observability span: ${spanId}`);
    }

    this.openSpans.delete(spanId);
    const endedAt = this.now();
    const span = ObservabilitySpanSchema.parse({
      traceId: this.traceId,
      spanId: open.spanId,
      parentSpanId: open.parentSpanId,
      phase: open.phase,
      startedAt: open.startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs: Math.max(0, endedAt.getTime() - open.startedAt.getTime()),
      status,
      modelCallCount: 0,
      estimatedCostUsd: 0,
      provider: this.provider,
      ...(error === undefined ? {} : { error: errorToString(error) }),
    });
    this.spans.push(span);
    return span;
  }

  recordSpan<T>(phase: string, operation: () => T | Promise<T>, parentSpanId?: string): Promise<T> {
    const spanId = this.startSpan(phase, parentSpanId);
    return Promise.resolve()
      .then(operation)
      .then((value) => {
        this.endSpan(spanId, "OK");
        return value;
      })
      .catch((error) => {
        this.endSpan(spanId, "ERROR", error);
        throw error;
      });
  }

  listSpans(): ObservabilitySpan[] {
    return structuredClone(this.spans);
  }

  getLastSpanForPhase(phase: string): ObservabilitySpan | undefined {
    const span = [...this.spans].reverse().find((candidate) => candidate.phase === phase);
    return span === undefined ? undefined : structuredClone(span);
  }

  getSummary(): ObservabilitySummary {
    const spans = this.listSpans();
    const startedAt = spans.at(0)?.startedAt;
    const endedAt = spans.at(-1)?.endedAt;
    const durationMs = startedAt && endedAt ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) : 0;
    const summary = {
      traceId: this.traceId,
      spanCount: spans.length,
      startedAt,
      endedAt,
      durationMs,
      status: spans.some((span) => span.status === "ERROR") ? "ERROR" : "OK",
      modelCallCount: spans.reduce((total, span) => total + span.modelCallCount, 0),
      estimatedCostUsd: spans.reduce((total, span) => total + span.estimatedCostUsd, 0),
      providers: [...new Set(spans.map((span) => span.provider))],
      spans,
    } satisfies ObservabilitySummary;

    return ObservabilitySummarySchema.parse(summary);
  }
}

export function createInMemoryObservabilityTrace(options: ObservabilityTraceOptions = {}): InMemoryObservabilityTrace {
  return new InMemoryObservabilityTrace(options);
}

export function createNoopObservabilityAdapters(): NoopObservabilityAdapters {
  return {
    sentry: createNoopAdapter("sentry"),
    postHog: createNoopAdapter("posthog"),
    openTelemetry: createNoopAdapter("opentelemetry"),
  };
}

/**
 * Create observability adapters based on environment configuration.
 *
 * Checks for `SENTRY_DSN` and `POSTHOG_API_KEY` environment variables. When set,
 * returns real adapters backed by the respective SDKs (lazy-loaded via `require()`).
 * When not set, returns no-op adapters with zero overhead.
 *
 * Optional dependencies `@sentry/node` and `posthog-node` are NOT installed by
 * default — they are loaded lazily only when the corresponding env var is set.
 */
// Re-export adapter factories for direct consumption
export { createSentryAdapter } from "./sentryAdapter.js";
export type { SentryAdapterOptions } from "./sentryAdapter.js";
export { createPostHogAdapter } from "./posthogAdapter.js";
export type { PostHogAdapterOptions } from "./posthogAdapter.js";

import { createSentryAdapter } from "./sentryAdapter.js";
import { createPostHogAdapter } from "./posthogAdapter.js";

/**
 * Create observability adapters based on environment configuration.
 *
 * Checks for `SENTRY_DSN` and `POSTHOG_API_KEY` environment variables. When set,
 * returns real adapters backed by the respective SDKs (lazy-loaded via `require()`).
 * When not set, returns no-op adapters with zero overhead.
 *
 * Optional dependencies `@sentry/node` and `posthog-node` are NOT installed by
 * default — they are loaded lazily only when the corresponding env var is set.
 */
export function createObservabilityAdapters(): NoopObservabilityAdapters {
  return {
    sentry: createSentryAdapter(),
    postHog: createPostHogAdapter(),
    openTelemetry: createNoopAdapter("opentelemetry"),
  };
}

function createNoopAdapter(name: string): ObservabilityAdapter {
  return {
    name,
    async captureSpan(_span: ObservabilitySpan): Promise<void> {
      return undefined;
    },
    async captureSummary(_summary: ObservabilitySummary): Promise<void> {
      return undefined;
    },
  };
}

function errorToString(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

// --- Cost / token aggregation (ORN-41, task 10.1) ---
//
// These are PURE folds over already-loaded, already-persisted (and therefore already-redacted) run
// events and runs. They perform no I/O and touch no store. The cost dashboard (tasks 11.x) loads
// the events/runs and feeds them in; the live `cost` SSE frame (task 11.2) emits a RunCostAggregate
// directly, so `RunCostAggregateSchema` below is intentionally FIELD-COMPATIBLE with the
// `SseCostPayloadSchema` placeholder defined in `src/api/server.ts` (task 7.1).
//
// REAL DATA SHAPE (mapping note): the task text references `ProviderCallMetadata`/`LLMUsage`
// "already on persisted events". Those names are real but live in the orchestration layer
// (`ProviderCallMetadataSchema` in `src/orchestration/chatRunner.ts`, `LLMUsageSchema` in
// `src/providers/llm.ts`), not in a persisted schema. On the wire they are carried INSIDE a run
// event's free-form `payload` under the key `providerCall`:
//
//     event.payload.providerCall = {
//       mode, provider, model, modelRoute,
//       usage: { inputTokens, outputTokens, totalTokens, estimatedUsd, modelCalls },
//       attempts, repaired,
//     }
//
// recorded by `chatRunner` on the PLANNING / SKEPTIC_REVIEW / SYNTHESIZING transitions (local-mode
// events carry no `providerCall`, so they contribute zero). To honor Requirement 3.8 ("absent or
// partial usage contributes 0 WITHOUT raising"), these folds read those fields DEFENSIVELY rather
// than strict-parsing through `ProviderCallMetadataSchema`/`LLMUsageSchema` (a strict parse would
// throw on partial usage). Only id-like, non-secret fields (`provider`, `model`) are collected —
// never auth material. The aggregates are derived views, never persisted rows.

// NOTE: imported type-only to avoid any runtime/circular dependency — these folds stay pure and the
// observability module pulls in no store or provider runtime code.
import type { Run, RunEvent } from "../store/schemas";

/**
 * Per-run cost/token total folded from the `providerCall.usage` recorded on a run's events. Numbers
 * and de-duplicated non-secret provider/model identifiers only — safe to persist, stream, and
 * render. Field-compatible with the `cost` SSE frame payload (see module note above) so task 11.2
 * can emit a `RunCostAggregate` directly as the live cost frame.
 */
export const RunCostAggregateSchema = z.object({
  runId: z.string().min(1),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  estimatedUsd: z.number().nonnegative(),
  modelCalls: z.number().int().nonnegative(),
  providers: z.array(z.string().min(1)), // distinct provider ids, never secrets
  models: z.array(z.string().min(1)), // distinct model ids, never secrets
});
export type RunCostAggregate = z.infer<typeof RunCostAggregateSchema>;

/**
 * Per-conversation cost/token total, summed from its runs' {@link RunCostAggregate}s. Carries the
 * per-run breakdown in the runs' insertion order (Requirement 3.3).
 */
export const ConversationCostAggregateSchema = z.object({
  conversationId: z.string().min(1),
  runCount: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  estimatedUsd: z.number().nonnegative(),
  modelCalls: z.number().int().nonnegative(),
  runs: z.array(RunCostAggregateSchema),
});
export type ConversationCostAggregate = z.infer<typeof ConversationCostAggregateSchema>;

/** Coerce an unknown value to a finite, non-negative integer; anything else contributes 0. */
function nonNegativeIntOrZero(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

/** Coerce an unknown value to a finite, non-negative number; anything else contributes 0. */
function nonNegativeNumberOrZero(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return value;
}

/** A non-empty trimmed string id, or undefined. Never returns secret/auth material — ids only. */
function idOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

interface ExtractedProviderCall {
  provider?: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
  modelCalls: number;
}

/**
 * Defensively read the `providerCall` metadata from a persisted run event's payload. Returns
 * `undefined` when the event carries no provider-call metadata (e.g. every local-mode event), and
 * treats any absent/partial `usage` field as 0 — so a malformed or partial record never raises and
 * simply contributes zero (Requirement 3.8).
 */
function extractProviderCall(event: RunEvent): ExtractedProviderCall | undefined {
  const payload = event.payload;
  if (payload === null || typeof payload !== "object") return undefined;
  const providerCall = (payload as Record<string, unknown>).providerCall;
  if (providerCall === null || typeof providerCall !== "object") return undefined;

  const call = providerCall as Record<string, unknown>;
  const usage =
    call.usage !== null && typeof call.usage === "object" ? (call.usage as Record<string, unknown>) : {};

  return {
    provider: idOrUndefined(call.provider),
    model: idOrUndefined(call.model),
    inputTokens: nonNegativeIntOrZero(usage.inputTokens),
    outputTokens: nonNegativeIntOrZero(usage.outputTokens),
    estimatedUsd: nonNegativeNumberOrZero(usage.estimatedUsd),
    modelCalls: nonNegativeIntOrZero(usage.modelCalls),
  };
}

/**
 * Pure fold producing the per-run cost aggregate. Sums `inputTokens`, `outputTokens`,
 * `estimatedUsd`, and `modelCalls` across the run's provider-call events; sets
 * `totalTokens = inputTokens + outputTokens`; and collects the de-duplicated, non-secret provider
 * and model ids (insertion order preserved). Events whose `runId` does not match are ignored, and
 * events with no/partial provider-call usage contribute zero. No I/O — the caller supplies the
 * already-loaded events (e.g. `store.listEvents(runId)`).
 */
export function aggregateRunCost(runId: string, events: RunEvent[]): RunCostAggregate {
  let inputTokens = 0;
  let outputTokens = 0;
  let estimatedUsd = 0;
  let modelCalls = 0;
  const providers: string[] = [];
  const models: string[] = [];

  for (const event of events) {
    if (event.runId !== runId) continue;
    const call = extractProviderCall(event);
    if (call === undefined) continue;

    inputTokens += call.inputTokens;
    outputTokens += call.outputTokens;
    estimatedUsd += call.estimatedUsd;
    modelCalls += call.modelCalls;
    if (call.provider !== undefined && !providers.includes(call.provider)) providers.push(call.provider);
    if (call.model !== undefined && !models.includes(call.model)) models.push(call.model);
  }

  return RunCostAggregateSchema.parse({
    runId,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimatedUsd,
    modelCalls,
    providers,
    models,
  });
}

/**
 * Pure fold producing the per-conversation cost aggregate. Folds each run's events through
 * {@link aggregateRunCost} (in the runs' insertion order) and sums the per-run totals; the
 * conversation `runs` list is the runs' {@link RunCostAggregate}s in that same order
 * (Requirement 3.3). A run with no entry in `eventsByRun` contributes an all-zero aggregate. No I/O.
 */
export function aggregateConversationCost(
  conversationId: string,
  runs: Run[],
  eventsByRun: Map<string, RunEvent[]>
): ConversationCostAggregate {
  const runAggregates = runs.map((run) => aggregateRunCost(run.id, eventsByRun.get(run.id) ?? []));

  let inputTokens = 0;
  let outputTokens = 0;
  let estimatedUsd = 0;
  let modelCalls = 0;
  for (const aggregate of runAggregates) {
    inputTokens += aggregate.inputTokens;
    outputTokens += aggregate.outputTokens;
    estimatedUsd += aggregate.estimatedUsd;
    modelCalls += aggregate.modelCalls;
  }

  return ConversationCostAggregateSchema.parse({
    conversationId,
    runCount: runAggregates.length,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimatedUsd,
    modelCalls,
    runs: runAggregates,
  });
}
