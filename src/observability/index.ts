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
