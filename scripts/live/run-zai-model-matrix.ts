#!/usr/bin/env tsx
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatZaiMatrixSummaryMarkdown,
  resolveZaiMatrixModels,
  runZaiModelMatrix,
  type ZaiMatrixCommandInvocation,
  type ZaiMatrixCommandResult,
  type ZaiMatrixCommandRunner,
  writeZaiMatrixSummary,
} from "../../src/live/zaiModelMatrix";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function createNpmCommandRunner(): ZaiMatrixCommandRunner {
  return (input: ZaiMatrixCommandInvocation) =>
    new Promise<ZaiMatrixCommandResult>((resolve) => {
      const started = Date.now();
      let stdout = "";
      let stderr = "";
      const child = spawn(input.command, [...input.args], {
        cwd: input.cwd,
        env: { ...process.env, ...input.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdout += String(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr += String(chunk);
      });
      child.on("close", (code) => {
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr,
          durationMs: Date.now() - started,
        });
      });
      child.on("error", (error) => {
        resolve({
          exitCode: 1,
          stdout,
          stderr: `${stderr}\n${error instanceof Error ? error.message : String(error)}`.trim(),
          durationMs: Date.now() - started,
        });
      });
    });
}

function parseArgs(argv: readonly string[]): { repoRoot?: string } {
  let repoRoot: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo-root") {
      repoRoot = argv[++index];
      if (!repoRoot) throw new Error("--repo-root requires a value");
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Usage: tsx scripts/live/run-zai-model-matrix.ts [--repo-root <path>]",
          "",
          "Opt-in Z.ai multi-model live verifier. Requires ZAI_MODELS (or ZAI_MODEL) plus live credentials.",
          "Writes .rector/evidence/live/zai/matrix/matrix-summary.{json,md}",
          "",
          "Env knobs:",
          "  ZAI_MATRIX_RUNS_PER_MODEL (default 1)",
          "  ZAI_MATRIX_MAX_MODELS (optional cap)",
          "  ZAI_MATRIX_SKIP_OFFLINE=1",
          "  ZAI_MATRIX_CONTINUE_ON_FAILURE (default 1)",
        ].join("\n") + "\n",
      );
      process.exit(0);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  return { repoRoot };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(args.repoRoot ?? REPO_ROOT);
  const models = resolveZaiMatrixModels(process.env);
  if (models.source === "empty") {
    process.stderr.write(
      "[verify:zai-live:matrix] ZAI_MODELS or ZAI_MODEL must be set. This command does not run in default CI.\n",
    );
    process.exit(1);
  }

  const summary = await runZaiModelMatrix({
    repoRoot,
    env: process.env,
    runCommand: createNpmCommandRunner(),
  });
  const written = await writeZaiMatrixSummary(summary, { repoRoot });
  process.stdout.write(formatZaiMatrixSummaryMarkdown(summary));
  process.stdout.write(`matrix-summary: ${written.jsonPath}\n`);
  if (summary.overallStatus !== "pass") {
    process.exit(1);
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  return !!entry && fileURLToPath(import.meta.url) === path.resolve(entry);
}

if (isMain()) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `[verify:zai-live:matrix] fatal: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}