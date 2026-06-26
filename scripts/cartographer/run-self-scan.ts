#!/usr/bin/env tsx
/**
 * run-self-scan.ts (Todo 7)
 * Runs the real Cartographer scanRepository on the Rector repository root and emits the three
 * deterministic self-scan artifacts under .rector/cartographer/ (gitignored, generated-only).
 *
 * Artifacts:
 *  - latest-snapshot.json : the RepoSnapshot from the real scan
 *  - latest-files.json    : normalized indexed file list + counts (sorted, deterministic)
 *  - scan-report.md       : rendered via renderSelfScanReportMarkdown (Todo 6)
 *
 * Must NOT mock the scanner. Uses only real FS walk + ignore policy.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

import { scanRepository } from "../../src/cartographer/repoScanner";
import {
  renderSelfScanReportMarkdown,
  generateForbiddenPathChecks,
  sortExpectedPathChecks,
  sortForbiddenPathChecks,
  buildGitComparison,
  SELF_SCAN_SCHEMA_VERSION,
  type CartographerSelfScanReport,
} from "../../src/cartographer/selfScanReport";

const SCRIPT_URL = import.meta.url;
const SCRIPT_PATH = fileURLToPath(SCRIPT_URL);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "../..");

function getGitTracked(repoRoot: string): string[] {
  try {
    const stdout = execSync("git ls-files", {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((p) => p.replace(/\\/g, "/"))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  console.log(`[cartographer:self-scan] repoRoot=${REPO_ROOT}`);
  const result = await scanRepository({ repoRoot: REPO_ROOT });
  console.log(
    `[cartographer:self-scan] indexed=${result.files.length} ignored=${result.ignoredFiles.length} errors=${result.errors.length}`,
  );

  const artDir = path.join(REPO_ROOT, ".rector", "cartographer");
  await fs.mkdir(artDir, { recursive: true });

  const snapshotPath = path.join(artDir, "latest-snapshot.json");
  await fs.writeFile(snapshotPath, JSON.stringify(result.snapshot, null, 2) + "\n", "utf8");

  const indexedPaths = result.files.map((f) => f.normalizedPath);
  const filesArtifact = {
    schemaVersion: "rector.cartographer.latestFiles.v1",
    repoRoot: REPO_ROOT,
    generatedAt: new Date().toISOString(),
    indexedFileCount: result.files.length,
    scanErrorCount: result.errors.length,
    normalizedPaths: indexedPaths,
    scanErrors: result.errors,
  } as const;
  const filesPath = path.join(artDir, "latest-files.json");
  await fs.writeFile(filesPath, JSON.stringify(filesArtifact, null, 2) + "\n", "utf8");


  const gitTracked = getGitTracked(REPO_ROOT);
  const indexedSet = new Set(indexedPaths);
  const ignoredPaths = result.ignoredFiles.map((i) => i.path);
  const ignoredSet = new Set(ignoredPaths);

  const unexplainedMissing = gitTracked.filter((p) => !indexedSet.has(p) && !ignoredSet.has(p));
  const unexpectedIndexed = indexedPaths.filter((p) => !gitTracked.includes(p));

  const gitComp = buildGitComparison({
    gitTrackedCount: gitTracked.length,
    cartographerIndexedCount: result.files.length,
    ignoredTrackedCount: gitTracked.filter((p) => !indexedSet.has(p)).length,
    unexplainedMissing,
    unexpectedIndexed,
  });

  const EXPECTED_PATHS = ["src/cartographer", "src/orchestration", "src/providers", "src/tools", "tests"];
  const expectedChecks = EXPECTED_PATHS.map((p) => ({
    path: p,
    present: indexedPaths.some((ip) => ip === p || ip.startsWith(p + "/")),
  }));

  const dirPatterns = ["node_modules", ".git", ".omo", ".rector/cartographer", "dist", "build", "coverage", ".worktrees"];
  const dirChecks = generateForbiddenPathChecks(dirPatterns, indexedPaths);

  const hasBadEnv = indexedPaths.some((p) => {
    const base = p.split("/").pop() ?? p;
    if (base === ".env.example") return false;
    return base === ".env" || base.startsWith(".env.");
  });
  const forbiddenChecks = [...dirChecks, { pathPattern: ".env (non-example)", matched: hasBadEnv }];

  const report: CartographerSelfScanReport = {
    schemaVersion: SELF_SCAN_SCHEMA_VERSION,
    repoRoot: REPO_ROOT,
    snapshotId: result.snapshot.id,
    generatedAt: new Date().toISOString(),
    indexedFileCount: result.snapshot.indexedFileCount,
    ignoredFileCount: result.snapshot.ignoredFileCount,
    deletedFileCount: result.snapshot.deletedFileCount ?? 0,
    changedFileCount: result.snapshot.changedFileCount ?? 0,
    scanErrorCount: result.errors.length,
    expectedPathChecks: sortExpectedPathChecks(expectedChecks),
    forbiddenPathChecks: sortForbiddenPathChecks(forbiddenChecks),
    gitComparison: gitComp,
    scanErrors: [...result.errors],
  };

  const md = renderSelfScanReportMarkdown(report);
  const mdPath = path.join(artDir, "scan-report.md");
  await fs.writeFile(mdPath, md, "utf8");

  console.log(`[cartographer:self-scan] wrote ${snapshotPath}`);
  console.log(`[cartographer:self-scan] wrote ${filesPath}`);
  console.log(`[cartographer:self-scan] wrote ${mdPath}`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[cartographer:self-scan] FAILED: ${msg}`);
  process.exit(1);
});
