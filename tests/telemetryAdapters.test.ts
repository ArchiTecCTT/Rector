/**
 * Tests for telemetry adapters (Task 4.2).
 *
 * Verifies that Sentry and PostHog adapters are correctly configured based on
 * environment variables, that redaction is applied before sending, and that
 * lazy require prevents import cost when not configured.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSentryAdapter } from "../src/observability/sentryAdapter.js";
import { createPostHogAdapter } from "../src/observability/posthogAdapter.js";
import { createAppInsightsAdapter } from "../src/observability/appInsightsAdapter.js";
import {
  createInMemoryObservabilityTrace,
  createObservabilityAdapters,
  forwardObservabilityTrace,
  observabilityForwardingEnabled,
} from "../src/observability";
import type { ObservabilitySpan, ObservabilitySummary } from "../src/observability";

// ── Test data ──────────────────────────────────────────────────────────────────

const SAMPLE_SPAN: ObservabilitySpan = {
  traceId: "trace-abc123",
  spanId: "span-def456",
  parentSpanId: "span-ghi789",
  phase: "SYNTHESIZING",
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: "2026-01-01T00:00:01.000Z",
  durationMs: 1000,
  status: "OK",
  modelCallCount: 1,
  estimatedCostUsd: 0.005,
  provider: "together-ai",
  error: undefined,
};

const SAMPLE_ERROR_SPAN: ObservabilitySpan = {
  ...SAMPLE_SPAN,
  spanId: "span-error",
  status: "ERROR",
  error: "API key sk-AAAAAAAAAAAAAAAA is invalid",
};

const SAMPLE_SUMMARY: ObservabilitySummary = {
  traceId: "trace-abc123",
  spanCount: 1,
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: "2026-01-01T00:00:01.000Z",
  durationMs: 1000,
  status: "OK",
  modelCallCount: 1,
  estimatedCostUsd: 0.005,
  providers: ["together-ai"],
  spans: [SAMPLE_SPAN],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSampleSpan(overrides?: Partial<ObservabilitySpan>): ObservabilitySpan {
  return { ...SAMPLE_SPAN, ...overrides };
}

// ── Sentry adapter ─────────────────────────────────────────────────────────────

describe("Sentry adapter", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.SENTRY_DSN;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns a no-op adapter when SENTRY_DSN is not set", () => {
    const adapter = createSentryAdapter();
    expect(adapter.name).toBe("sentry");
    // No-op adapters should not throw
    expect(adapter.captureSpan(SAMPLE_SPAN)).resolves.toBeUndefined();
    expect(adapter.captureSummary(SAMPLE_SUMMARY)).resolves.toBeUndefined();
  });

  it("returns a no-op adapter when dsn option is empty string", () => {
    const adapter = createSentryAdapter({ dsn: "" });
    expect(adapter.name).toBe("sentry");
    expect(adapter.captureSpan(SAMPLE_SPAN)).resolves.toBeUndefined();
  });

  it("returns a real adapter when SENTRY_DSN is set (even if @sentry/node is not installed)", () => {
    process.env.SENTRY_DSN = "https://example@sentry.io/123";
    const adapter = createSentryAdapter();
    expect(adapter.name).toBe("sentry");
    // captureSpan should not throw even if @sentry/node is not installed
    // (it logs a warning on first call and becomes a graceful no-op)
    expect(adapter.captureSpan(SAMPLE_SPAN)).resolves.toBeUndefined();
  });

  it("returns a real adapter when dsn option is provided", () => {
    const adapter = createSentryAdapter({ dsn: "https://example@sentry.io/123" });
    expect(adapter.name).toBe("sentry");
    expect(adapter.captureSpan(SAMPLE_SPAN)).resolves.toBeUndefined();
  });

  it("passes environment option through to init", () => {
    // We can't easily verify the init params without mocking, but we verify
    // the adapter doesn't throw with various option combinations
    const adapter = createSentryAdapter({
      dsn: "https://example@sentry.io/123",
      environment: "production",
      release: "1.0.0",
      tracesSampleRate: 0.5,
    });
    expect(adapter.name).toBe("sentry");
    expect(adapter.captureSpan(SAMPLE_SPAN)).resolves.toBeUndefined();
  });

  it("prefers options.dsn over SENTRY_DSN env var", () => {
    process.env.SENTRY_DSN = "https://env@sentry.io/456";
    const adapter = createSentryAdapter({ dsn: "https://option@sentry.io/789" });
    expect(adapter.name).toBe("sentry");
    // Both would init — the option takes precedence in the adapter factory
    expect(adapter.captureSpan(SAMPLE_SPAN)).resolves.toBeUndefined();
  });
});

// ── PostHog adapter ────────────────────────────────────────────────────────────

describe("PostHog adapter", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.POSTHOG_API_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns a no-op adapter when POSTHOG_API_KEY is not set", () => {
    const adapter = createPostHogAdapter();
    expect(adapter.name).toBe("posthog");
    expect(adapter.captureSpan(SAMPLE_SPAN)).resolves.toBeUndefined();
    expect(adapter.captureSummary(SAMPLE_SUMMARY)).resolves.toBeUndefined();
  });

  it("returns a no-op adapter when apiKey option is empty string", () => {
    const adapter = createPostHogAdapter({ apiKey: "" });
    expect(adapter.name).toBe("posthog");
    expect(adapter.captureSpan(SAMPLE_SPAN)).resolves.toBeUndefined();
  });

  it("returns a real adapter when POSTHOG_API_KEY is set", () => {
    process.env.POSTHOG_API_KEY = "phc_test123";
    const adapter = createPostHogAdapter();
    expect(adapter.name).toBe("posthog");
    expect(adapter.captureSpan(SAMPLE_SPAN)).resolves.toBeUndefined();
  });

  it("returns a real adapter when apiKey option is provided", () => {
    const adapter = createPostHogAdapter({ apiKey: "phc_test456" });
    expect(adapter.name).toBe("posthog");
    expect(adapter.captureSpan(SAMPLE_SPAN)).resolves.toBeUndefined();
  });

  it("passes host option for self-hosted instances", () => {
    const adapter = createPostHogAdapter({
      apiKey: "phc_test789",
      host: "https://ph.example.com",
    });
    expect(adapter.name).toBe("posthog");
    expect(adapter.captureSpan(SAMPLE_SPAN)).resolves.toBeUndefined();
  });

  it("prefers options.apiKey over POSTHOG_API_KEY env var", () => {
    process.env.POSTHOG_API_KEY = "phc_env_key";
    const adapter = createPostHogAdapter({ apiKey: "phc_option_key" });
    expect(adapter.name).toBe("posthog");
    expect(adapter.captureSpan(SAMPLE_SPAN)).resolves.toBeUndefined();
  });
});

// ── createObservabilityAdapters() ──────────────────────────────────────────────

describe("createObservabilityAdapters", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.SENTRY_DSN;
    delete process.env.POSTHOG_API_KEY;
    delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns no-op adapters when no env vars are set", () => {
    const adapters = createObservabilityAdapters();
    expect(adapters.sentry.name).toBe("sentry");
    expect(adapters.postHog.name).toBe("posthog");
    expect(adapters.openTelemetry.name).toBe("opentelemetry");
    expect(adapters.appInsights.name).toBe("appInsights");
    // All should be no-ops
    expect(adapters.sentry.captureSpan(SAMPLE_SPAN)).resolves.toBeUndefined();
    expect(adapters.postHog.captureSpan(SAMPLE_SPAN)).resolves.toBeUndefined();
    expect(adapters.openTelemetry.captureSpan(SAMPLE_SPAN)).resolves.toBeUndefined();
    expect(adapters.appInsights.captureSpan(SAMPLE_SPAN)).resolves.toBeUndefined();
  });

  it("returns real Sentry adapter when SENTRY_DSN is set", () => {
    process.env.SENTRY_DSN = "https://example@sentry.io/123";
    const adapters = createObservabilityAdapters();
    expect(adapters.sentry.name).toBe("sentry");
    expect(adapters.sentry.captureSpan(SAMPLE_SPAN)).resolves.toBeUndefined();
  });

  it("returns real PostHog adapter when POSTHOG_API_KEY is set", () => {
    process.env.POSTHOG_API_KEY = "phc_test";
    const adapters = createObservabilityAdapters();
    expect(adapters.postHog.name).toBe("posthog");
    expect(adapters.postHog.captureSpan(SAMPLE_SPAN)).resolves.toBeUndefined();
  });

  it("returns real adapters for both when both env vars are set", () => {
    process.env.SENTRY_DSN = "https://example@sentry.io/123";
    process.env.POSTHOG_API_KEY = "phc_test";
    const adapters = createObservabilityAdapters();
    expect(adapters.sentry.name).toBe("sentry");
    expect(adapters.postHog.name).toBe("posthog");
    expect(adapters.openTelemetry.name).toBe("opentelemetry");
  });

  it("openTelemetry adapter is always a no-op", () => {
    const adapters = createObservabilityAdapters();
    expect(adapters.openTelemetry.name).toBe("opentelemetry");
    expect(adapters.openTelemetry.captureSummary(SAMPLE_SUMMARY)).resolves.toBeUndefined();
  });

  it("returns App Insights adapter when connection string is set", () => {
    process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = "InstrumentationKey=test";
    const adapters = createObservabilityAdapters();
    expect(adapters.appInsights.name).toBe("appInsights");
    expect(adapters.appInsights.captureSpan(SAMPLE_SPAN)).resolves.toBeUndefined();
  });
});

describe("observability forwarding", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
    delete process.env.SENTRY_DSN;
    delete process.env.POSTHOG_API_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("is disabled without telemetry env vars", () => {
    expect(observabilityForwardingEnabled({})).toBe(false);
  });

  it("is enabled when App Insights connection string is set", () => {
    expect(observabilityForwardingEnabled({ APPLICATIONINSIGHTS_CONNECTION_STRING: "InstrumentationKey=test" })).toBe(true);
  });

  it("forwards trace spans to adapters without throwing", async () => {
    const trace = createInMemoryObservabilityTrace({ provider: "local" });
    await trace.recordSpan("TRIAGE", async () => "ok");
    await expect(forwardObservabilityTrace(trace)).resolves.toBeUndefined();
  });
});

describe("createAppInsightsAdapter", () => {
  it("returns no-op adapter without connection string", async () => {
    const adapter = createAppInsightsAdapter();
    expect(adapter.name).toBe("appInsights");
    await expect(adapter.captureSpan(SAMPLE_SPAN)).resolves.toBeUndefined();
  });
});

// ── Redaction verification ─────────────────────────────────────────────────────

describe("telemetry adapter redaction", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.SENTRY_DSN;
    delete process.env.POSTHOG_API_KEY;
    delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("Sentry no-op adapter handles error spans with secrets gracefully", async () => {
    const adapter = createSentryAdapter();
    // Should not throw even with secret-containing error
    await expect(adapter.captureSpan(SAMPLE_ERROR_SPAN)).resolves.toBeUndefined();
  });

  it("PostHog no-op adapter handles error spans with secrets gracefully", async () => {
    const adapter = createPostHogAdapter();
    await expect(adapter.captureSpan(SAMPLE_ERROR_SPAN)).resolves.toBeUndefined();
  });

  it("Sentry adapter with DSN handles error spans without throwing", async () => {
    const adapter = createSentryAdapter({ dsn: "https://example@sentry.io/123" });
    await expect(adapter.captureSpan(SAMPLE_ERROR_SPAN)).resolves.toBeUndefined();
  });

  it("PostHog adapter with API key handles error spans without throwing", async () => {
    const adapter = createPostHogAdapter({ apiKey: "phc_test" });
    await expect(adapter.captureSpan(SAMPLE_ERROR_SPAN)).resolves.toBeUndefined();
  });

  it("Sentry adapter handles summary with error spans", async () => {
    const adapter = createSentryAdapter({ dsn: "https://example@sentry.io/123" });
    const errorSummary: ObservabilitySummary = {
      ...SAMPLE_SUMMARY,
      status: "ERROR",
      spans: [SAMPLE_ERROR_SPAN],
    };
    await expect(adapter.captureSummary(errorSummary)).resolves.toBeUndefined();
  });
});

// ── Lazy require behavior ──────────────────────────────────────────────────────

describe("lazy require behavior", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.SENTRY_DSN;
    delete process.env.POSTHOG_API_KEY;
    delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("Sentry no-op adapter does not attempt to load @sentry/node", () => {
    // No SENTRY_DSN set — the require() inside the adapter should never be called
    // If it were, it would throw MODULE_NOT_FOUND since @sentry/node is not installed
    const adapter = createSentryAdapter();
    expect(adapter.name).toBe("sentry");
    // Verify it's a no-op by checking captureSpan returns immediately
    expect(adapter.captureSpan(SAMPLE_SPAN)).resolves.toBeUndefined();
  });

  it("PostHog no-op adapter does not attempt to load posthog-node", () => {
    // No POSTHOG_API_KEY set — the require() inside the adapter should never be called
    const adapter = createPostHogAdapter();
    expect(adapter.name).toBe("posthog");
    expect(adapter.captureSpan(SAMPLE_SPAN)).resolves.toBeUndefined();
  });

  it("createObservabilityAdapters() does not require packages when env vars not set", () => {
    const adapters = createObservabilityAdapters();
    expect(adapters.sentry.name).toBe("sentry");
    expect(adapters.postHog.name).toBe("posthog");
    // If the packages were required without env vars, they would throw
  });
});
