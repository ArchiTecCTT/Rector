import {
  type ZaiHarnessFailure,
  type ZaiHarnessScenarioStatus,
  ZAI_HARNESS_FAILURE_KINDS,
  type ZaiHarnessFailureKind,
} from "./harnessScorecard";
import type { ZaiLiveDiagnostics } from "./liveHarnessDiagnostics";
import { ZAI_LIVE_PROVIDER_FAILURE_TAXONOMY } from "./liveHarnessDiagnostics";

export interface HarnessProviderCallIntegritySlice {
  readonly scenarioId: string;
  readonly status: "passed" | "failed";
  readonly failure?: ZaiHarnessFailure;
}

export interface HarnessScenarioIntegritySlice {
  readonly scenarioId: string;
  readonly title: string;
  readonly kind: string;
  readonly status: ZaiHarnessScenarioStatus;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly runId: string | null;
  readonly runStatus: string | null;
  readonly runPhase: string | null;
  readonly synthesisStatus: string | null;
  readonly workspaceMutation: {
    readonly mutationDetected: boolean;
    readonly mutatedPaths: readonly string[];
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly changed: readonly string[];
  };
  readonly evidence: {
    readonly runEventCount: number;
    readonly factCount: number;
  };
  readonly tokenUsage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly estimatedUsd: number;
    readonly modelCalls: number;
  };
  readonly estimatedCostUsd: number;
  readonly failures: readonly ZaiHarnessFailure[];
}

/**
 * Align per-scenario harness status with recorded provider-call failures and live token usage.
 * Prevents orchestration paths that swallow provider errors from producing passing smoke evidence.
 */
export function reconcileHarnessScenarioReports<T extends HarnessScenarioIntegritySlice>(
  scenarios: readonly T[],
  providerCalls: readonly HarnessProviderCallIntegritySlice[],
): T[] {
  return scenarios.map((scenario) => {
    if (scenario.status === "skipped") return scenario;

    const failures = [...scenario.failures];
    const scenarioCalls = providerCalls.filter((call) => call.scenarioId === scenario.scenarioId);
    for (const call of scenarioCalls) {
      if (call.status === "failed" && call.failure) {
        failures.push(call.failure);
      }
    }

    const executedWithProviderAttempts = scenario.runId !== null && scenarioCalls.length > 0;
    const recordedLiveUsage = scenario.tokenUsage.modelCalls > 0;
    if (executedWithProviderAttempts && !recordedLiveUsage) {
      failures.push(missingLiveUsageFailure(scenario.scenarioId, scenarioCalls.length));
    }

    const deduped = dedupeHarnessFailures(failures);
    const status: ZaiHarnessScenarioStatus = deduped.length === 0 ? "passed" : "failed";
    if (status === scenario.status && deduped.length === scenario.failures.length) {
      const sameFailures = deduped.every((item, index) => sameHarnessFailure(item, scenario.failures[index]));
      if (sameFailures) return scenario;
    }
    return { ...scenario, failures: deduped, status };
  });
}

/** Report-level failures when diagnostics show provider failures but scenarios still look green. */
export function collectLiveHarnessIntegrityFailures(input: {
  readonly liveEvidenceStatus: "live_provider" | "test_only_injected" | "skipped";
  readonly scenarios: readonly HarnessScenarioIntegritySlice[];
  readonly providerCalls: readonly HarnessProviderCallIntegritySlice[];
  readonly diagnostics: ZaiLiveDiagnostics;
}): ZaiHarnessFailure[] {
  if (input.liveEvidenceStatus === "skipped") return [];

  const failures: ZaiHarnessFailure[] = [];
  const executedScenarios = input.scenarios.filter((scenario) => scenario.status !== "skipped");
  if (executedScenarios.length === 0) return failures;

  const failedProviderCalls = input.providerCalls.filter((call) => call.status === "failed");
  if (failedProviderCalls.length > 0 && executedScenarios.every((scenario) => scenario.failures.length === 0)) {
    failures.push({
      kind: "scorecard",
      message: `Harness recorded ${failedProviderCalls.length} failed provider call(s) but no scenario failures were attributed.`,
    });
  }

  const taxonomyFailures = sumProviderFailureTaxonomy(input.diagnostics.failureTaxonomy);
  if (taxonomyFailures > 0 && executedScenarios.every((scenario) => scenario.status === "passed")) {
    failures.push({
      kind: "scorecard",
      message: `Harness diagnostics recorded ${taxonomyFailures} provider failure(s) in taxonomy while all scenarios passed.`,
    });
  }

  const anyExecutedRun = executedScenarios.some((scenario) => scenario.runId !== null);
  const anyProviderAttempts = input.providerCalls.length > 0;
  const totalModelCalls = executedScenarios.reduce((sum, scenario) => sum + scenario.tokenUsage.modelCalls, 0);
  const scenariosStillPassing = executedScenarios.every((scenario) => scenario.status === "passed");
  if (anyExecutedRun && anyProviderAttempts && totalModelCalls <= 0 && scenariosStillPassing) {
    failures.push(missingLiveUsageFailure("campaign", input.providerCalls.length));
  }

  return dedupeHarnessFailures(failures);
}

function missingLiveUsageFailure(scope: string, providerAttemptCount: number): ZaiHarnessFailure {
  return {
    kind: "missing_live_usage",
    message: `Executed harness scenario ${scope} recorded ${providerAttemptCount} provider attempt(s) but zero successful live model usage (modelCalls/tokens).`,
  };
}

function sumProviderFailureTaxonomy(taxonomy: ZaiLiveDiagnostics["failureTaxonomy"]): number {
  return ZAI_LIVE_PROVIDER_FAILURE_TAXONOMY.reduce((sum, key) => sum + (taxonomy[key] ?? 0), 0);
}

function dedupeHarnessFailures(failures: readonly ZaiHarnessFailure[]): ZaiHarnessFailure[] {
  const seen = new Set<string>();
  const output: ZaiHarnessFailure[] = [];
  for (const item of failures) {
    const key = `${item.kind}:${item.message}:${item.detail ?? ""}:${item.taxonomy ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function sameHarnessFailure(left: ZaiHarnessFailure, right: ZaiHarnessFailure | undefined): boolean {
  if (!right) return false;
  return left.kind === right.kind
    && left.message === right.message
    && (left.detail ?? "") === (right.detail ?? "")
    && (left.taxonomy ?? "") === (right.taxonomy ?? "");
}

export function isHarnessFailureKind(value: string): value is ZaiHarnessFailureKind {
  return (ZAI_HARNESS_FAILURE_KINDS as readonly string[]).includes(value);
}