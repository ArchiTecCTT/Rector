/**
 * Version-controlled benchmark tasks (productization-alpha, Requirement 4.1).
 *
 * Each task builds its own isolated `Fixture_Workspace` under the directory the
 * harness supplies (always rooted in the run's temporary output root, Req 4.4)
 * and exercises Rector's safe workspace sandbox through the existing
 * `WorkspaceSandboxAdapter`. In the default `deterministic` mode the tasks use a
 * network-free, deterministic command runner so repeated runs yield identical
 * final statuses (Req 4.2, 4.9).
 *
 * Three concrete coding tasks are provided (Req 4.1 requires at least three):
 *   1. `add-file`         — propose and apply an approved file-add patch.
 *   2. `read-config`      — read an existing fixture file and verify its content.
 *   3. `run-build-command`— run an allowlisted build command to a clean exit.
 */
import nodeFs from "node:fs/promises";
import nodePath from "node:path";

import {
  WorkspaceSandboxAdapter,
  type CommandRunner,
  type SandboxApproval,
} from "../sandbox";
import type { BenchmarkRunContext, BenchmarkTask, BenchmarkTaskOutcome } from "./types";

/**
 * Deterministic, network-free command runner used in the default benchmark
 * mode. It echoes the resolved command and reports a clean exit, so a task's
 * final status never depends on a real process or the network (Req 4.2, 4.9).
 */
const deterministicCommandRunner: CommandRunner = async ({ command, args }) => ({
  exitCode: 0,
  stdout: `${[command, ...args].join(" ").trim()} completed`,
  stderr: "",
});

/** Task 1: propose and apply an approved file-add patch inside the workspace. */
export const addFileTask: BenchmarkTask = {
  id: "add-file",
  description: "Propose and apply an approved patch that adds a new source file.",
  async setupFixture(workspaceDir: string): Promise<void> {
    await nodeFs.mkdir(nodePath.join(workspaceDir, "src"), { recursive: true });
    await nodeFs.writeFile(
      nodePath.join(workspaceDir, "README.md"),
      "# Fixture\n\nBenchmark fixture for the add-file task.\n",
      "utf8",
    );
  },
  async run(context: BenchmarkRunContext): Promise<BenchmarkTaskOutcome> {
    const targetPath = "src/feature.ts";
    const content = "export const feature = () => 42;\n";
    const approvals: SandboxApproval[] = [
      { id: "approval-add-file", scope: "FILE_WRITE", target: targetPath, approvedBy: "benchmark" },
    ];
    const adapter = new WorkspaceSandboxAdapter({
      workspaceRoot: context.workspaceDir,
      approvals,
      now: context.now,
    });

    const result = await adapter.operate({
      kind: "PROPOSE_PATCH",
      path: targetPath,
      operation: "add",
      content,
    });

    const written = await fileExists(nodePath.join(context.workspaceDir, targetPath));
    const passed = result.status === "SUCCEEDED" && written;
    return {
      passed,
      patch: result.artifacts[0]?.unifiedDiff,
      commands: [],
      costEstimateUsd: 0,
      logs: [
        `mode=${context.mode}`,
        `propose-patch status=${result.status}`,
        `file-written=${written}`,
      ],
    };
  },
};

/** Task 2: read an existing fixture file and verify its content. */
export const readConfigTask: BenchmarkTask = {
  id: "read-config",
  description: "Read an existing configuration file from the workspace and verify its content.",
  async setupFixture(workspaceDir: string): Promise<void> {
    await nodeFs.mkdir(nodePath.join(workspaceDir, "config"), { recursive: true });
    await nodeFs.writeFile(
      nodePath.join(workspaceDir, "config", "app.json"),
      `${JSON.stringify({ name: "rector-fixture", version: "0.1.0" }, null, 2)}\n`,
      "utf8",
    );
  },
  async run(context: BenchmarkRunContext): Promise<BenchmarkTaskOutcome> {
    const adapter = new WorkspaceSandboxAdapter({
      workspaceRoot: context.workspaceDir,
      now: context.now,
    });

    const result = await adapter.operate({ kind: "READ_FILE", path: "config/app.json" });
    const passed =
      result.status === "SUCCEEDED" && (result.fileContent ?? "").includes("rector-fixture");
    return {
      passed,
      commands: [],
      costEstimateUsd: 0,
      logs: [`mode=${context.mode}`, `read-file status=${result.status}`],
    };
  },
};

/** Task 3: run an allowlisted build command to a clean exit. */
export const runBuildCommandTask: BenchmarkTask = {
  id: "run-build-command",
  description: "Run an allowlisted build command in the workspace and verify a clean exit.",
  async setupFixture(workspaceDir: string): Promise<void> {
    await nodeFs.writeFile(
      nodePath.join(workspaceDir, "package.json"),
      `${JSON.stringify({ name: "fixture", version: "0.0.0", scripts: { build: "tsc" } }, null, 2)}\n`,
      "utf8",
    );
  },
  async run(context: BenchmarkRunContext): Promise<BenchmarkTaskOutcome> {
    const command = "npm:build";
    const adapter = new WorkspaceSandboxAdapter({
      workspaceRoot: context.workspaceDir,
      allowlistedCommands: [command],
      commandRunner: deterministicCommandRunner,
      now: context.now,
    });

    const result = await adapter.operate({ kind: "RUN_COMMAND", command, args: ["--ci"] });
    const passed = result.status === "SUCCEEDED";
    return {
      passed,
      commands: [`${command} --ci`],
      costEstimateUsd: 0,
      logs: [`mode=${context.mode}`, `run-command status=${result.status}`],
    };
  },
};

/** The default, version-controlled benchmark task set (at least three, Req 4.1). */
export const DEFAULT_BENCHMARK_TASKS: BenchmarkTask[] = [
  addFileTask,
  readConfigTask,
  runBuildCommandTask,
];

async function fileExists(path: string): Promise<boolean> {
  try {
    await nodeFs.access(path);
    return true;
  } catch {
    return false;
  }
}
