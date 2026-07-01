import { describe, expect, it } from "vitest";

import { ProviderError } from "../../src/providers/llm";
import {
  aggregateNumericStats,
  buildZaiLiveDiagnostics,
  classifyLiveProviderFailure,
  classifyLiveProviderFailureFromError,
  renderZaiLiveDiagnosticsMarkdown,
} from "../../src/live/liveHarnessDiagnostics";
import { buildMatrixDiagnostics } from "../../src/live/zaiModelMatrix";

describe("liveHarnessDiagnostics", () => {
  it("classifies rate limits and quota separately from generic HTTP failures", () => {
    expect(classifyLiveProviderFailure({ status: 429, message: "too many requests" }).taxonomy).toBe("rate_limit");
    expect(classifyLiveProviderFailure({ status: 402, message: "insufficient balance" }).taxonomy).toBe("quota");
    expect(classifyLiveProviderFailure({ status: 500, message: "server error" }).taxonomy).toBe("provider_http");
  });

  it("reuses ProviderError metadata when classifying thrown provider failures", () => {
    const error = new ProviderError({
      code: "PROVIDER_HTTP_ERROR",
      provider: "openai-compatible",
      status: 401,
      retryable: false,
      message: "OpenAI-Compatible request failed with HTTP 401",
    });
    expect(classifyLiveProviderFailureFromError(error)).toMatchObject({
      taxonomy: "provider_http",
      status: 401,
      retryable: false,
      providerCode: "PROVIDER_HTTP_ERROR",
    });
  });

  it("computes latency percentiles and token aggregates", () => {
    const stats = aggregateNumericStats([10, 20, 30, 40, 100]);
    expect(stats).toMatchObject({ count: 5, min: 10, max: 100, p50: 30, p95: 100 });

    const diagnostics = buildZaiLiveDiagnostics({
      failureTaxonomy: { rate_limit: 1 },
      providerCallLatencyMs: [12, 48],
      scenarioDurationMs: [100, 200],
      tokens: {
        inputTokens: 30,
        outputTokens: 10,
        totalTokens: 40,
        modelCalls: 2,
        estimatedCostUsd: 0.01,
      },
    });
    expect(diagnostics.failureTaxonomy.rate_limit).toBe(1);
    expect(diagnostics.tokens.totalTokens).toBe(40);
    expect(renderZaiLiveDiagnosticsMarkdown(diagnostics)).toContain("Provider failure taxonomy");
  });

  it("aggregates matrix campaign and step durations", () => {
    const diagnostics = buildMatrixDiagnostics([
      {
        modelId: "glm-4",
        safeModelId: "glm-4",
        runIndex: 0,
        status: "pass",
        durationMs: 500,
        steps: [{ stepId: "a", command: "npm run x", envKeys: [], exitCode: 0, durationMs: 100 }],
        grade: "A",
        rating: "verified_pass",
        evidenceSnapshotDir: ".rector/evidence/live/zai/matrix/glm-4/0",
        reportPointers: {
          latestJson: ".rector/evidence/live/zai/latest.json",
          latestMd: ".rector/evidence/live/zai/latest.md",
          providerSmokeJson: ".rector/evidence/live/zai/provider-smoke.json",
          phase2ShadowJson: ".rector/evidence/phase2/live-fact-shadow-report.json",
        },
        gate: {
          providerId: "zai",
          adapterId: "openai-compatible",
          modelId: "glm-4",
          host: "api.z.ai",
          harnessStatus: "passed",
          scenariosPassed: 3,
          scenariosTotal: 3,
          campaignTokens: 1200,
          campaignTokenLimit: 100_000,
          campaignModelCalls: 3,
          estimatedCostUsd: 0.01,
          latestMarkdown: ".rector/evidence/live/zai/latest.md",
          manifestUpdated: false,
        },
      },
    ]);
    expect(diagnostics.latencyMs.campaigns).toMatchObject({ count: 1, min: 500, max: 500 });
    expect(diagnostics.latencyMs.matrixSteps).toMatchObject({ count: 1, min: 100, max: 100 });
    expect(diagnostics.tokens.totalTokens).toBe(1200);
  });
});