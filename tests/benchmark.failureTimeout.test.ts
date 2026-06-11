/**
 * Task 6.6 — Benchmark failure and timeout unit tests (Requirements 4.2, 4.5, 4.7).
 *
 * These tests drive `runBenchmark` with deterministic, in-process task doubles
 * and a short injected `taskTimeoutMs` so the 300s timeout path (Req 4.7) is
 * exercised in milliseconds rather than minutes. There are ZERO provider or
 * network calls: a guard spy on `globalThis.fetch` asserts the default mode
 * never reaches the network (Req 4.2).
 *
 * Coverage:
 *   - Req 4.5 — a task that fails (returns `passed:false` or throws) retains its
 *     artifacts and logs in its temporary output directory and records a
 *     `failed` final status in the corresponding `BenchmarkResult`.
 *   - Req 4.7 — a task whose execution exceeds the (injected) timeout is
 *     terminated and recorded with a `timeout` final status, while still
 *     retaining its artifacts directory.
 *   - Req 4.2 — running the version-controlled default task set in deterministic
 *     mode makes zero network calls.
 */
import nodeFs from "node:fs/promises";
import nodeOs from "node:os";
import nodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_BENCHMARK_TASKS,
  runBenchmark,
  type BenchmarkRunContext,
  type BenchmarkTask,
  type BenchmarkTaskOutcome,
} from "../src/benchmark";

const NOW = () => "2026-01-01T00:00:00.000Z";

// Guard: the default deterministic mode must make zero network calls (Req 4.2).
const fetchSpy = vi.spyOn(globalThis, "fetch");

const createdRoots: string[] = [];

async function freshTmpRoot(): Promise<string> {
  const root = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "rector-bench-fail-"));
  createdRoots.push(root);
  return root;
}

/** A task that completes by returning `passed:false` with retained log lines. */
function failingTask(id: string): BenchmarkTask {
  return {
    id,
    description: `failing task ${id}`,
    async setupFixture(): Promise<void> {
      // No fixture needed; the harness creates the workspace directory.
    },
    async run(context: BenchmarkRunContext): Promise<BenchmarkTaskOutcome> {
      return {
        passed: false,
        commands: ["noop --check"],
        costEstimateUsd: 0,
        logs: [`mode=${context.mode}`, "did-not-meet-success-condition"],
      };
    },
  };
}

/** A task that fails by throwing (the harness maps a throw to `failed`). */
function throwingTask(id: string): BenchmarkTask {
  return {
    id,
    description: `throwing task ${id}`,
    async setupFixture(): Promise<void> {},
    async run(): Promise<BenchmarkTaskOutcome> {
      throw new Error("synthetic task failure");
    },
  };
}

/** A task that never resolves, so the harness terminates it on timeout. */
function hangingTask(id: string): BenchmarkTask {
  return {
    id,
    description: `hanging task ${id}`,
    async setupFixture(): Promise<void> {},
    async run(): Promise<BenchmarkTaskOutcome> {
      return new Promise<BenchmarkTaskOutcome>(() => {
        // Intentionally never resolves; the timeout race terminates it.
      });
    },
  };
}

async function readResultJson(outputDir: string): Promise<Record<string, unknown>> {
  const raw = await nodeFs.readFile(nodePath.join(outputDir, "artifacts", "result.json"), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await nodeFs.access(path);
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  fetchSpy.mockClear();
});

afterEach(async () => {
  // No benchmark run in default mode should have touched the network (Req 4.2).
  expect(fetchSpy).not.toHaveBeenCalled();
  for (const root of createdRoots.splice(0)) {
    await nodeFs.rm(root, { recursive: true, force: true });
  }
});

