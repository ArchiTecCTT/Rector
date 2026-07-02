export const ZAI_HARNESS_SCORECARD_SCHEMA_VERSION = "rector.zai-harness-scorecard.v1";

export const ZAI_HARNESS_FAILURE_KINDS = [
  "provider_config",
  "rate_limit",
  "quota",
  "provider_http",
  "provider_json",
  "http",
  "timeout",
  "json",
  "planner",
  "skeptic",
  "crucible",
  "unsafe_unexpected_mutation",
  "missing_evidence",
  "missing_live_usage",
  "secret_leak",
  "token_budget",
  "scorecard",
  "unknown",
] as const;

export type ZaiHarnessFailureKind = (typeof ZAI_HARNESS_FAILURE_KINDS)[number];
export type ZaiHarnessScenarioStatus = "passed" | "failed" | "skipped";

export interface ZaiHarnessFailure {
  readonly kind: ZaiHarnessFailureKind;
  readonly message: string;
  readonly detail?: string;
  readonly taxonomy?: string;
  readonly status?: number;
  readonly retryable?: boolean;
  readonly providerCode?: string;
}

export interface ZaiHarnessScorecardScenario {
  readonly scenarioId: string;
  readonly status: ZaiHarnessScenarioStatus;
  readonly failures: readonly ZaiHarnessFailure[];
  readonly mutationDetected: boolean;
  readonly runEventCount: number;
  readonly factCount: number;
}

export interface ZaiHarnessScorecard {
  readonly schemaVersion: typeof ZAI_HARNESS_SCORECARD_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly passed: boolean;
  readonly scenarioCount: number;
  readonly passedCount: number;
  readonly failedCount: number;
  readonly skippedCount: number;
  readonly failureCounts: Record<ZaiHarnessFailureKind, number>;
  readonly mutationFree: boolean;
  readonly evidenceComplete: boolean;
  readonly noSecretLeaks: boolean;
  readonly withinTokenBudget: boolean;
  readonly notes: readonly string[];
}

export function buildZaiHarnessScorecard(input: {
  readonly generatedAt: string;
  readonly scenarios: readonly ZaiHarnessScorecardScenario[];
  readonly secretLeakCount: number;
  readonly withinTokenBudget: boolean;
}): ZaiHarnessScorecard {
  const failureCounts = emptyFailureCounts();
  for (const scenario of input.scenarios) {
    for (const failure of scenario.failures) {
      failureCounts[failure.kind] += 1;
    }
  }

  const passedCount = input.scenarios.filter((scenario) => scenario.status === "passed").length;
  const failedCount = input.scenarios.filter((scenario) => scenario.status === "failed").length;
  const skippedCount = input.scenarios.filter((scenario) => scenario.status === "skipped").length;
  const mutationFree = input.scenarios.every((scenario) => !scenario.mutationDetected);
  const evidenceComplete = input.scenarios
    .filter((scenario) => scenario.status !== "skipped")
    .every((scenario) => scenario.runEventCount > 0 && scenario.factCount > 0);
  const noSecretLeaks = input.secretLeakCount === 0;
  const passed = failedCount === 0 &&
    skippedCount === 0 &&
    mutationFree &&
    evidenceComplete &&
    noSecretLeaks &&
    input.withinTokenBudget;

  return {
    schemaVersion: ZAI_HARNESS_SCORECARD_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    passed,
    scenarioCount: input.scenarios.length,
    passedCount,
    failedCount,
    skippedCount,
    failureCounts,
    mutationFree,
    evidenceComplete,
    noSecretLeaks,
    withinTokenBudget: input.withinTokenBudget,
    notes: [
      "Scorecard requires all mandatory B1-B3 scenarios to avoid source mutation.",
      "Run events and fact-ledger rows are required for every executed scenario.",
      "Skipped scenarios are acceptable only for opt-in/provider-selection skip reports, not completed harness runs.",
    ],
  };
}

export function renderZaiHarnessScorecardMarkdown(scorecard: ZaiHarnessScorecard): string {
  const lines: string[] = [];
  lines.push("# Z.ai Harness Scorecard", "");
  lines.push(`- Schema: \`${scorecard.schemaVersion}\``);
  lines.push(`- Generated: ${scorecard.generatedAt}`);
  lines.push(`- Passed: ${scorecard.passed}`);
  lines.push(`- Scenarios: ${scorecard.passedCount} passed / ${scorecard.failedCount} failed / ${scorecard.skippedCount} skipped`);
  lines.push(`- Mutation free: ${scorecard.mutationFree}`);
  lines.push(`- Evidence complete: ${scorecard.evidenceComplete}`);
  lines.push(`- No secret leaks: ${scorecard.noSecretLeaks}`);
  lines.push(`- Within token budget: ${scorecard.withinTokenBudget}`);
  lines.push("", "## Failure Counts", "");
  lines.push("| kind | count |");
  lines.push("| --- | ---: |");
  for (const kind of ZAI_HARNESS_FAILURE_KINDS) {
    lines.push(`| \`${kind}\` | ${scorecard.failureCounts[kind]} |`);
  }
  lines.push("", "## Notes", "");
  for (const note of scorecard.notes) lines.push(`> ${safeMarkdown(note)}`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function emptyFailureCounts(): Record<ZaiHarnessFailureKind, number> {
  return Object.fromEntries(ZAI_HARNESS_FAILURE_KINDS.map((kind) => [kind, 0])) as Record<ZaiHarnessFailureKind, number>;
}

function safeMarkdown(value: string): string {
  return value.replace(/[|\n\r]/g, " ").slice(0, 240);
}
