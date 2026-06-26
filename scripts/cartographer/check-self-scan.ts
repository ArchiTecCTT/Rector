#!/usr/bin/env tsx
/**
 * check-self-scan.ts (Todo 7)
 * Strict checker for deterministic self-scan artifacts.
 *
 * Usage:
 *   tsx scripts/cartographer/check-self-scan.ts [artifactsDir]
 *
 * Default artifactsDir: <repoRoot>/.rector/cartographer
 *
 * Fails (nonzero) if:
 * - expected paths missing (src/cartographer, src/orchestration, src/providers, src/tools, tests)
 * - forbidden paths indexed (node_modules, .git, .omo, .rector/cartographer, dist, build, coverage, .worktrees)
 * - any .env / .env.* except .env.example indexed
 * - scanErrorCount > 0 (no allowlist by default; minimal explicit allowlist only if a future need is proven)
 * - normalizedPaths in latest-files.json is not strictly sorted ascending
 *
 * For tamper/failure QA: pass a temporary artifacts dir containing a tampered latest-files.json
 * that lists a forbidden file (e.g. .env.production). Checker must exit nonzero.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "../..");

const DEFAULT_EXPECTED = ["src/cartographer", "src/orchestration", "src/providers", "src/tools", "tests"] as const;

const FORBIDDEN_DIR_PATTERNS = [
  "node_modules",
  ".git",
  ".omo",
  ".rector/cartographer",
  "dist",
  "build",
  "coverage",
  ".worktrees",
] as const;

type LatestFilesArtifact = {
  readonly schemaVersion: string;
  readonly repoRoot: string;
  readonly generatedAt: string;
  readonly indexedFileCount: number;
  readonly scanErrorCount: number;
  readonly normalizedPaths: readonly string[];
};

function fail(msg: string): never {
  console.error(`[cartographer:self-scan:check] FAIL: ${msg}`);
  process.exit(1);
}

function isSortedAscending(list: readonly string[]): boolean {
  for (let i = 1; i < list.length; i++) {
    if (list[i] < list[i - 1]) return false;
  }
  return true;
}

function matchesForbidden(p: string, patterns: readonly string[]): boolean {
  for (const pat of patterns) {
    if (p === pat) return true;
    if (p.startsWith(pat + "/")) return true;
    if (p.includes("/" + pat + "/")) return true;
    const base = p.split("/").pop() ?? p;
    if (base === pat || base.startsWith(pat + "/") || base === pat) return true;
  }
  return false;
}

function isNonExampleEnv(p: string): boolean {
  const base = p.split("/").pop() ?? p;
  if (base === ".env.example") return false;
  return base === ".env" || base.startsWith(".env.");
}

async function readJson<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

async function main(): Promise<void> {
  const argDir = process.argv[2];
  const artifactsDir = argDir ? path.resolve(argDir) : path.join(REPO_ROOT, ".rector", "cartographer");

  const filesPath = path.join(artifactsDir, "latest-files.json");
  const snapshotPath = path.join(artifactsDir, "latest-snapshot.json");
  const mdPath = path.join(artifactsDir, "scan-report.md");

  // Existence
  for (const p of [filesPath, snapshotPath, mdPath]) {
    try {
      await fs.access(p);
    } catch {
      fail(`missing artifact: ${p}`);
    }
  }

  // Load latest-files
  let filesArt: LatestFilesArtifact;
  try {
    filesArt = await readJson<LatestFilesArtifact>(filesPath);
  } catch (e) {
    fail(`failed to parse latest-files.json: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!Array.isArray(filesArt.normalizedPaths)) {
    fail("latest-files.json missing normalizedPaths array");
  }

  // Determinism: must be sorted
  if (!isSortedAscending(filesArt.normalizedPaths)) {
    fail("normalizedPaths is not sorted ascending (nondeterministic)");
  }

  const indexed = filesArt.normalizedPaths;

  // Expected paths present (dir prefix match)
  for (const exp of DEFAULT_EXPECTED) {
    const present = indexed.some((p) => p === exp || p.startsWith(exp + "/"));
    if (!present) {
      fail(`expected path not indexed: ${exp}`);
    }
  }

  // Forbidden dir patterns
  for (const p of indexed) {
    if (matchesForbidden(p, FORBIDDEN_DIR_PATTERNS)) {
      fail(`forbidden path indexed: ${p}`);
    }
  }

  // Env leakage (except .env.example)
  for (const p of indexed) {
    if (isNonExampleEnv(p)) {
      fail(`env file indexed (non-example): ${p}`);
    }
  }

  // Scan errors: default no allowlist
  if (typeof filesArt.scanErrorCount !== "number") {
    fail("scanErrorCount missing or invalid in latest-files.json");
  }
  if (filesArt.scanErrorCount !== 0) {
    // No allowlist implemented for Todo 7; any nonzero is failure.
    fail(`nonzero scan errors (${filesArt.scanErrorCount}) and no allowlist entry`);
  }

  // Also sanity-check snapshot has matching counts (light cross-check)
  try {
    const snap = await readJson<{ indexedFileCount?: number }>(snapshotPath);
    if (typeof snap.indexedFileCount === "number" && snap.indexedFileCount !== filesArt.indexedFileCount) {
      fail("snapshot indexedFileCount does not match latest-files count");
    }
  } catch {
    // snapshot parse issues are secondary; files list is the primary determinism source
  }

  console.log(`[cartographer:self-scan:check] PASS (artifactsDir=${artifactsDir})`);
  console.log(`  indexed=${filesArt.indexedFileCount} errors=${filesArt.scanErrorCount}`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[cartographer:self-scan:check] UNEXPECTED ERROR: ${msg}`);
  process.exit(1);
});
