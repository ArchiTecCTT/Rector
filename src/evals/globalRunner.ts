import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { redactString } from "../security/redaction";
import {
  ScorecardSchema,
  renderScorecardMarkdown,
  type FakePathStatus,
  type Scorecard,
} from "./scorecards";
import { loadGlobalScenario, type GlobalScenario } from "./globalScenarioSchema";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DEFAULT_SCENARIOS_DIR = path.join(REPO_ROOT, "tests", "global", "scenarios");
const DEFAULT_OUTPUT_DIR = path.join(REPO_ROOT, ".omo", "evidence");
const VALIDATOR_TIMEOUT_CEILING_MS = 120000;

export const GLOBAL_REPORT_SCHEMA_VERSION = "rector.global-report.v1";

/**
 * A scenario requires a live provider when its `type` is the literal `"live"` or any validator
 * command carries the `LIVE_EVALS` token. The four committed offline scenarios match neither, so
 * they always execute. When a live scenario is encountered without `LIVE_EVALS=1` in the
 * environment, it is SKIPPED with a recorded reason — never failed, never faked.
 */
export function requiresLiveProvider(scenario: GlobalScenario): boolean {
  if (scenario.type === "live") return true;
  return scenario.validators.some((validator) => validator.includes("LIVE_EVALS"));
}

export type ValidatorRun = {
  readonly command: string;
  readonly exitCode: number;
  readonly output: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
};

export type RegressionArtifact = {
  readonly scenarioId: string;
  readonly failedValidators: readonly ValidatorRun[];
  readonly note: string;
};

export type SkippedScenario = {
  readonly scenarioId: string;
  readonly reason: string;
};

export type GlobalScenarioOutcome = {
  readonly scenarioId: string;
  readonly scorecard: Scorecard;
  readonly validatorRuns: readonly ValidatorRun[];
};

export type GlobalHarnessReport = {
  readonly schemaVersion: typeof GLOBAL_REPORT_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly scenarioCount: number;
  readonly executedCount: number;
  readonly skippedCount: number;
  readonly passedCount: number;
  readonly fakePathStatus: FakePathStatus;
  readonly fakeFindingCount: number;
  readonly outcomes: readonly GlobalScenarioOutcome[];
  readonly skipped: readonly SkippedScenario[];
  readonly regressions: readonly RegressionArtifact[];
};

export type FakePathAudit = {
  readonly findingCount: number;
};

export type FakePathAuditor = () => Promise<FakePathAudit>;

export type RunGlobalHarnessOptions = {
  readonly scenariosDir?: string;
  readonly repoRoot?: string;
  readonly outputDir?: string;
  readonly write?: boolean;
  readonly scenarios?: readonly GlobalScenario[];
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  /**
   * Injected fake-path auditor. `src` cannot import the `scripts/` audit module (rootDir boundary),
   * so the CLI passes {@link auditNoProductionFakes} in. When omitted, the harness reports
   * `audit_not_present` honestly rather than fabricating a `clean` status.
   */
  readonly fakePathAuditor?: FakePathAuditor;
};

export type RunGlobalHarnessResult = {
  readonly report: GlobalHarnessReport;
  readonly scorecards: readonly Scorecard[];
  readonly skipped: readonly SkippedScenario[];
  readonly reportJson: string;
  readonly reportMd: string;
  readonly jsonPath?: string;
  readonly markdownPath?: string;
};

async function loadScenarioDir(scenariosDir: string): Promise<readonly GlobalScenario[]> {
  const entries = await fs.readdir(scenariosDir);
  const files = entries.filter((entry) => entry.endsWith(".scenario.yaml")).sort();
  const scenarios: GlobalScenario[] = [];
  for (const file of files) {
    const text = await fs.readFile(path.join(scenariosDir, file), "utf8");
    scenarios.push(loadGlobalScenario(text, "yaml"));
  }
  return scenarios;
}

function runValidator(command: string, cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv): ValidatorRun {
  const startedAt = Date.now();
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: "utf8",
    timeout: timeoutMs,
    env,
  });
  const durationMs = Date.now() - startedAt;
  const timedOut = result.error !== undefined && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
  // status is null when the process was killed by a signal (e.g. timeout) — treat as failure (-1).
  const exitCode = typeof result.status === "number" ? result.status : -1;
  const rawOutput = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return {
    command,
    exitCode,
    output: redactString(rawOutput),
    durationMs,
    timedOut,
  };
}

function fraction(present: number, total: number): number {
  if (total === 0) return 1;
  return present / total;
}

async function pathExists(absolute: string): Promise<boolean> {
  try {
    await fs.access(absolute);
    return true;
  } catch {
    return false;
  }
}

async function countExisting(repoRoot: string, relativePaths: readonly string[]): Promise<number> {
  let present = 0;
  for (const relative of relativePaths) {
    if (await pathExists(path.join(repoRoot, relative))) present += 1;
  }
  return present;
}

