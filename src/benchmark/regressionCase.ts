/**
 * Reusable regression-case scaffold for fixed benchmark failure modes
 * (productization-alpha, Requirement 5.1, 5.4).
 *
 * Prompt hardening (Requirement 5) is a process plus a regression-test harness:
 * when a failure mode recurs across the benchmark (two or more
 * `Benchmark_Result` records within a single cycle, Req 5.1) the `Prompt_Set` is
 * hardened, and the test suite must then include a regression case that
 * reproduces that failure mode and asserts the corrected behavior (Req 5.4).
 *
 * This module gives every fixed failure mode a single, uniform shape so a new
 * regression case is a small declaration rather than bespoke harness wiring. A
 * case declares two deterministic scenarios over an isolated `Fixture_Workspace`:
 *
 *   - `reproduceFailure` — the pre-hardening behavior. Run in a benchmark cycle
 *     it must FAIL (the failure mode is genuinely reproduced, Req 5.4).
 *   - `applyFix`         — the post-hardening behavior. Run in the *next*
 *     benchmark cycle it must PASS (the regression case now passes, Req 5.1/5.4).
 *
 * The scaffold runs the failure scenario `occurrences` times inside one
 * `runBenchmark` cycle (so the failure mode appears in two or more records,
 * matching the Req 5.1 hardening trigger) and the fix scenario in a second
 * cycle (the "next benchmark run"). It reuses the existing benchmark harness, so
 * everything runs against deterministic doubles with zero network/provider calls
 * and all output stays under a temporary root.
 */
import {
  type BenchmarkOptions,
  type BenchmarkRunContext,
  type BenchmarkSummary,
  type BenchmarkTask,
  type BenchmarkTaskOutcome,
} from "./types";
import { runBenchmark } from "./runBenchmark";

/** The Req 5.1 hardening trigger: a failure mode must recur in this many records within one cycle. */
export const REGRESSION_HARDENING_THRESHOLD = 2;

/**
 * One deterministic scenario over an isolated `Fixture_Workspace`. It mirrors a
 * {@link BenchmarkTask} minus the identity: `setupFixture` builds the workspace
 * and `run` exercises the behavior using the context's network-free doubles.
 */
export interface RegressionScenario {
  /** Builds the isolated fixture workspace under `workspaceDir` (Req 4.1, 4.4). */
  setupFixture(workspaceDir: string): Promise<void>;
  /** Exercises the behavior and returns its outcome (`passed` decides the status). */
  run(context: BenchmarkRunContext): Promise<BenchmarkTaskOutcome>;
}

/** A reusable declaration of a regression case for one fixed failure mode. */
export interface RegressionCaseDefinition {
  /** Stable identifier for the fixed failure mode (used to derive task ids). */
  readonly failureModeId: string;
  /** Human-language description of the failure mode being guarded. */
  readonly description: string;
  /**
   * How many times the failure scenario runs within the single failure cycle.
   * Must be at least {@link REGRESSION_HARDENING_THRESHOLD} so the mode appears
   * in two or more `Benchmark_Result` records (Req 5.1). Defaults to the
   * threshold.
   */
  readonly occurrences?: number;
  /** Pre-hardening behavior: must FAIL in a benchmark cycle (Req 5.4). */
  readonly reproduceFailure: RegressionScenario;
  /** Post-hardening behavior: must PASS in the next benchmark cycle (Req 5.1, 5.4). */
  readonly applyFix: RegressionScenario;
}

/** Structured outcome of running a regression case through both cycles. */
export interface RegressionCaseReport {
  readonly failureModeId: string;
  readonly description: string;
  /** Number of failure-scenario records produced in the failure cycle. */
  readonly occurrences: number;
  /** The benchmark summary for the failure (pre-hardening) cycle. */
  readonly failureSummary: BenchmarkSummary;
  /** The benchmark summary for the fixed (post-hardening) cycle. */
  readonly fixedSummary: BenchmarkSummary;
  /** Count of failure-scenario records whose final status was `failed`. */
  readonly reproducedFailureCount: number;
  /**
   * True when the failure mode recurred in two or more records within the single
   * failure cycle — the Req 5.1 trigger that justifies hardening the prompt set.
   */
  readonly qualifiesForHardening: boolean;
  /** True when every failure-scenario record failed (the mode is genuinely reproduced, Req 5.4). */
  readonly failureReproduced: boolean;
  /** True when every fixed-scenario record passed (the corrected behavior holds, Req 5.1, 5.4). */
  readonly correctedBehaviorPasses: boolean;
  /**
   * True when the case is a valid regression guard: the failure was reproduced,
   * recurred enough to qualify for hardening, and the fix passes (Req 5.1, 5.4).
   */
  readonly passed: boolean;
}

