// Feature: productization-alpha, Property 6: Benchmark result completeness
//
// Validates: Requirements 4.3
//
// For any completed benchmark task, the produced `BenchmarkResult` carries the
// required fields: a final status (the "result"), the executed commands, a cost
// estimate, a duration, and the task id / output directory — plus a patch when
// (and only when) the task produced one.
//
// The harness is exercised over synthetic, in-process `BenchmarkTask` doubles
// that resolve deterministically. They make ZERO provider or network calls: a
// task simply returns a scripted outcome (pass/fail), throws (failed), or never
// resolves so the harness terminates it (timeout). Each property iteration runs
// against its own freshly created OS temp directory which is removed afterwards,
// so no tracked repository file is ever touched.
import nodeFs from "node:fs/promises";
import nodeOs from "node:os";
import nodePath from "node:path";

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  BENCHMARK_FINAL_STATUSES,
  runBenchmark,
  type BenchmarkRunContext,
  type BenchmarkTask,
  type BenchmarkTaskOutcome,
} from "../src/benchmark";

/** How a synthetic task completes. All four are "completed" outcomes. */
type Behavior = "pass" | "fail" | "throw" | "timeout";

/** A generated description of one task's deterministic behavior. */
interface TaskSpec {
  behavior: Behavior;
  /** Non-empty patch when the task produces one; undefined when it does not. */
  patch?: string;
  commands: string[];
  costEstimateUsd: number;
}

const arbCommands = (): fc.Arbitrary<string[]> =>
  fc.array(fc.string(), { maxLength: 4 });

const arbTaskSpec = (): fc.Arbitrary<TaskSpec> =>
  fc.record({
    behavior: fc.constantFrom<Behavior>("pass", "fail", "throw", "timeout"),
    // `undefined` models "no patch produced"; a non-empty string models a
    // produced patch so the "patch when produced" check is unambiguous.
    patch: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
    commands: arbCommands(),
    costEstimateUsd: fc.double({ min: 0, max: 1000, noNaN: true }),
  });

/** Builds a deterministic, network-free task from a spec and a stable id. */
function makeTask(id: string, spec: TaskSpec): BenchmarkTask {
  return {
    id,
    description: `synthetic ${spec.behavior} task`,
    async setupFixture(): Promise<void> {
      // No fixture needed; the harness already created the workspace dir.
    },
    async run(_context: BenchmarkRunContext): Promise<BenchmarkTaskOutcome> {
      switch (spec.behavior) {
        case "throw":
          throw new Error("synthetic task failure");
        case "timeout":
          // Never resolves: the harness aborts it once the timeout elapses.
          return new Promise<BenchmarkTaskOutcome>(() => {});
        case "pass":
        case "fail":
          return {
            passed: spec.behavior === "pass",
            patch: spec.patch,
            commands: spec.commands,
            costEstimateUsd: spec.costEstimateUsd,
          };
      }
    },
  };
}

describe("benchmark result completeness (Property 6)", () => {
  it("every BenchmarkResult carries the required fields for any completed task", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbTaskSpec(), { minLength: 1, maxLength: 5 }),
        async (specs) => {
          // Unique ids by index avoid temp-directory collisions between tasks.
          const tasks = specs.map((spec, index) => makeTask(`task-${index}`, spec));

          const tmpRoot = await nodeFs.mkdtemp(
            nodePath.join(nodeOs.tmpdir(), "rector-bench-prop-"),
          );
          try {
            const summary = await runBenchmark(tasks, {
              mode: "deterministic",
              // Short timeout so the "timeout" behavior completes quickly.
              taskTimeoutMs: 40,
              now: () => "2026-01-01T00:00:00.000Z",
              tmpRoot,
            });

            // Every task yields exactly one result, so "for any completed task"
            // is covered by checking each result.
            expect(summary.results.length).toBe(tasks.length);

            summary.results.forEach((result, index) => {
              const spec = specs[index];

              // Task identity and output directory are present.
              expect(result.taskId).toBe(`task-${index}`);
              expect(typeof result.outputDir).toBe("string");
              expect(result.outputDir.length).toBeGreaterThan(0);

              // Final status (the "result") is one of the closed set.
              expect(BENCHMARK_FINAL_STATUSES).toContain(result.finalStatus);

              // Executed commands: always an array of strings.
              expect(Array.isArray(result.commands)).toBe(true);
              for (const command of result.commands) {
                expect(typeof command).toBe("string");
              }

              // Cost estimate: a finite number.
              expect(typeof result.costEstimateUsd).toBe("number");
              expect(Number.isFinite(result.costEstimateUsd)).toBe(true);

              // Duration: a non-negative number.
              expect(typeof result.durationMs).toBe("number");
              expect(Number.isFinite(result.durationMs)).toBe(true);
              expect(result.durationMs).toBeGreaterThanOrEqual(0);

              // Status maps from behavior, and the carried fields match.
              if (spec.behavior === "pass" || spec.behavior === "fail") {
                expect(result.finalStatus).toBe(
                  spec.behavior === "pass" ? "passed" : "failed",
                );
                expect(result.commands).toEqual(spec.commands);
                expect(result.costEstimateUsd).toBe(spec.costEstimateUsd);

                // Patch is present exactly when the task produced one.
                if (spec.patch === undefined) {
                  expect(result.patch).toBeUndefined();
                } else {
                  expect(result.patch).toBe(spec.patch);
                }
              } else if (spec.behavior === "throw") {
                expect(result.finalStatus).toBe("failed");
                expect(result.patch).toBeUndefined();
              } else {
                expect(result.finalStatus).toBe("timeout");
                expect(result.patch).toBeUndefined();
              }
            });
          } finally {
            await nodeFs.rm(tmpRoot, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 100 },
    );
  }, 60_000);
});
