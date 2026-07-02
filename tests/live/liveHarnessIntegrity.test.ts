import { describe, expect, it } from "vitest";

import {
  collectLiveHarnessIntegrityFailures,
  reconcileHarnessScenarioReports,
} from "../../src/live/liveHarnessIntegrity";
import { buildZaiLiveDiagnostics } from "../../src/live/liveHarnessDiagnostics";

const BASE_SCENARIO = {
  scenarioId: "B1",
  title: "Read-only",
  kind: "read_only",
  startedAt: "2026-07-01T00:00:00.000Z",
  completedAt: "2026-07-01T00:01:00.000Z",
  durationMs: 60_000,
  runId: "run-1",
  runStatus: "needs_decision",
  runPhase: "NEEDS_DECISION",
  synthesisStatus: "NEEDS_DECISION",
  workspaceMutation: {
    mutationDetected: false,
    mutatedPaths: [] as string[],
    added: [] as string[],
    removed: [] as string[],
    changed: [] as string[],
  },
  evidence: { runEventCount: 5, factCount: 11 },
  tokenUsage: {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedUsd: 0,
    modelCalls: 0,
  },
  estimatedCostUsd: 0,
  status: "passed" as const,
  failures: [] as const,
};

describe("live harness integrity reconciliation", () => {
  it("fails scenarios that swallowed provider HTTP failures with zero live usage", () => {
    const reconciled = reconcileHarnessScenarioReports(
      [BASE_SCENARIO],
      [
        {
          scenarioId: "B1",
          status: "failed",
          failure: {
            kind: "provider_http",
            message: "OpenAI-Compatible request failed with HTTP 503",
            taxonomy: "provider_http",
            status: 503,
          },
        },
      ],
    );

    expect(reconciled[0].status).toBe("failed");
    expect(reconciled[0].failures).toContainEqual(expect.objectContaining({ kind: "provider_http" }));
    expect(reconciled[0].failures).toContainEqual(expect.objectContaining({ kind: "missing_live_usage" }));
  });

  it("matches glm-4.7-flash style illusion reports (passed scenarios, failed provider calls, zero tokens)", () => {
    const scenarios = ["B1", "B2", "B3"].map((scenarioId, index) => ({
      ...BASE_SCENARIO,
      scenarioId,
      runId: `run-${index + 1}`,
      status: "passed" as const,
    }));
    const providerCalls = [
      { scenarioId: "B1", status: "failed" as const, failure: { kind: "rate_limit" as const, message: "HTTP 429", taxonomy: "rate_limit" } },
      { scenarioId: "B2", status: "failed" as const, failure: { kind: "provider_http" as const, message: "HTTP 503", taxonomy: "provider_http" } },
      { scenarioId: "B2", status: "failed" as const, failure: { kind: "provider_http" as const, message: "HTTP 503 retry", taxonomy: "provider_http" } },
      { scenarioId: "B3", status: "failed" as const, failure: { kind: "provider_http" as const, message: "HTTP 500", taxonomy: "provider_http" } },
    ];

    const reconciled = reconcileHarnessScenarioReports(scenarios, providerCalls);
    expect(reconciled.every((scenario) => scenario.status === "failed")).toBe(true);
    expect(reconciled.every((scenario) => scenario.failures.length > 0)).toBe(true);

    const diagnostics = buildZaiLiveDiagnostics({
      failureTaxonomy: { rate_limit: 1, quota: 0, timeout: 0, provider_http: 3, provider_json: 0, unknown: 0 },
      bottleneckTaxonomy: { truncated_json: 0, schema_contract: 0, provider_timeout: 0, orchestration_timeout: 0, context_overflow: 0, max_tokens_rejected: 0, reasoning_content_present: 0, unknown: 4 },
      providerCallLatencyMs: [256, 60333, 92333, 53323],
      scenarioDurationMs: [61478, 63153, 92875],
      tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0, modelCalls: 0, estimatedCostUsd: 0 },
    });
    const reportFailures = collectLiveHarnessIntegrityFailures({
      liveEvidenceStatus: "live_provider",
      scenarios: reconciled,
      providerCalls,
      diagnostics,
    });
    expect(reportFailures).toHaveLength(0);
  });

  it("adds report-level integrity failures when diagnostics taxonomy conflicts with passing scenarios", () => {
    const diagnostics = buildZaiLiveDiagnostics({
      failureTaxonomy: { rate_limit: 1, quota: 0, timeout: 0, provider_http: 2, provider_json: 0, unknown: 0 },
      bottleneckTaxonomy: { truncated_json: 0, schema_contract: 0, provider_timeout: 0, orchestration_timeout: 0, context_overflow: 0, max_tokens_rejected: 0, reasoning_content_present: 0, unknown: 2 },
      providerCallLatencyMs: [100, 200],
      scenarioDurationMs: [1000],
      tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0, modelCalls: 0, estimatedCostUsd: 0 },
    });
    const failures = collectLiveHarnessIntegrityFailures({
      liveEvidenceStatus: "live_provider",
      scenarios: [{ ...BASE_SCENARIO, status: "passed" }],
      providerCalls: [],
      diagnostics,
    });
    expect(failures).toContainEqual(expect.objectContaining({ kind: "scorecard" }));
  });
});