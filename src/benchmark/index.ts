/**
 * Benchmark harness public surface (productization-alpha, Requirement 4).
 *
 * Re-exports the harness types, the `runBenchmark` entry point, and the
 * version-controlled default task set so consumers (the script entry point and
 * tests) import from a single module.
 */
export { runBenchmark } from "./runBenchmark";
export {
  DEFAULT_BENCHMARK_TASKS,
  addFileTask,
  readConfigTask,
  runBuildCommandTask,
} from "./tasks";
export {
  REGRESSION_HARDENING_THRESHOLD,
  runRegressionCase,
  type RegressionCaseDefinition,
  type RegressionCaseOptions,
  type RegressionCaseReport,
  type RegressionScenario,
} from "./regressionCase";
export {
  BENCHMARK_FINAL_STATUSES,
  DEFAULT_TASK_TIMEOUT_MS,
  type BenchmarkFinalStatus,
  type BenchmarkMode,
  type BenchmarkOptions,
  type BenchmarkResult,
  type BenchmarkRunContext,
  type BenchmarkSummary,
  type BenchmarkTask,
  type BenchmarkTaskOutcome,
} from "./types";
