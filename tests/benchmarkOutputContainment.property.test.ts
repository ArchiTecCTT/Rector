// Feature: productization-alpha, Property 7: Benchmark output containment
//
// Validates: Requirements 4.4
//
// For any benchmark run in the default (deterministic) mode, EVERY filesystem
// write performed by the harness, its fixture setup, and the tasks themselves
// occurs UNDER the configured temporary output root, and NO tracked repository
// file is modified. We prove this by spying on the low-level write surfaces the
// harness and the workspace sandbox actually use:
//   - `node:fs/promises` `mkdir` / `writeFile` (harness output + fixture setup)
//   - `node:fs` `writeFileSync` (the sandbox `PROPOSE_PATCH` file write)
// and asserting every absolute path passed to them resolves inside the run's
// temporary output root. Because that root lives under the OS temp directory —
// far from the repository working tree — containment under it is exactly the
// guarantee that no tracked repository file is touched.
//
// The run uses deterministic test doubles only (the sandbox's network-free
// command runner via the default task set); it makes ZERO provider or network
// calls.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import fsPromises from "node:fs/promises";
import fsSync, { mkdtempSync, rmSync } from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";

import { runBenchmark, DEFAULT_BENCHMARK_TASKS } from "../src/benchmark";
import type { BenchmarkTask } from "../src/benchmark";

// Spies that record the path argument of every write-causing call. `vi.spyOn`
// preserves (calls through to) the real implementation, so the harness and
// sandbox behave normally while we observe their write targets.
const mkdirSpy = vi.spyOn(fsPromises, "mkdir");
const writeFileSpy = vi.spyOn(fsPromises, "writeFile");
const writeFileSyncSpy = vi.spyOn(fsSync, "writeFileSync");

// A fetch guard: the default deterministic mode must make zero network calls.
const fetchSpy = vi.spyOn(globalThis, "fetch");

// Created temp roots, cleaned up after the suite so the test leaves no trace.
const createdRoots: string[] = [];
// A single base directory under the OS temp dir holds every per-run root, so we
// create one shared parent instead of polluting the OS temp dir with 100 trees.
const suiteRoot = mkdtempSync(nodePath.join(nodeOs.tmpdir(), "rector-bench-prop-"));
createdRoots.push(suiteRoot);

beforeEach(() => {
  mkdirSpy.mockClear();
  writeFileSpy.mockClear();
  writeFileSyncSpy.mockClear();
  fetchSpy.mockClear();
});

afterEach(() => {
  // The whole point of the property: no write escaped the temp root, so the
  // network was never touched either.
  expect(fetchSpy).not.toHaveBeenCalled();
});

afterAll(() => {
  vi.restoreAllMocks();
  for (const root of createdRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Collects the first (path) argument from every recorded spy call. */
function recordedWritePaths(): string[] {
  const calls = [
    ...mkdirSpy.mock.calls,
    ...writeFileSpy.mock.calls,
    ...writeFileSyncSpy.mock.calls,
  ];
  return calls.map((call) => String(call[0]));
}

/** True when `child` is the same as or nested under `parent`. */
function isContainedWithin(parent: string, child: string): boolean {
  const relative = nodePath.relative(nodePath.resolve(parent), nodePath.resolve(child));
  // Inside the root when the relative path neither climbs out (`..`) nor is
  // an absolute path on another root/drive.
  return relative === "" || (!relative.startsWith("..") && !nodePath.isAbsolute(relative));
}

describe("benchmark output containment (Property 7)", () => {
  it("writes only under the configured temporary output root and never modifies tracked files", async () => {
    await fc.assert(
      fc.asyncProperty(
        // A non-empty, possibly-reordered subset of the version-controlled task
        // set — every default task builds its own isolated fixture workspace.
        fc
          .subarray([...DEFAULT_BENCHMARK_TASKS], { minLength: 1 })
          .chain((subset) => fc.shuffledSubarray(subset, { minLength: 1 })),
        async (tasks: BenchmarkTask[]) => {
          // A fresh, uniquely-named temporary root per run, created BEFORE we
          // inspect the spies for this iteration. `mkdtempSync` is not spied, so
          // creating the root does not pollute the recorded write paths.
          const tmpRoot = mkdtempSync(nodePath.join(suiteRoot, "run-"));

          mkdirSpy.mockClear();
          writeFileSpy.mockClear();
          writeFileSyncSpy.mockClear();

          const summary = await runBenchmark(tasks, { mode: "deterministic", tmpRoot });

          const resolvedRoot = nodePath.resolve(tmpRoot);

          // The summary's output root is the configured temp root, and every
          // task's retained output directory lives under it.
          expect(nodePath.resolve(summary.outputRoot)).toBe(resolvedRoot);
          for (const result of summary.results) {
            expect(isContainedWithin(resolvedRoot, result.outputDir)).toBe(true);
          }

          // The core property: EVERY observed filesystem write targeted a path
          // contained within the temporary output root. A single escaping write
          // would be a tracked-file-modification risk and fail here.
          const writePaths = recordedWritePaths();
          expect(writePaths.length).toBeGreaterThan(0);
          for (const writePath of writePaths) {
            expect(isContainedWithin(resolvedRoot, writePath)).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  }, 180_000);
});
