/**
 * Benchmark harness script entry point (productization-alpha, Requirement 4).
 *
 * Runs the version-controlled default task set and prints a summary with the
 * total task count and per-status counts (Req 4.8). The default mode is
 * deterministic with no network calls (Req 4.2); pass `--live` to run the same
 * task set in the manual live-provider mode (Req 4.6). All output is written
 * under a temporary root, never to tracked repository files (Req 4.4).
 *
 * Usage:
 *   node dist/bin/benchmark.js [--live] [--timeout-ms <n>] [--out <dir>]
 */
import { runBenchmark } from "../benchmark";
import { DEFAULT_BENCHMARK_TASKS } from "../benchmark/tasks";
import type { BenchmarkMode } from "../benchmark/types";

function parseArgs(argv: string[]): { mode: BenchmarkMode; taskTimeoutMs?: number; tmpRoot?: string } {
  let mode: BenchmarkMode = "deterministic";
  let taskTimeoutMs: number | undefined;
  let tmpRoot: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--live") {
      mode = "live";
    } else if (arg === "--timeout-ms") {
      const value = Number(argv[i + 1]);
      if (Number.isFinite(value) && value > 0) taskTimeoutMs = value;
      i += 1;
    } else if (arg === "--out") {
      tmpRoot = argv[i + 1];
      i += 1;
    }
  }

  return { mode, taskTimeoutMs, tmpRoot };
}

async function main(): Promise<void> {
  const { mode, taskTimeoutMs, tmpRoot } = parseArgs(process.argv.slice(2));

  const summary = await runBenchmark(DEFAULT_BENCHMARK_TASKS, { mode, taskTimeoutMs, tmpRoot });

  console.log(`Rector benchmark (${summary.mode}) — ${summary.totalTasks} task(s)`);
  console.log(`Output root: ${summary.outputRoot}`);
  console.log(
    `Status counts: passed=${summary.countsByStatus.passed} ` +
      `failed=${summary.countsByStatus.failed} timeout=${summary.countsByStatus.timeout}`,
  );
  for (const result of summary.results) {
    console.log(
      `  - ${result.taskId}: ${result.finalStatus} (${result.durationMs}ms)` +
        (result.detail ? ` — ${result.detail}` : ""),
    );
  }

  // A non-passing task set exits non-zero so the script is usable as a gate.
  const allPassed = summary.countsByStatus.passed === summary.totalTasks;
  process.exitCode = allPassed ? 0 : 1;
}

main().catch((error) => {
  console.error(`Benchmark run failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