describe("benchmark failure and timeout (Req 4.2, 4.5, 4.7)", () => {
  describe("Requirement 4.5 — failed tasks retain artifacts and record failed status", () => {
    it("records a failed status and retains the result artifact for a non-passing task", async () => {
      const tmpRoot = await freshTmpRoot();

      const summary = await runBenchmark([failingTask("fails")], {
        mode: "deterministic",
        now: NOW,
        tmpRoot,
      });

      expect(summary.results).toHaveLength(1);
      const [result] = summary.results;
      expect(result.finalStatus).toBe("failed");
      expect(summary.countsByStatus.failed).toBe(1);

      // The temporary output directory is retained with a result artifact.
      expect(await pathExists(result.outputDir)).toBe(true);
      const persisted = await readResultJson(result.outputDir);
      expect(persisted.finalStatus).toBe("failed");
      expect(persisted.taskId).toBe("fails");

      // A failure detail was recorded for the failed task.
      expect(typeof result.detail).toBe("string");
      expect((result.detail ?? "").length).toBeGreaterThan(0);
    });

    it("retains the task log file for a failed task that produced logs", async () => {
      const tmpRoot = await freshTmpRoot();

      const summary = await runBenchmark([failingTask("fails-with-logs")], {
        mode: "deterministic",
        now: NOW,
        tmpRoot,
      });

      const [result] = summary.results;
      const logPath = nodePath.join(result.outputDir, "artifacts", "task.log");
      expect(await pathExists(logPath)).toBe(true);
      const logText = await nodeFs.readFile(logPath, "utf8");
      expect(logText).toContain("did-not-meet-success-condition");
    });

    it("maps a thrown error to a failed status and retains the artifact", async () => {
      const tmpRoot = await freshTmpRoot();

      const summary = await runBenchmark([throwingTask("throws")], {
        mode: "deterministic",
        now: NOW,
        tmpRoot,
      });

      const [result] = summary.results;
      expect(result.finalStatus).toBe("failed");
      expect(await pathExists(result.outputDir)).toBe(true);
      const persisted = await readResultJson(result.outputDir);
      expect(persisted.finalStatus).toBe("failed");
    });
  });

  describe("Requirement 4.7 — tasks exceeding the timeout are terminated", () => {
    it("terminates a hanging task and records a timeout status", async () => {
      const tmpRoot = await freshTmpRoot();

      const summary = await runBenchmark([hangingTask("hangs")], {
        mode: "deterministic",
        // A short injected timeout exercises the same 300s termination path
        // (DEFAULT_TASK_TIMEOUT_MS) in milliseconds.
        taskTimeoutMs: 25,
        now: NOW,
        tmpRoot,
      });

      expect(summary.results).toHaveLength(1);
      const [result] = summary.results;
      expect(result.finalStatus).toBe("timeout");
      expect(summary.countsByStatus.timeout).toBe(1);

      // Artifacts are retained for the terminated task, with a timeout detail.
      expect(await pathExists(result.outputDir)).toBe(true);
      const persisted = await readResultJson(result.outputDir);
      expect(persisted.finalStatus).toBe("timeout");
      expect((result.detail ?? "").toLowerCase()).toContain("timeout");
    });

    it("times out only the hanging task while other tasks complete normally", async () => {
      const tmpRoot = await freshTmpRoot();

      const summary = await runBenchmark(
        [failingTask("quick-fail"), hangingTask("slow-hang")],
        { mode: "deterministic", taskTimeoutMs: 25, now: NOW, tmpRoot },
      );

      expect(summary.totalTasks).toBe(2);
      expect(summary.countsByStatus.failed).toBe(1);
      expect(summary.countsByStatus.timeout).toBe(1);

      const statusById = Object.fromEntries(
        summary.results.map((result) => [result.taskId, result.finalStatus]),
      );
      expect(statusById["quick-fail"]).toBe("failed");
      expect(statusById["slow-hang"]).toBe("timeout");
    });
  });

  describe("Requirement 4.2 — default mode makes zero network calls", () => {
    it("runs the version-controlled default task set without any fetch call", async () => {
      const tmpRoot = await freshTmpRoot();

      const summary = await runBenchmark(DEFAULT_BENCHMARK_TASKS, {
        mode: "deterministic",
        now: NOW,
        tmpRoot,
      });

      expect(summary.totalTasks).toBe(DEFAULT_BENCHMARK_TASKS.length);
      // The afterEach guard asserts fetch was never called; assert here too so
      // the network-free guarantee is explicit for the default task set.
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
