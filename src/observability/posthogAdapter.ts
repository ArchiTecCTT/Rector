/**
 * PostHog telemetry adapter — lazy-loaded to avoid import cost when not configured.
 *
 * Activated only when `POSTHOG_API_KEY` environment variable is present. All events
 * are redacted via `redactSecrets` before being sent to PostHog.
 */

import type { ObservabilityAdapter, ObservabilitySpan, ObservabilitySummary } from "./index.js";
import { redactSecrets, redactString } from "../security/redaction.js";

/** Lazy-loaded PostHog module type — only the surface we use. */
interface PostHogModule {
  init(apiKey: string, options?: Record<string, unknown>): void;
  capture(params: { distinctId: string; event: string; properties?: Record<string, unknown> }): void;
  shutdown(): Promise<void>;
}

let posthogModule: PostHogModule | null | undefined = undefined;

/**
 * Attempt to lazily require `posthog-node`. Returns `null` if the package is not installed.
 * The require is attempted only once; subsequent calls return the cached result.
 */
function loadPostHog(): PostHogModule | null {
  if (posthogModule !== undefined) return posthogModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    posthogModule = require("posthog-node") as PostHogModule;
  } catch {
    posthogModule = null;
  }
  return posthogModule;
}

/** Options for creating the PostHog adapter. */
export interface PostHogAdapterOptions {
  /** PostHog API key. When provided, the adapter initializes PostHog on first use. */
  apiKey?: string;
  /** Optional PostHog host (for self-hosted instances). */
  host?: string;
}

/**
 * Redact a span's string fields before sending to PostHog.
 */
function redactSpanForPostHog(span: ObservabilitySpan): Record<string, unknown> {
  return redactSecrets({
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    phase: span.phase,
    startedAt: span.startedAt,
    endedAt: span.endedAt,
    durationMs: span.durationMs,
    status: span.status,
    modelCallCount: span.modelCallCount,
    estimatedCostUsd: span.estimatedCostUsd,
    provider: span.provider,
    error: span.error,
  });
}

/**
 * Redact a summary's string fields before sending to PostHog.
 */
function redactSummaryForPostHog(summary: ObservabilitySummary): Record<string, unknown> {
  return redactSecrets({
    traceId: summary.traceId,
    spanCount: summary.spanCount,
    startedAt: summary.startedAt,
    endedAt: summary.endedAt,
    durationMs: summary.durationMs,
    status: summary.status,
    modelCallCount: summary.modelCallCount,
    estimatedCostUsd: summary.estimatedCostUsd,
    providers: summary.providers,
  });
}

/**
 * Create a PostHog-backed observability adapter. When `options.apiKey` is provided (or
 * `POSTHOG_API_KEY` is set in the environment), the adapter initializes `posthog-node` on
 * first use. Otherwise returns a no-op adapter.
 *
 * The `posthog-node` package is loaded via lazy `require()` — it must be installed
 * separately (`npm install posthog-node`) and is NOT a required dependency.
 */
export function createPostHogAdapter(options: PostHogAdapterOptions = {}): ObservabilityAdapter {
  const apiKey = options.apiKey ?? process.env.POSTHOG_API_KEY;
  if (!apiKey) {
    return {
      name: "posthog",
      async captureSpan(): Promise<void> {},
      async captureSummary(): Promise<void> {},
    };
  }

  let initialized = false;
  // Distinct ID for server-side events — uses a stable identifier or falls back to "rector-server"
  const distinctId = `rector-server-${process.env.RECTOR_INSTANCE_ID ?? "default"}`;

  function ensureInit(): PostHogModule | null {
    if (initialized) return loadPostHog();
    const posthog = loadPostHog();
    if (posthog) {
      const initOptions: Record<string, unknown> = {};
      if (options.host) {
        initOptions.host = options.host;
      }
      posthog.init(apiKey!, initOptions);
    } else {
      console.warn("[OBSERVABILITY] POSTHOG_API_KEY is set but posthog-node is not installed — PostHog adapter disabled");
    }
    initialized = true;
    return posthog;
  }

  return {
    name: "posthog",
    async captureSpan(span: ObservabilitySpan): Promise<void> {
      const posthog = ensureInit();
      if (!posthog) return;
      const properties = redactSpanForPostHog(span);
      posthog.capture({
        distinctId,
        event: `rector.span.${span.phase}`,
        properties,
      });
    },
    async captureSummary(summary: ObservabilitySummary): Promise<void> {
      const posthog = ensureInit();
      if (!posthog) return;
      const properties = redactSummaryForPostHog(summary);
      posthog.capture({
        distinctId,
        event: "rector.orchestration.complete",
        properties,
      });
    },
  };
}
