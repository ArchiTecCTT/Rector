import { describe, expect, it } from "vitest";
import fc from "fast-check";
import nodeFs from "node:fs/promises";
import nodeOs from "node:os";
import nodePath from "node:path";

import { runBenchmark } from "../src/benchmark/runBenchmark";
import {
  BENCHMARK_FINAL_STATUSES,
  type BenchmarkFinalStatus,
  type BenchmarkTask,
  type BenchmarkTaskOutcome,
} from "../src/benchmark/types";

/**
 * Task 6.4 — Benchmark summary counts consistency property test.
 *
 * **Property 8: Benchmark summary counts are consistent**
 * **Validates: Requirements 4.8**
 *
 * For any benchmark run, the summary's total task count equals the number of
 * results, and the sum of the per-status counts equals the total task count.
 *
 * The run is fully deterministic and network-free: each task is a synthetic
 * double whose `run` resolves to a scripted outcome (passed/failed) or hangs to
 * force a timeout. The harness writes only under an injected temporary output
 * root, so no tracked repository file is touched and zero provider/network
 * calls occur.
 */

/** A scripted final status the generated task should drive the harness toward. */
type ScriptedStatus = "passed" | "failed-outcome" | "throw" | "timeout";

/**
 * Builds a deterministic, network-free task that drives the harness to a known
 * final status. `setupFixture` only creates a marker file under the harness-
 * supplied workspace dir (always rooted in the temp output root).
 */
function makeScriptedTask(index: number, scripted: ScriptedStatus): BenchmarkTask {
  return {
    id: `task-${index}-${scripted}`,
    description: `Scripted ${scripted} task #${index}`,
    async setupFixture(workspaceDir: string): Promise<void> {
      await nodeFs.writeFile(nodePath.join(workspaceDir, "marker.txt"), scripted, "utf8");
    },
    async run(): Promise<BenchmarkTaskOutcome> {
      switch (scripted) {
        case "passed":
          return { passed: true, commands: [], costEstimateUsd: 0 };
        case "failed-outcome":
          return { passed: false, commands: [], costEstimateUsd: 0 };
        case "throw":
          throw new Error("scripted failure");
        case "timeout":
          // Never resolves; the harness aborts it via the configured timeout.
          return await new Promise<BenchmarkTaskOutcome>(() => {});
      }
    },
  };
}

const scriptedStatusArb: fc.Arbitrary<ScriptedStatus> = fc.constantFrom(
  "passed",
  "failed-outcome",
  "throw",
  "timeout",
);

describe("benchmark summary counts consistency (Property 8)", () => {
  // Feature: productization-alpha, Property 8: Benchmark summary counts are consistent
  it("total task count equals results length and equals the sum of per-status counts", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(scriptedStatusArb, { minLength: 0, maxLength: 6 }),
        async (scripts) => {
          const tmpRoot = await nodeFs.mkdtemp(
            nodePath.join(nodeOs.tmpdir(), "rector-bench-prop8-"),
          );
          try {
            const tasks = scripts.map((scripted, index) => makeScriptedTask(index, scripted));

            const summary = await runBenchmark(tasks, {
              mode: "deterministic",
              // A tiny timeout makes the "timeout" scripted tasks terminate fast
              // without slowing the property run.
              taskTimeoutMs: 25,
              now: () => "2024-01-01T00:00:00.000Z",
              tmpRoot,
            });

            // totalTasks equals the number of results and the number of tasks run.
            expect(summary.totalTasks).toBe(summary.results.length);
            expect(summary.totalTasks).toBe(tasks.length);

            // The sum of every per-status count equals the total task count.
            const summed = BENCHMARK_FINAL_STATUSES.reduce<number>(
              (acc, status: BenchmarkFinalStatus) => acc + summary.countsByStatus[status],
              0,
            );
            expect(summed).toBe(summary.totalTasks);
          } finally {
            await nodeFs.rm(tmpRoot, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 100 },
    );
  }, 60_000);
});
