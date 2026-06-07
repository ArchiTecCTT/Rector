/**
 * Benchmark harness runner (productization-alpha, Requirement 4).
 *
 * `runBenchmark` executes a version-controlled set of tasks, each against its
 * own isolated `Fixture_Workspace` built under a temporary output root. The
 * default `deterministic` mode uses the task-supplied network-free doubles and
 * produces identical final statuses across repeated runs (Req 4.2, 4.9). All
 * output is written under the temporary root so tracked repository files are
 * never modified (Req 4.4); a task that fails or times out retains its
 * artifacts/logs in its temp directory (Req 4.5, 4.7). A run produces a summary
 * with the total task count and per-status counts (Req 4.8).
 */
import nodeFs from "node:fs/promises";
import nodeOs from "node:os";
import nodePath from "node:path";

import { redactSecrets, redactString } from "../security/redaction";
import {
  BENCHMARK_FINAL_STATUSES,
  DEFAULT_TASK_TIMEOUT_MS,
  type BenchmarkFinalStatus,
  type BenchmarkMode,
  type BenchmarkOptions,
  type BenchmarkResult,
  type BenchmarkSummary,
  type BenchmarkTask,
  type BenchmarkTaskOutcome,
} from "./types";

/** Sentinel returned by the timeout race when a task exceeds its budget. */
const TIMEOUT = Symbol("benchmark-task-timeout");

/**
 * Executes `tasks` and returns a {@link BenchmarkSummary}. Each task runs in
 * isolation: a fresh `<outputRoot>/<taskId>` directory holds a `workspace`
 * subdirectory (the `Fixture_Workspace`) and an `artifacts` subdirectory for
 * retained logs/results. No task can escape the temporary output root.
 */
export async function runBenchmark(
  tasks: BenchmarkTask[],
  options: BenchmarkOptions = {},
): Promise<BenchmarkSummary> {
  const mode: BenchmarkMode = options.mode ?? "deterministic";
  const taskTimeoutMs = options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
  const now = options.now ?? (() => new Date().toISOString());

  const outputRoot = options.tmpRoot
    ? nodePath.resolve(options.tmpRoot)
    : await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "rector-benchmark-"));
  await nodeFs.mkdir(outputRoot, { recursive: true });

  const results: BenchmarkResult[] = [];
  for (const task of tasks) {
    results.push(await runTask(task, { mode, taskTimeoutMs, now, outputRoot }));
  }

  return {
    totalTasks: results.length,
    countsByStatus: countByStatus(results),
    results,
    outputRoot,
    mode,
  };
}

interface TaskRunConfig {
  mode: BenchmarkMode;
  taskTimeoutMs: number;
  now: () => string;
  outputRoot: string;
}

async function runTask(task: BenchmarkTask, config: TaskRunConfig): Promise<BenchmarkResult> {
  const outputDir = nodePath.join(config.outputRoot, sanitizeId(task.id));
  const workspaceDir = nodePath.join(outputDir, "workspace");
  const artifactsDir = nodePath.join(outputDir, "artifacts");
  await nodeFs.mkdir(workspaceDir, { recursive: true });
  await nodeFs.mkdir(artifactsDir, { recursive: true });

  const startedMs = Date.now();
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;

  try {
    await task.setupFixture(workspaceDir);

    const timeoutPromise = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(TIMEOUT);
      }, config.taskTimeoutMs);
    });

    const outcome = await Promise.race([
      task.run({
        taskId: task.id,
        mode: config.mode,
        workspaceDir,
        outputDir: artifactsDir,
        now: config.now,
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);

    if (outcome === TIMEOUT) {
      return await finalize(task, {
        outputDir,
        artifactsDir,
        finalStatus: "timeout",
        durationMs: Date.now() - startedMs,
        commands: [],
        costEstimateUsd: 0,
        detail: `Task ${task.id} exceeded the ${config.taskTimeoutMs}ms timeout and was terminated.`,
      });
    }

    return await finalize(task, {
      outputDir,
      artifactsDir,
      finalStatus: outcome.passed ? "passed" : "failed",
      durationMs: Date.now() - startedMs,
      patch: outcome.patch,
      commands: outcome.commands,
      costEstimateUsd: outcome.costEstimateUsd,
      logs: outcome.logs,
      detail: outcome.passed ? undefined : `Task ${task.id} did not meet its success condition.`,
    });
  } catch (error) {
    return await finalize(task, {
      outputDir,
      artifactsDir,
      finalStatus: "failed",
      durationMs: Date.now() - startedMs,
      commands: [],
      costEstimateUsd: 0,
      detail: redactString(stringifyError(error)),
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface FinalizeInput {
  outputDir: string;
  artifactsDir: string;
  finalStatus: BenchmarkFinalStatus;
  durationMs: number;
  patch?: string;
  commands?: string[];
  costEstimateUsd: number;
  logs?: string[];
  detail?: string;
}

/**
 * Writes the redacted result and any logs into the task's artifacts directory
 * (always retained — particularly on failure/timeout, Req 4.5) and returns the
 * structured {@link BenchmarkResult}.
 */
async function finalize(task: BenchmarkTask, input: FinalizeInput): Promise<BenchmarkResult> {
  const result: BenchmarkResult = {
    taskId: task.id,
    finalStatus: input.finalStatus,
    patch: input.patch,
    commands: input.commands ?? [],
    costEstimateUsd: input.costEstimateUsd,
    durationMs: input.durationMs,
    outputDir: input.outputDir,
    detail: input.detail,
  };

  // Redact before persisting so retained artifacts never carry secret material.
  const persisted = redactSecrets({ description: task.description, ...result });
  await nodeFs.writeFile(
    nodePath.join(input.artifactsDir, "result.json"),
    `${JSON.stringify(persisted, null, 2)}\n`,
    "utf8",
  );

  if (input.logs && input.logs.length > 0) {
    await nodeFs.writeFile(
      nodePath.join(input.artifactsDir, "task.log"),
      `${input.logs.map((line) => redactString(line)).join("\n")}\n`,
      "utf8",
    );
  }

  return result;
}

function countByStatus(results: BenchmarkResult[]): Record<BenchmarkFinalStatus, number> {
  const counts = Object.fromEntries(
    BENCHMARK_FINAL_STATUSES.map((status) => [status, 0]),
  ) as Record<BenchmarkFinalStatus, number>;
  for (const result of results) {
    counts[result.finalStatus] += 1;
  }
  return counts;
}

/** Restricts a task id to a filesystem-safe directory name. */
function sanitizeId(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe.length > 0 ? safe : "task";
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
