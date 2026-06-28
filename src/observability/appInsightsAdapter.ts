/**
 * Application Insights telemetry adapter — lazy-loaded when not configured.
 *
 * Activated only when `APPLICATIONINSIGHTS_CONNECTION_STRING` is present.
 * Spans and summaries are redacted before export.
 */

import { createRequire } from "node:module";

import type { ObservabilityAdapter, ObservabilitySpan, ObservabilitySummary } from ".";
import { redactString } from "../security/redaction.js";

const require = createRequire(import.meta.url);

interface TelemetryClient {
  trackEvent(event: { name: string; properties?: Record<string, string> }): void;
  trackTrace(trace: { message: string; properties?: Record<string, string> }): void;
  flush(options?: { callback: (response: unknown) => void }): void;
}

interface AppInsightsModule {
  setup(connectionString: string): AppInsightsModule;
  setAutoCollectConsole(enable: boolean, collectErrors?: boolean): AppInsightsModule;
  setAutoCollectDependencies(enable: boolean): AppInsightsModule;
  setAutoCollectRequests(enable: boolean): AppInsightsModule;
  setAutoCollectPerformance(enable: boolean, collectExtendedMetrics?: boolean): AppInsightsModule;
  setAutoCollectExceptions(enable: boolean): AppInsightsModule;
  start(): AppInsightsModule;
  defaultClient: TelemetryClient;
}

let appInsightsModule: AppInsightsModule | null | undefined = undefined;

function loadAppInsights(): AppInsightsModule | null {
  if (appInsightsModule !== undefined) return appInsightsModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    appInsightsModule = require("applicationinsights") as AppInsightsModule;
  } catch {
    appInsightsModule = null;
  }
  return appInsightsModule;
}

export interface AppInsightsAdapterOptions {
  connectionString?: string;
}

function redactSpan(span: ObservabilitySpan): Record<string, string> {
  return {
    traceId: redactString(span.traceId),
    spanId: redactString(span.spanId),
    phase: redactString(span.phase),
    status: span.status,
    durationMs: String(span.durationMs),
    modelCallCount: String(span.modelCallCount),
    estimatedCostUsd: String(span.estimatedCostUsd),
    provider: redactString(span.provider),
    ...(span.parentSpanId ? { parentSpanId: redactString(span.parentSpanId) } : {}),
    ...(span.error ? { error: redactString(span.error) } : {}),
  };
}

function redactSummary(summary: ObservabilitySummary): Record<string, string> {
  return {
    traceId: redactString(summary.traceId),
    status: summary.status,
    spanCount: String(summary.spanCount),
    durationMs: String(summary.durationMs),
    modelCallCount: String(summary.modelCallCount),
    estimatedCostUsd: String(summary.estimatedCostUsd),
    providers: summary.providers.map(redactString).join(","),
  };
}

export function createAppInsightsAdapter(options: AppInsightsAdapterOptions = {}): ObservabilityAdapter {
  const connectionString = (options.connectionString ?? process.env.APPLICATIONINSIGHTS_CONNECTION_STRING)?.trim();
  if (!connectionString) {
    return {
      name: "appInsights",
      async captureSpan(): Promise<void> {},
      async captureSummary(): Promise<void> {},
    };
  }

  const resolvedConnectionString = connectionString;
  let initialized = false;

  function ensureClient(): TelemetryClient | null {
    if (initialized) {
      const mod = loadAppInsights();
      return mod?.defaultClient ?? null;
    }
    const mod = loadAppInsights();
    if (!mod) {
      console.warn(
        "[OBSERVABILITY] APPLICATIONINSIGHTS_CONNECTION_STRING is set but applicationinsights is not installed — App Insights adapter disabled",
      );
      initialized = true;
      return null;
    }
    try {
      mod.setup(resolvedConnectionString)
        .setAutoCollectConsole(false)
        .setAutoCollectDependencies(false)
        .setAutoCollectRequests(false)
        .setAutoCollectPerformance(false, false)
        .setAutoCollectExceptions(false)
        .start();
    } catch {
      initialized = true;
      return null;
    }
    initialized = true;
    return mod.defaultClient ?? null;
  }

  return {
    name: "appInsights",
    async captureSpan(span: ObservabilitySpan): Promise<void> {
      const client = ensureClient();
      if (!client) return;
      try {
        client.trackEvent({ name: "rector.phase", properties: redactSpan(span) });
      } catch {
        return;
      }
    },
    async captureSummary(summary: ObservabilitySummary): Promise<void> {
      const client = ensureClient();
      if (!client) return;
      try {
        client.trackEvent({ name: "rector.run.complete", properties: redactSummary(summary) });
      } catch {
        return;
      }
    },
  };
}

export interface HarnessTelemetryInput {
  harness: string;
  status: "pass" | "fail" | "skip";
  durationMs?: number;
  detail?: string;
}

export interface AzureDailyTouchTelemetryInput {
  steps: string;
  ok: boolean;
}

export function emitAzureDailyTouchTelemetry(input: AzureDailyTouchTelemetryInput): void {
  const connectionString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING?.trim();
  if (!connectionString) return;

  const adapter = createAppInsightsAdapter({ connectionString });
  void adapter.captureSummary({
    traceId: `azure-daily-touch-${new Date().toISOString().slice(0, 10)}`,
    spanCount: 0,
    durationMs: 0,
    status: input.ok ? "OK" : "ERROR",
    modelCallCount: 0,
    estimatedCostUsd: 0,
    providers: ["azure"],
    spans: [],
  }).then(() => {
    const mod = loadAppInsights();
    try {
      mod?.defaultClient.trackEvent({
        name: "rector.azure.daily_touch",
        properties: {
          steps: redactString(input.steps),
          ok: String(input.ok),
        },
      });
    } catch {
      return;
    }
  });
}

export function emitHarnessTelemetry(input: HarnessTelemetryInput): void {
  const connectionString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  if (!connectionString?.trim()) return;

  const adapter = createAppInsightsAdapter({ connectionString });
  const summary: ObservabilitySummary = {
    traceId: `harness-${input.harness}`,
    spanCount: 0,
    durationMs: input.durationMs ?? 0,
    status: input.status === "fail" ? "ERROR" : "OK",
    modelCallCount: 0,
    estimatedCostUsd: 0,
    providers: ["harness"],
    spans: [],
  };
  void adapter.captureSummary(summary).then(() => {
    const mod = loadAppInsights();
    mod?.defaultClient.trackEvent({
      name: "rector.harness.complete",
      properties: {
        harness: input.harness,
        status: input.status,
        ...(input.durationMs !== undefined ? { durationMs: String(input.durationMs) } : {}),
        ...(input.detail ? { detail: redactString(input.detail) } : {}),
      },
    });
  });
}