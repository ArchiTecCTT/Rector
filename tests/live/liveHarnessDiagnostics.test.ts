import { describe, expect, it } from "vitest";

import { ProviderError } from "../../src/providers/llm";
import {
  aggregateNumericStats,
  buildLiveHarnessScenarioDiagnostics,
  buildZaiLiveDiagnostics,
  classifyLiveHarnessBottleneck,
  classifyLiveProviderFailure,
  classifyLiveProviderFailureFromError,
  providerRawHasReasoningContent,
  renderZaiLiveDiagnosticsMarkdown,
  summarizeMatrixCampaignFailure,
  ZAI_LIVE_DIAGNOSTICS_SCHEMA_VERSION,
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

  it("classifies orchestration timeout separately from provider timeout", () => {
    expect(
      classifyLiveHarnessBottleneck({
        failureMessage: "Orchestration timeout exceeded",
        orchestrationTimeout: true,
      }),
    ).toBe("orchestration_timeout");
    expect(
      classifyLiveHarnessBottleneck({
        failureKind: "timeout",
        failureMessage: "OpenAI-Compatible request aborted",
      }),
    ).toBe("provider_timeout");
    expect(
      classifyLiveHarnessBottleneck({
        finishReason: "length",
        failureMessage: "JSON parse failed",
      }),
    ).toBe("truncated_json");
  });

  it("detects reasoning content metadata without returning raw text", () => {
    const raw = {
      choices: [{ message: { content: "{}", reasoning_content: "hidden chain" }, finish_reason: "stop" }],
    };
    expect(providerRawHasReasoningContent(raw)).toBe(true);
    expect(providerRawHasReasoningContent({ choices: [{ message: { content: "{}" } }] })).toBe(false);
  });

  it("includes bottleneck taxonomy in diagnostics v2", () => {
    const diagnostics = buildZaiLiveDiagnostics({
      bottleneckTaxonomy: { orchestration_timeout: 2 },
      tokens: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        modelCalls: 0,
        estimatedCostUsd: 0,
      },
      harnessMaxRuntimeMs: 180_000,
    });
    expect(diagnostics.schemaVersion).toBe(ZAI_LIVE_DIAGNOSTICS_SCHEMA_VERSION);
    expect(diagnostics.bottleneckTaxonomy.orchestration_timeout).toBe(2);
    expect(diagnostics.harnessMaxRuntimeMs).toBe(180_000);
    expect(renderZaiLiveDiagnosticsMarkdown(diagnostics)).toContain("Bottleneck taxonomy");
  });

  it("omits first failing step and bottleneck for passed scenarios even when event log mentions crucible", () => {
    const diagnostics = buildLiveHarnessScenarioDiagnostics({
      scenarioId: "read-only-smoke",
      failures: [],
      eventText: JSON.stringify([{ type: "crucible", phase: "arbitration" }, { type: "run-complete" }]),
      providerCalls: [{ task: "planner", metadata: { structuredRole: "planner" } }],
      configuredMaxRuntimeMs: 120_000,
    });
    expect(diagnostics.scenarioId).toBe("read-only-smoke");
    expect(diagnostics.firstFailingStep).toBeUndefined();
    expect(diagnostics.bottleneckClass).toBeUndefined();
    expect(diagnostics.providerCalls).toBe(1);
  });

  it("classifies first failing step and bottleneck for failed scenarios", () => {
    const diagnostics = buildLiveHarnessScenarioDiagnostics({
      scenarioId: "timeout-case",
      failures: [{ kind: "timeout", message: "Orchestration timeout exceeded" }],
      eventText: JSON.stringify([{ type: "orchestration-timeout" }]),
      providerCalls: [],
      configuredMaxRuntimeMs: 120_000,
      orchestrationTimeout: true,
    });
    expect(diagnostics).toMatchObject({
      scenarioId: "timeout-case",
      firstFailingStep: "orchestration",
      bottleneckClass: "orchestration_timeout",
    });
  });

  it("summarizes matrix campaign first failing step", () => {
    expect(
      summarizeMatrixCampaignFailure({
        steps: [{ stepId: "eval:facts:live", exitCode: 0 }, { stepId: "test:live:zai:harness", exitCode: 1 }],
        campaignFailed: true,
      }),
    ).toMatchObject({ firstFailingStep: "test:live:zai:harness", bottleneckClass: "unknown" });
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
        rating: "gate_and_harness_pass",
        evidenceSnapshotDir: ".rector/evidence/live/zai/matrix/glm-4/0",
        reportPointers: {
          latestJson: ".rector/evidence/live/zai/latest.json",
          latestMd: ".rector/evidence/live/zai/latest.md",
          providerSmokeJson: ".rector/evidence/live/zai/provider-smoke.json",
          phase2ShadowJson: ".rector/evidence/phase2/live-fact-shadow-report.json",
        },
        snapshotCopiedFiles: [],
        snapshotSkippedArtifacts: [],
        snapshotHealth: "empty",
        snapshotEffectiveModelId: "glm-4",
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