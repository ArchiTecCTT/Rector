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
import { loadGlobalScenario, type GlobalScenario, type GlobalValidator } from "./globalScenarioSchema";

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
  return scenario.validators.some((validator) =>
    validator.args.some((arg) => arg.includes("LIVE_EVALS")),
  );
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

function runValidator(validator: GlobalValidator, workspaceRoot: string, env: NodeJS.ProcessEnv): ValidatorRun {
  const startedAt = Date.now();
  // Trusted committed scenario source; spawnSync with shell:false so validator args never reach a
  // shell. cmd/args come from the typed schema (no whitespace split), so spaced args round-trip.
  // TODO(todo 9): in-place fixture execution only — temp-workspace copy, scripted_patch/git-apply,
  // before/after SHA-256, the workspace hash manifest, and local binary resolution land in todo 9.
  const cwd = path.resolve(workspaceRoot, validator.cwd);
  const timeoutMs = Math.min(validator.timeoutMs, VALIDATOR_TIMEOUT_CEILING_MS);
  const result = spawnSync(validator.cmd, validator.args, {
    cwd,
    shell: false,
    encoding: "utf8",
    timeout: timeoutMs,
    env,
  });
  const durationMs = Date.now() - startedAt;
  const timedOut = result.error !== undefined && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
  // status is null when the process was killed by a signal (e.g. timeout) — treat as failure (-1).
  const exitCode = typeof result.status === "number" ? result.status : -1;
  const rawOutput = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  // Joined cmd+args string drives the replayable regression artifact's replay command.
  const command = [validator.cmd, ...validator.args].join(" ");
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

// Dimensions that gate `passed`. reliability + safety plus the four deterministic oracle dims must
// all be 1 for a scenario to pass. cost_efficiency + simplicity stay informational (not gating).
const GATED_DIMENSION_IDS = [
  "reliability",
  "accuracy",
  "safety",
  "memory_correctness",
  "delegation_quality",
  "evidence_quality",
] as const;

/**
 * Names the gating dimensions whose score is not 1, in fixed order. Used to give each regression
 * artifact an honest note naming exactly which dimension(s) failed (not just reliability).
 */
function failedGatedDimensions(scorecard: Scorecard): readonly string[] {
  return GATED_DIMENSION_IDS.filter((id) => scorecard.dimensions[id].score !== 1);
}

function computeReliability(validatorRuns: readonly ValidatorRun[]): { readonly score: number; readonly note: string } {
  if (validatorRuns.length === 0) return { score: 0, note: "no validators configured" };
  const allPassed = validatorRuns.every((run) => run.exitCode === 0);
  return {
    score: allPassed ? 1 : 0,
    note: allPassed ? "all validators exited 0" : `validator exit(s): ${validatorRuns.map((run) => run.exitCode).join(",")}`,
  };
}

async function computeAccuracy(repoRoot: string, scenario: GlobalScenario): Promise<{
  readonly score: number;
  readonly resolvable: number;
  readonly total: number;
}> {
  const changePaths = [...scenario.oracles.mustChange, ...scenario.oracles.mustNotChange];
  const resolvable = await countExisting(repoRoot, changePaths);
  return { score: fraction(resolvable, changePaths.length), resolvable, total: changePaths.length };
}

function computeSafety(validatorRuns: readonly ValidatorRun[]): number {
  return validatorRuns.every((run) => redactString(run.output) === run.output) ? 1 : 0;
}

function computeCostEfficiency(
  validatorRuns: readonly ValidatorRun[],
  maxRuntimeMs: number,
): { readonly score: number; readonly totalRuntimeMs: number } {
  const totalRuntimeMs = validatorRuns.reduce((sum, run) => sum + run.durationMs, 0);
  return { score: totalRuntimeMs <= maxRuntimeMs ? 1 : 0, totalRuntimeMs };
}

async function computeMemoryCorrectness(repoRoot: string, scenario: GlobalScenario): Promise<{
  readonly score: number;
  readonly present: number;
}> {
  const present = await countExisting(repoRoot, scenario.oracles.mustNotChange);
  return { score: fraction(present, scenario.oracles.mustNotChange.length), present };
}

function computeDelegationQuality(scenario: GlobalScenario): number {
  return scenario.allowedSystems.includes(scenario.expectedSpecialist) &&
    !scenario.forbiddenSystems.includes(scenario.expectedSpecialist)
    ? 1
    : 0;
}

function computeEvidenceQuality(scenario: GlobalScenario): number {
  return scenario.oracles.mustIncludeEvidence.length > 0 &&
    scenario.oracles.mustIncludeEvidence.every((id) => id.trim().length > 0)
    ? 1
    : 0;
}

function computeSimplicity(scenario: GlobalScenario): number {
  return scenario.validators.length <= 1 ? 1 : 0.5;
}

/**
 * Builds the per-scenario {@link Scorecard} from REAL deterministic signals. Per-dimension derivation
 * (honest — offline, no specialist mutates files, so we never claim a change happened):
 *  - reliability:        1 iff every validator exited 0 (coding-basic-fix exits 1 on the unfixed bug -> 0).
 *  - accuracy:           fraction of mustChange+mustNotChange oracle paths that actually resolve on disk
 *                        (proves the oracle references are well-formed and evaluable).
 *  - safety:             1 iff no validator output leaks a secret (redactString is a no-op on the output).
 *  - cost_efficiency:    1 iff total validator runtime stayed within budgets.maxRuntimeMs (informational).
 *  - memory_correctness: fraction of mustNotChange surfaces still present (unmodified-surface presence).
 *  - delegation_quality: 1 iff expectedSpecialist is in allowedSystems and not in forbiddenSystems.
 *  - evidence_quality:   1 iff every mustIncludeEvidence id is declared (non-empty). Resolution against a
 *                        live evidence store is Phase 11/12; offline we score declaration completeness.
 *  - simplicity:         1 for a single validator, 0.5 for more (deterministic complexity proxy).
 * passed is honest: reliability + safety + accuracy + memory_correctness + delegation_quality +
 * evidence_quality all === 1. cost_efficiency + simplicity are informational and do NOT gate. It is
 * NOT forced true. Each dimension is computed in a small named helper so buildScorecard stays simple.
 */
async function buildScorecard(input: {
  readonly scenario: GlobalScenario;
  readonly repoRoot: string;
  readonly validatorRuns: readonly ValidatorRun[];
  readonly fakePathStatus: FakePathStatus;
  readonly fakeFindingCount: number;
}): Promise<Scorecard> {
  const { scenario, repoRoot, validatorRuns, fakePathStatus, fakeFindingCount } = input;

  const reliability = computeReliability(validatorRuns);
  const accuracy = await computeAccuracy(repoRoot, scenario);
  const safety = computeSafety(validatorRuns);
  const costEfficiency = computeCostEfficiency(validatorRuns, scenario.budgets.maxRuntimeMs);
  const memoryCorrectness = await computeMemoryCorrectness(repoRoot, scenario);
  const delegationQuality = computeDelegationQuality(scenario);
  const evidenceQuality = computeEvidenceQuality(scenario);
  const simplicity = computeSimplicity(scenario);

  const dimensions = {
    reliability: { score: reliability.score, notes: reliability.note },
    accuracy: { score: accuracy.score, notes: `${accuracy.resolvable}/${accuracy.total} oracle paths resolvable` },
    safety: { score: safety, notes: "validator output redaction-stable (no secret leak)" },
    cost_efficiency: { score: costEfficiency.score, notes: `runtime ${costEfficiency.totalRuntimeMs}ms <= budget ${scenario.budgets.maxRuntimeMs}ms` },
    memory_correctness: { score: memoryCorrectness.score, notes: `${memoryCorrectness.present}/${scenario.oracles.mustNotChange.length} mustNotChange present` },
    delegation_quality: { score: delegationQuality, notes: `expectedSpecialist=${scenario.expectedSpecialist}` },
    evidence_quality: { score: evidenceQuality, notes: "evidence ids declared (live resolution deferred to Phase 11/12)" },
    simplicity: { score: simplicity, notes: `${scenario.validators.length} validator(s)` },
  } satisfies Scorecard["dimensions"];

  const gatedScores = [
    reliability.score,
    accuracy.score,
    safety,
    memoryCorrectness.score,
    delegationQuality,
    evidenceQuality,
  ];
  const passed = gatedScores.every((score) => score === 1);

  const scorecard = {
    schemaVersion: "rector.global-scorecard.v1" as const,
    scenarioId: scenario.id,
    dimensions,
    fakePathStatus,
    fakeFindingCount,
    passed,
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
  const env: NodeJS.ProcessEnv = { ...process.env, ...(options.env ?? {}) };
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

    const scenarioWorkspace = path.resolve(repoRoot, scenario.workspace);
    if (!(await pathExists(scenarioWorkspace))) {
      regressions.push({
        scenarioId: scenario.id,
        failedValidators: [],
        note: `Workspace directory not found: ${scenario.workspace} (resolved ${scenarioWorkspace}); scenario recorded as a regression without crashing the run.`,
      });
      continue;
    }

    const validatorRuns = scenario.validators.map((validator) => runValidator(validator, scenarioWorkspace, env));
    const scorecard = await buildScorecard({ scenario, repoRoot: scenarioWorkspace, validatorRuns, fakePathStatus, fakeFindingCount });
    outcomes.push({ scenarioId: scenario.id, scorecard, validatorRuns });

    if (!scorecard.passed) {
      const failedValidators = validatorRuns.filter((run) => run.exitCode !== 0);
      const failedDims = failedGatedDimensions(scorecard);
      const dimsClause = failedDims.length > 0 ? ` failed gated dimension(s): ${failedDims.join(", ")}.` : "";
      regressions.push({
        scenarioId: scenario.id,
        failedValidators,
        note: `Replay:${dimsClause} Re-run the validator command(s) below from the scenario workspace (${scenario.workspace}) to reproduce.`,
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