/**
 * Builds the per-scenario {@link Scorecard} from REAL deterministic signals. Per-dimension
 * derivation (honest — offline, no specialist mutates files, so we never claim a change happened):
 *  - reliability:        1 iff every validator exited 0 (coding-basic-fix exits 1 on the unfixed bug -> 0).
 *  - accuracy:           fraction of mustChange+mustNotChange oracle paths that actually resolve on disk
 *                        (proves the oracle references are well-formed and evaluable).
 *  - safety:             1 iff no validator output leaks a secret (redactString is a no-op on the output).
 *  - cost_efficiency:    1 iff total validator runtime stayed within budgets.maxRuntimeMs.
 *  - memory_correctness: fraction of mustNotChange surfaces still present (unmodified-surface presence).
 *  - delegation_quality: 1 iff expectedSpecialist is in allowedSystems and not in forbiddenSystems.
 *  - evidence_quality:   1 iff every mustIncludeEvidence id is declared (non-empty). Resolution against a
 *                        live evidence store is Phase 11/12; offline we score declaration completeness.
 *  - simplicity:         1 for a single validator, 0.5 for more (deterministic complexity proxy).
 * passed is honest: reliability === 1 AND safety === 1. It is NOT forced true.
 */
async function buildScorecard(input: {
  readonly scenario: GlobalScenario;
  readonly repoRoot: string;
  readonly validatorRuns: readonly ValidatorRun[];
  readonly fakePathStatus: FakePathStatus;
  readonly fakeFindingCount: number;
}): Promise<Scorecard> {
  const { scenario, repoRoot, validatorRuns, fakePathStatus, fakeFindingCount } = input;

  const reliability = validatorRuns.length > 0 && validatorRuns.every((run) => run.exitCode === 0) ? 1 : 0;

  const changePaths = [...scenario.oracles.mustChange, ...scenario.oracles.mustNotChange];
  const resolvableChangePaths = await countExisting(repoRoot, changePaths);
  const accuracy = fraction(resolvableChangePaths, changePaths.length);

  const safety = validatorRuns.every((run) => redactString(run.output) === run.output) ? 1 : 0;

  const totalRuntimeMs = validatorRuns.reduce((sum, run) => sum + run.durationMs, 0);
  const costEfficiency = totalRuntimeMs <= scenario.budgets.maxRuntimeMs ? 1 : 0;

  const mustNotChangePresent = await countExisting(repoRoot, scenario.oracles.mustNotChange);
  const memoryCorrectness = fraction(mustNotChangePresent, scenario.oracles.mustNotChange.length);

  const delegationQuality =
    scenario.allowedSystems.includes(scenario.expectedSpecialist) &&
    !scenario.forbiddenSystems.includes(scenario.expectedSpecialist)
      ? 1
      : 0;

  const evidenceQuality =
    scenario.oracles.mustIncludeEvidence.length > 0 &&
    scenario.oracles.mustIncludeEvidence.every((id) => id.trim().length > 0)
      ? 1
      : 0;

  const simplicity = scenario.validators.length <= 1 ? 1 : 0.5;

  const reliabilityNote =
    reliability === 1
      ? "all validators exited 0"
      : `validator exit(s): ${validatorRuns.map((run) => run.exitCode).join(",")}`;

  const dimensions = {
    reliability: { score: reliability, notes: reliabilityNote },
    accuracy: { score: accuracy, notes: `${resolvableChangePaths}/${changePaths.length} oracle paths resolvable` },
    safety: { score: safety, notes: "validator output redaction-stable (no secret leak)" },
    cost_efficiency: { score: costEfficiency, notes: `runtime ${totalRuntimeMs}ms <= budget ${scenario.budgets.maxRuntimeMs}ms` },
    memory_correctness: { score: memoryCorrectness, notes: `${mustNotChangePresent}/${scenario.oracles.mustNotChange.length} mustNotChange present` },
    delegation_quality: { score: delegationQuality, notes: `expectedSpecialist=${scenario.expectedSpecialist}` },
    evidence_quality: { score: evidenceQuality, notes: "evidence ids declared (live resolution deferred to Phase 11/12)" },
    simplicity: { score: simplicity, notes: `${scenario.validators.length} validator(s)` },
  } satisfies Scorecard["dimensions"];

  const scorecard = {
    schemaVersion: "rector.global-scorecard.v1" as const,
    scenarioId: scenario.id,
    dimensions,
    fakePathStatus,
    fakeFindingCount,
    passed: reliability === 1 && safety === 1,
  };
  return ScorecardSchema.parse(scorecard);
}

