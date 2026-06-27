import { describe, expect, it } from "vitest";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scanRepository } from "../../src/cartographer/repoScanner";
import {
  generateForbiddenPathChecks,
  CleanSelfScanReportSchema,
  type CartographerSelfScanReport,
} from "../../src/cartographer/selfScanReport";
import { stripVolatile } from "./repoScannerTestHarness";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../..");

const EXPECTED_PATH_PREFIXES = ["src/cartographer", "src/orchestration", "src/providers", "src/tools", "tests"] as const;

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

describe("Cartographer live repo self-scan determinism (Todo 8)", () => {
  it("indexes expected paths and excludes forbidden paths plus non-example env files when scanning the real worktree", async () => {
    // Given: the Phase 1 worktree root (real repository tree)
    // When: real scanRepository is called
    const result = await scanRepository({ repoRoot: REPO_ROOT });

    const indexedPaths = result.files.map((f) => f.normalizedPath);

    // Then: expected source areas are present (prefix match)
    for (const prefix of EXPECTED_PATH_PREFIXES) {
      const present = indexedPaths.some((p) => p === prefix || p.startsWith(prefix + "/"));
      expect(present, `expected path prefix ${prefix} should be indexed`).toBe(true);
    }

    // And: forbidden directories are not indexed
    for (const p of indexedPaths) {
      for (const forbidden of FORBIDDEN_DIR_PATTERNS) {
        expect(
          !(p === forbidden || p.startsWith(forbidden + "/") || p.includes("/" + forbidden + "/")),
          `forbidden path ${forbidden} must not appear in indexed files (saw ${p})`
        ).toBe(true);
      }
    }

    // And: no .env / .env.* except .env.example is indexed
    const hasBadEnv = indexedPaths.some((p) => {
      const base = p.split("/").pop() ?? p;
      if (base === ".env.example") return false;
      return base === ".env" || base.startsWith(".env.");
    });
    expect(hasBadEnv, "non-example .env files must not be indexed").toBe(false);
  });

  it("produces equivalent normalized outputs on repeated scans after stripping volatile fields", async () => {
    // Given: the same real tree
    // When: two independent scans
    const first = await scanRepository({ repoRoot: REPO_ROOT });
    const second = await scanRepository({ repoRoot: REPO_ROOT });

    // Then: stable parts match (timestamps and lastIndexedAt stripped by harness helper)
    expect(stripVolatile(first)).toEqual(stripVolatile(second));
  });

  it("rejects .omo paths via in-memory forbidden check and Clean schema (failure proof, no FS mutation)", () => {
    // Given: an in-memory list of indexed paths that erroneously includes .omo/foo
    const badIndexed = ["src/cartographer/index.ts", ".omo/foo/secret.txt", "tests/foo.test.ts"];

    // When: generate forbidden checks (the logic used by checker)
    const checks = generateForbiddenPathChecks([".omo"], badIndexed);
    const omoCheck = checks.find((c) => c.pathPattern === ".omo");

    // Then: the checker logic reports a match
    expect(omoCheck?.matched).toBe(true);

    // And: a report with matched forbidden fails CleanSelfScanReportSchema
    const badReport = {
      schemaVersion: "rector.cartographer.selfScan.v1",
      repoRoot: REPO_ROOT,
      snapshotId: "snap-dummy",
      generatedAt: "2026-06-26T00:00:00.000Z",
      indexedFileCount: badIndexed.length,
      ignoredFileCount: 0,
      deletedFileCount: 0,
      changedFileCount: 0,
      scanErrorCount: 0,
      expectedPathChecks: [],
      forbiddenPathChecks: [{ pathPattern: ".omo", matched: true }],
      gitComparison: {
        gitTrackedCount: 0,
        cartographerIndexedCount: badIndexed.length,
        ignoredTrackedCount: 0,
        unexplainedMissing: [],
        unexpectedIndexed: [],
      },
      scanErrors: [],
    } satisfies CartographerSelfScanReport;

    const cleanResult = CleanSelfScanReportSchema.safeParse(badReport);
    expect(cleanResult.success).toBe(false);
  });

  it("leaves the real worktree with no staged or tracked .rector or .omo artifact intent after in-memory failure simulation", () => {
    // Given/When: the previous in-memory mutation did not touch the filesystem
    // Then: git status for .rector and .omo shows no changes to track or stage
    const statusOutput = execSync("GIT_MASTER=1 git status --short -- .rector .omo", {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    expect(statusOutput, "real worktree must not have .rector/.omo changes staged or tracked").toBe("");
  });
});
