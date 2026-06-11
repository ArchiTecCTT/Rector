/**
 * Benchmark harness types (productization-alpha, Requirement 4).
 *
 * The harness runs a version-controlled set of coding tasks, each against its
 * own isolated `Fixture_Workspace`, and records a structured `BenchmarkResult`
 * per task plus a `BenchmarkSummary` for the run. The default mode uses
 * deterministic test doubles and makes zero real provider or network calls; a
 * manual `live` mode runs the same task set against configured providers.
 *
 * These types are intentionally provider-free: a `BenchmarkTask` is the only
 * extension point and carries both the fixture setup and the deterministic
 * execution it performs, so the harness itself never reaches the network.
 */

/** Final status recorded for a single benchmark task (Req 4.3, 4.5, 4.7). */
export type BenchmarkFinalStatus = "passed" | "failed" | "timeout";

/** Run mode: deterministic (default, no network) or manual live-provider (Req 4.2, 4.6). */
export type BenchmarkMode = "deterministic" | "live";

/** All final-status values, used to seed per-status count maps. */
export const BENCHMARK_FINAL_STATUSES: readonly BenchmarkFinalStatus[] = [
  "passed",
  "failed",
  "timeout",
];

/** Default per-task timeout: a task running past 300s is terminated (Req 4.7). */
export const DEFAULT_TASK_TIMEOUT_MS = 300_000;

/**
 * Context handed to a task's `run`. Every path is rooted under the run's
 * temporary output root so a task never modifies tracked repository files
 * (Req 4.4). The `signal` aborts when the task exceeds its timeout (Req 4.7).
 */
export interface BenchmarkRunContext {
  /** The task being executed. */
  readonly taskId: string;
  /** Run mode; `deterministic` uses test doubles and no network (Req 4.2). */
  readonly mode: BenchmarkMode;
  /** Isolated fixture workspace directory for this task (under the temp root). */
  readonly workspaceDir: string;
  /** Temporary output directory for this task's artifacts and logs. */
  readonly outputDir: string;
  /** Injected clock for deterministic timestamps. */
  readonly now: () => string;
  /** Aborts when the task exceeds its timeout so cooperative tasks can stop. */
  readonly signal: AbortSignal;
}

/**
 * The work a task produced. The harness folds this into a `BenchmarkResult`,
 * mapping `passed` to a `passed`/`failed` final status (a thrown error or an
 * abort maps to `failed`/`timeout`).
 */
export interface BenchmarkTaskOutcome {
  /** Whether the task achieved its goal against the fixture workspace. */
  readonly passed: boolean;
  /** Unified-diff patch the task produced, when any (Req 4.3). */
  readonly patch?: string;
  /** Commands the task executed, in order (Req 4.3). */
  readonly commands: string[];
  /** Estimated provider cost in USD (0 in deterministic mode) (Req 4.3). */
  readonly costEstimateUsd: number;
  /** Optional human-language log lines retained with the task artifacts. */
  readonly logs?: string[];
}

/**
 * A single version-controlled benchmark task. `setupFixture` builds an isolated
 * `Fixture_Workspace` under the supplied directory (Req 4.1); `run` performs the
 * task against that workspace using the context's injected, network-free doubles
 * and returns the structured outcome.
 */
export interface BenchmarkTask {
  /** Stable, unique task identifier (also used as the temp sub-directory name). */
  readonly id: string;
  /** Human-language description of what the task exercises. */
  readonly description: string;
  /** Builds the isolated fixture workspace under `workspaceDir` (Req 4.1, 4.4). */
  setupFixture(workspaceDir: string): Promise<void>;
  /** Executes the task and returns its outcome (Req 4.3). */
  run(context: BenchmarkRunContext): Promise<BenchmarkTaskOutcome>;
}

/** The structured record for a single benchmark task (Req 4.3, 4.5). */
export interface BenchmarkResult {
  readonly taskId: string;
  /** passed | failed | timeout (Req 4.3, 4.5, 4.7). */
  readonly finalStatus: BenchmarkFinalStatus;
  /** Unified-diff patch produced by the task, when any. */
  readonly patch?: string;
  /** Commands the task executed, in order. */
  readonly commands: string[];
  /** Estimated provider cost in USD. */
  readonly costEstimateUsd: number;
  /** Wall-clock duration of the task in milliseconds. */
  readonly durationMs: number;
  /** Temp directory retained with artifacts/logs (always retained on failure). */
  readonly outputDir: string;
  /** Redacted failure detail when the task did not pass. */
  readonly detail?: string;
}

/** Run-level summary: total task count and per-status counts (Req 4.8). */
export interface BenchmarkSummary {
  readonly totalTasks: number;
  readonly countsByStatus: Record<BenchmarkFinalStatus, number>;
  readonly results: BenchmarkResult[];
  /** Root temp directory under which every task's output was written. */
  readonly outputRoot: string;
  readonly mode: BenchmarkMode;
}

/** Options controlling a benchmark run. */
export interface BenchmarkOptions {
  /** Run mode; defaults to `deterministic` (Req 4.2). */
  mode?: BenchmarkMode;
  /** Per-task timeout in ms; defaults to {@link DEFAULT_TASK_TIMEOUT_MS} (Req 4.7). */
  taskTimeoutMs?: number;
  /** Injected clock for deterministic timestamps. */
  now?: () => string;
  /**
   * Root directory for all output. When omitted, a fresh temporary directory is
   * created under the OS temp dir. All writes stay under this root (Req 4.4).
   */
  tmpRoot?: string;
}