/** Subset of {@link BenchmarkOptions} a regression case may override. */
export type RegressionCaseOptions = Pick<BenchmarkOptions, "now" | "tmpRoot" | "taskTimeoutMs">;

/** Wraps a {@link RegressionScenario} as a {@link BenchmarkTask} with a stable id. */
function scenarioToTask(id: string, scenario: RegressionScenario, description: string): BenchmarkTask {
  return {
    id,
    description,
    setupFixture: (workspaceDir) => scenario.setupFixture(workspaceDir),
    run: (context) => scenario.run(context),
  };
}

/**
 * Runs a regression case for a fixed failure mode and returns a structured
 * {@link RegressionCaseReport}.
 *
 * Cycle 1 (failure): the `reproduceFailure` scenario runs `occurrences` times in
 * a single benchmark cycle; every record must fail and the count must reach the
 * hardening threshold (Req 5.1 trigger, Req 5.4 reproduction).
 *
 * Cycle 2 (fixed, the "next benchmark run"): the `applyFix` scenario runs the
 * same number of times; every record must pass (Req 5.1/5.4 corrected behavior).
 *
 * Both cycles use the existing benchmark harness in default deterministic mode,
 * so they make zero network/provider calls and write only under a temporary
 * root. When `tmpRoot` is supplied the two cycles are isolated under
 * `${tmpRoot}/failure` and `${tmpRoot}/fixed` so their fixtures never collide.
 *
 * Validates: Requirements 5.1, 5.4
 */
export async function runRegressionCase(
  definition: RegressionCaseDefinition,
  options: RegressionCaseOptions = {},
): Promise<RegressionCaseReport> {
  const occurrences = definition.occurrences ?? REGRESSION_HARDENING_THRESHOLD;
  if (occurrences < REGRESSION_HARDENING_THRESHOLD) {
    throw new Error(
      `Regression case "${definition.failureModeId}" must run the failure scenario at least ` +
        `${REGRESSION_HARDENING_THRESHOLD} times to model the Req 5.1 hardening trigger, got ${occurrences}.`,
    );
  }

  const failureTasks: BenchmarkTask[] = Array.from({ length: occurrences }, (_unused, index) =>
    scenarioToTask(
      `${definition.failureModeId}#failure-${index + 1}`,
      definition.reproduceFailure,
      `${definition.description} (failure reproduction ${index + 1}/${occurrences})`,
    ),
  );
  const fixedTasks: BenchmarkTask[] = Array.from({ length: occurrences }, (_unused, index) =>
    scenarioToTask(
      `${definition.failureModeId}#fixed-${index + 1}`,
      definition.applyFix,
      `${definition.description} (corrected behavior ${index + 1}/${occurrences})`,
    ),
  );

  const failureSummary = await runBenchmark(failureTasks, {
    mode: "deterministic",
    now: options.now,
    taskTimeoutMs: options.taskTimeoutMs,
    tmpRoot: options.tmpRoot ? `${options.tmpRoot}/failure` : undefined,
  });
  const fixedSummary = await runBenchmark(fixedTasks, {
    mode: "deterministic",
    now: options.now,
    taskTimeoutMs: options.taskTimeoutMs,
    tmpRoot: options.tmpRoot ? `${options.tmpRoot}/fixed` : undefined,
  });

  const reproducedFailureCount = failureSummary.results.filter(
    (result) => result.finalStatus === "failed",
  ).length;
  const failureReproduced =
    failureSummary.results.length > 0 && reproducedFailureCount === failureSummary.results.length;
  const qualifiesForHardening = reproducedFailureCount >= REGRESSION_HARDENING_THRESHOLD;
  const correctedBehaviorPasses =
    fixedSummary.results.length > 0 &&
    fixedSummary.results.every((result) => result.finalStatus === "passed");

  return {
    failureModeId: definition.failureModeId,
    description: definition.description,
    occurrences,
    failureSummary,
    fixedSummary,
    reproducedFailureCount,
    qualifiesForHardening,
    failureReproduced,
    correctedBehaviorPasses,
    passed: failureReproduced && qualifiesForHardening && correctedBehaviorPasses,
  };
}
