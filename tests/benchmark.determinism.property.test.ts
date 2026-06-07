import { describe, expect, it } from "vitest";
import fc from "fast-check";
import nodeFs from "node:fs/promises";
import nodeOs from "node:os";
import nodePath from "node:path";

import { runBenchmark } from "../src/benchmark/runBenchmark";
import { DEFAULT_BENCHMARK_TASKS } from "../src/benchmark/tasks";
import type { BenchmarkTask, BenchmarkTaskOutcome } from "../src/benchmark/types";

/**
 * Task 6.5 — Benchmark default-mode determinism property test.
 *
 * **Property 9: Benchmark determinism in default mode**
 * **Validates: Requirements 4.9**
 *
 * For any fixed task set executed twice in default deterministic mode, the
 * per-task final status values are identical across both executions.
 *
 * Both executions are fully deterministic and network-free: every task is a
 * synthetic double whose `run` resolves to a scripted outcome (passed/failed)
 * or hangs to force a timeout, plus the version-controlled
 * `DEFAULT_BENCHMARK_TASKS` (which use the sandbox with an injected, network-
 * free command runner). The harness writes only under an injected temporary
 * output root, so no tracked repository file is touched and zero
 * provider/network calls occur.
 */

/** A scripted final status the generated task should drive the harness toward. */
type ScriptedStatus = "passed" | "failed-outcome" | "throw" | "timeout";

/**
 * Builds a deterministic, network-free task that drives the harness to a known
 * final status. `setupFixture` only creates a marker file under the harness-
 * supplied workspace dir (always rooted in the temp output root). The task is
 * stateless across runs, so executing it twice yields the same final status.
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

/** Runs the supplied tasks once in default deterministic mode under the given temp root. */
async function runInto(
  tasks: BenchmarkTask[],
  tmpRoot: string,
  taskTimeoutMs: number,
): Promise<Map<string, string>> {
  const summary = await runBenchmark(tasks, {
    // Default deterministic mode (mode omitted to exercise the default).
    taskTimeoutMs,
    now: () => "2024-01-01T00:00:00.000Z",
    tmpRoot,
  });
  return new Map(summary.results.map((result) => [result.taskId, result.finalStatus]));
}

/**
 * Executes `tasks` twice in default deterministic mode and asserts the per-task
 * final status values are identical across both runs (Req 4.9). Both runs share
 * a single temporary root (in separate sub-roots) to bound filesystem churn;
 * nothing outside the temp root is touched and no network call is made.
 */
async function expectDeterministicAcrossTwoRuns(
  tasks: BenchmarkTask[],
  taskTimeoutMs: number,
): Promise<void> {
  const tmpRoot = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "rector-bench-prop9-"));
  try {
    const firstRun = await runInto(tasks, nodePath.join(tmpRoot, "run-a"), taskTimeoutMs);
    const secondRun = await runInto(tasks, nodePath.join(tmpRoot, "run-b"), taskTimeoutMs);

    // Same set of task ids across both runs.
    expect([...secondRun.keys()].sort()).toEqual([...firstRun.keys()].sort());

    // Identical final status for every task across both executions (Req 4.9).
    for (const [taskId, status] of firstRun) {
      expect(secondRun.get(taskId)).toBe(status);
    }
  } finally {
    await nodeFs.rm(tmpRoot, { recursive: true, force: true });
  }
}

describe("benchmark default-mode determinism (Property 9)", () => {
  // Feature: productization-alpha, Property 9: Benchmark determinism in default mode
  it("two deterministic-mode runs over the same tasks yield identical per-task final statuses", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(scriptedStatusArb, { minLength: 0, maxLength: 4 }), async (scripts) => {
        const tasks = scripts.map((scripted, index) => makeScriptedTask(index, scripted));
        // A tiny timeout makes the "timeout" scripted tasks terminate fast; the
        // other scripted tasks resolve instantly, so the status is stable.
        await expectDeterministicAcrossTwoRuns(tasks, 25);
      }),
      { numRuns: 100 },
    );
  }, 180_000);

  // Feature: productization-alpha, Property 9: Benchmark determinism in default mode
  it("the version-controlled default task set yields identical final statuses across runs", async () => {
    // A generous timeout so the real fixture tasks complete deterministically
    // rather than racing an artificially tiny budget (mirrors the harness default).
    await expectDeterministicAcrossTwoRuns(DEFAULT_BENCHMARK_TASKS, 60_000);
  }, 60_000);
});
