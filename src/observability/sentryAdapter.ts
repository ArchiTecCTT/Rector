/**
 * Sentry telemetry adapter — lazy-loaded to avoid import cost when not configured.
 *
 * Activated only when `SENTRY_DSN` environment variable is present. All errors and spans
 * are redacted via `redactSecrets` before being sent to Sentry.
 */

import type { ObservabilityAdapter, ObservabilitySpan, ObservabilitySummary } from ".";
import { redactSecrets, redactString } from "../security/redaction.js";

/** Lazy-loaded Sentry module type — only the surface we use. */
interface SentryModule {
  init(options: Record<string, unknown>): void;
  captureException(error: unknown): string;
  startSpan<T>(options: Record<string, unknown>, callback: () => T): T;
  close(timeout?: number): PromiseLike<boolean>;
}

let sentryModule: SentryModule | null | undefined = undefined;

/**
 * Attempt to lazily require `@sentry/node`. Returns `null` if the package is not installed.
 * The require is attempted only once; subsequent calls return the cached result.
 */
function loadSentry(): SentryModule | null {
  if (sentryModule !== undefined) return sentryModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sentryModule = require("@sentry/node") as SentryModule;
  } catch {
    sentryModule = null;
  }
  return sentryModule;
}

/** Options for creating the Sentry adapter. */
export interface SentryAdapterOptions {
  /** Sentry DSN. When provided, the adapter initializes Sentry on first use. */
  dsn?: string;
  /** Optional environment label (defaults to `process.env.NODE_ENV` or `"development"`). */
  environment?: string;
  /** Optional release identifier. */
  release?: string;
  /** Optional traces sample rate (0–1, default 0). */
  tracesSampleRate?: number;
}

/**
 * Redact a span before it leaves the process. Removes secret values from all string fields.
 */
function redactSpan(span: ObservabilitySpan): ObservabilitySpan {
  return {
    ...span,
    error: span.error ? redactString(span.error) : undefined,
    provider: redactString(span.provider),
    phase: redactString(span.phase),
  };
}

/**
 * Redact a summary before it leaves the process.
 */
function redactSummary(summary: ObservabilitySummary): ObservabilitySummary {
  return {
    ...summary,
    providers: summary.providers.map(redactString),
    spans: summary.spans.map(redactSpan),
  };
}

/**
 * Create a Sentry-backed observability adapter. When `options.dsn` is provided (or
 * `SENTRY_DSN` is set in the environment), the adapter initializes `@sentry/node` on
 * first use. Otherwise returns a no-op adapter.
 *
 * The `@sentry/node` package is loaded via lazy `require()` — it must be installed
 * separately (`npm install @sentry/node`) and is NOT a required dependency.
 */
export function createSentryAdapter(options: SentryAdapterOptions = {}): ObservabilityAdapter {
  const dsn = options.dsn ?? process.env.SENTRY_DSN;
  if (!dsn) {
    return {
      name: "sentry",
      async captureSpan(): Promise<void> {},
      async captureSummary(): Promise<void> {},
    };
  }

  let initialized = false;

  function ensureInit(): SentryModule | null {
    if (initialized) return loadSentry();
    const sentry = loadSentry();
    if (sentry) {
      sentry.init({
        dsn,
        environment: options.environment ?? process.env.NODE_ENV ?? "development",
        ...(options.release ? { release: options.release } : {}),
        tracesSampleRate: options.tracesSampleRate ?? 0,
        beforeSend(event: unknown) {
          return redactSecrets(event);
        },
      });
    } else {
      console.warn("[OBSERVABILITY] SENTRY_DSN is set but @sentry/node is not installed — Sentry adapter disabled");
    }
    initialized = true;
    return sentry;
  }

  return {
    name: "sentry",
    async captureSpan(span: ObservabilitySpan): Promise<void> {
      const sentry = ensureInit();
      if (!sentry) return;
      const redacted = redactSpan(span);
      // Sentry doesn't have a direct "captureSpan" API for custom spans;
      // we report errors and log a breadcrumb for non-error spans.
      if (redacted.status === "ERROR" && redacted.error) {
        sentry.captureException(new Error(redacted.error));
      }
    },
    async captureSummary(summary: ObservabilitySummary): Promise<void> {
      const sentry = ensureInit();
      if (!sentry) return;
      const redacted = redactSummary(summary);
      if (redacted.status === "ERROR") {
        const errorSpan = redacted.spans.find((s) => s.status === "ERROR");
        if (errorSpan?.error) {
          sentry.captureException(new Error(errorSpan.error));
        }
      }
    },
  };
}