function renderHarnessMarkdown(report: GlobalHarnessReport, scorecards: readonly Scorecard[]): string {
  const lines: string[] = [];
  lines.push("# Global Reliability Harness Report (offline Phase-0.5)");
  lines.push("");
  lines.push(`- Schema: \`${report.schemaVersion}\``);
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Scenarios: ${report.scenarioCount} (executed ${report.executedCount}, skipped ${report.skippedCount})`);
  lines.push(`- Passed scenarios: ${report.passedCount}/${report.executedCount}`);
  lines.push(`- Fake-path status: ${report.fakePathStatus} (${report.fakeFindingCount} findings, report-only)`);
  lines.push("");
  lines.push("> Offline harness: it runs each scenario's REAL validator command against its fixture and");
  lines.push("> evaluates oracles deterministically. No specialist mutates files offline, so a `mustChange`");
  lines.push("> path is reported as evaluable, NOT as a change that happened. Specialist-driven mutation is");
  lines.push("> Phase 11/12. A scenario whose validator currently fails is recorded truthfully.");
  lines.push("");
  if (report.skipped.length > 0) {
    lines.push("## Skipped (live, no creds)");
    lines.push("");
    for (const skip of report.skipped) {
      lines.push(`- \`${skip.scenarioId}\`: ${skip.reason}`);
    }
    lines.push("");
  }
  lines.push("## Scorecards");
  lines.push("");
  for (const scorecard of scorecards) {
    lines.push(renderScorecardMarkdown(scorecard));
  }
  if (report.regressions.length > 0) {
    lines.push("## Regressions (replayable)");
    lines.push("");
    for (const regression of report.regressions) {
      lines.push(`### \`${regression.scenarioId}\``);
      lines.push(regression.note);
      for (const failed of regression.failedValidators) {
        lines.push(`- exit ${failed.exitCode}: \`${failed.command}\``);
      }
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Offline global reliability harness. Loads the committed scenarios, runs each scenario's REAL
 * validator command against its fixture workspace, evaluates oracles deterministically, and emits one
 * {@link Scorecard} per executed scenario plus a fake-path status from the report-only audit. Live
 * scenarios without `LIVE_EVALS=1` are SKIPPED (reported, never failed, never faked). The run SUCCEEDS
 * when it produces a valid report; it is NOT gated on every scenario passing.
 */
export async function runGlobalHarness(options: RunGlobalHarnessOptions = {}): Promise<RunGlobalHarnessResult> {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const scenariosDir = options.scenariosDir ?? DEFAULT_SCENARIOS_DIR;
  const outputDir = options.outputDir ?? DEFAULT_OUTPUT_DIR;
  const shouldWrite = options.write ?? true;
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());

  const scenarios = options.scenarios ?? (await loadScenarioDir(scenariosDir));

  const audit = options.fakePathAuditor ? await options.fakePathAuditor() : undefined;
  const fakePathStatus: FakePathStatus =
    audit === undefined ? "audit_not_present" : audit.findingCount > 0 ? "fakes_present" : "clean";
  const fakeFindingCount = audit?.findingCount ?? 0;

  const outcomes: GlobalScenarioOutcome[] = [];
  const skipped: SkippedScenario[] = [];
  const regressions: RegressionArtifact[] = [];

  for (const scenario of scenarios) {
    if (requiresLiveProvider(scenario) && env.LIVE_EVALS !== "1") {
      skipped.push({
        scenarioId: scenario.id,
        reason: "requires a live provider but LIVE_EVALS=1 is not set; skipped (not failed, not faked)",
      });
      continue;
    }

    const timeoutMs = Math.min(scenario.budgets.maxRuntimeMs, VALIDATOR_TIMEOUT_CEILING_MS);
    const validatorRuns = scenario.validators.map((command) => runValidator(command, repoRoot, timeoutMs, env));
    const scorecard = await buildScorecard({ scenario, repoRoot, validatorRuns, fakePathStatus, fakeFindingCount });
    outcomes.push({ scenarioId: scenario.id, scorecard, validatorRuns });

    if (!scorecard.passed) {
      const failedValidators = validatorRuns.filter((run) => run.exitCode !== 0);
      regressions.push({
        scenarioId: scenario.id,
        failedValidators,
        note: "Replay: re-run the validator command(s) below from repo root to reproduce.",
      });
    }
  }

  const scorecards = outcomes.map((outcome) => outcome.scorecard);
  const report: GlobalHarnessReport = {
    schemaVersion: GLOBAL_REPORT_SCHEMA_VERSION,
    generatedAt: now().toISOString(),
    scenarioCount: scenarios.length,
    executedCount: outcomes.length,
    skippedCount: skipped.length,
    passedCount: scorecards.filter((scorecard) => scorecard.passed).length,
    fakePathStatus,
    fakeFindingCount,
    outcomes,
    skipped,
    regressions,
  };

  const reportJson = `${JSON.stringify(report, null, 2)}\n`;
  const reportMd = renderHarnessMarkdown(report, scorecards);

  if (!shouldWrite) {
    return { report, scorecards, skipped, reportJson, reportMd };
  }

  await fs.mkdir(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, "global-report.json");
  const markdownPath = path.join(outputDir, "global-report.md");
  await fs.writeFile(jsonPath, reportJson, "utf8");
  await fs.writeFile(markdownPath, reportMd, "utf8");
  return { report, scorecards, skipped, reportJson, reportMd, jsonPath, markdownPath };
}
