import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, execSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../..");
const CHECKER = path.join(REPO_ROOT, "scripts/cartographer/check-self-scan.ts");


const TSX = "tsx";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasExecErrorShape(err: unknown): err is { code?: number; stdout?: string; stderr?: string } {
  if (!isRecord(err)) return false;
  const candidate = err;
  return (
    (candidate.code === undefined || typeof candidate.code === "number") &&
    (candidate.stdout === undefined || typeof candidate.stdout === "string") &&
    (candidate.stderr === undefined || typeof candidate.stderr === "string")
  );
}

async function runChecker(artifactsDir?: string, env?: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  const args = artifactsDir ? [CHECKER, artifactsDir] : [CHECKER];
  try {
    const res = await execFileAsync(TSX, args, {
      cwd: REPO_ROOT,
      env: { ...process.env, ...(env ?? {}) },
      encoding: "utf8",
    });
    return { code: 0, stdout: res.stdout, stderr: res.stderr };
  } catch (error: unknown) {
    const e = hasExecErrorShape(error) ? error : {};
    return {
      code: e.code ?? 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

async function writeJson(filePath: string, obj: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

async function writeText(filePath: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
}

describe("Cartographer self-scan checker (Todo 9: allowlist + secret leak)", () => {
  const tmpBase = path.join(os.tmpdir(), `rector-cartographer-checker-qa-${process.pid}-${Date.now()}`);
  let allowlistBackup: string | null = null;

  beforeEach(async () => {
    await fs.rm(tmpBase, { recursive: true, force: true });
  });

  afterEach(async () => {
    await fs.rm(tmpBase, { recursive: true, force: true });
  });

  it("passes on clean minimal artifacts with zero errors and default empty allowlist", async () => {
    const dir = path.join(tmpBase, "clean");
    const files = {
      schemaVersion: "rector.cartographer.latestFiles.v1",
      repoRoot: REPO_ROOT,
      generatedAt: "2026-06-26T00:00:00.000Z",
      indexedFileCount: 5,
      scanErrorCount: 0,
      normalizedPaths: ["src/cartographer/a.ts", "src/orchestration/b.ts", "src/providers/c.ts", "src/tools/d.ts", "tests/e.test.ts"],
      scanErrors: [],
    };
    const snap = { indexedFileCount: 5 };
    const md = "# Cartographer Self-Scan Report\n\nscanErrorCount: 0\n";
    await writeJson(path.join(dir, "latest-files.json"), files);
    await writeJson(path.join(dir, "latest-snapshot.json"), snap);
    await writeText(path.join(dir, "scan-report.md"), md);

    const r = await runChecker(dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("PASS");
  });

  it("fails when scanErrorCount > 0 and allowlist is absent/empty (strict default)", async () => {
    const dir = path.join(tmpBase, "err-no-allow");
    const files = {
      schemaVersion: "rector.cartographer.latestFiles.v1",
      repoRoot: REPO_ROOT,
      generatedAt: "2026-06-26T00:00:00.000Z",
      indexedFileCount: 5,
      scanErrorCount: 1,
      normalizedPaths: [
        "src/cartographer/a.ts",
        "src/orchestration/b.ts",
        "src/providers/c.ts",
        "src/tools/d.ts",
        "tests/e.test.ts",
      ],
      scanErrors: [{ path: "src/cartographer/a.ts", stage: "read", message: "boom", recoverable: true }],
    };
    const snap = { indexedFileCount: 5 };
    const md = "# report\n";
    await writeJson(path.join(dir, "latest-files.json"), files);
    await writeJson(path.join(dir, "latest-snapshot.json"), snap);
    await writeText(path.join(dir, "scan-report.md"), md);

    // Use env override to point to an empty allowlist; do not touch committed default
    const emptyAllow = path.join(tmpBase, "empty-allow.json");
    await writeJson(emptyAllow, { schemaVersion: "rector.cartographer.selfScanAllowlist.v1", entries: [] });

    const r = await runChecker(dir, { SELF_SCAN_ALLOWLIST_PATH: emptyAllow });
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/nonzero scan errors not allowlisted/i);
  });

  it("fails when allowlist entry lacks a reason (schema parse yields empty list)", async () => {
    const dir = path.join(tmpBase, "bad-allow");
    const files = {
      schemaVersion: "rector.cartographer.latestFiles.v1",
      repoRoot: REPO_ROOT,
      generatedAt: "2026-06-26T00:00:00.000Z",
      indexedFileCount: 5,
      scanErrorCount: 1,
      normalizedPaths: [
        "src/cartographer/a.ts",
        "src/orchestration/b.ts",
        "src/providers/c.ts",
        "src/tools/d.ts",
        "tests/e.test.ts",
      ],
      scanErrors: [{ path: "src/cartographer/a.ts", stage: "read", message: "boom", recoverable: true }],
    };
    const snap = { indexedFileCount: 5 };
    const md = "# report\n";
    await writeJson(path.join(dir, "latest-files.json"), files);
    await writeJson(path.join(dir, "latest-snapshot.json"), snap);
    await writeText(path.join(dir, "scan-report.md"), md);

    // Malformed allowlist (missing reason) -> schema parse fails -> treated as empty (via env override)
    const badAllow = path.join(tmpBase, "bad-allow.json");
    await writeJson(badAllow, {
      schemaVersion: "rector.cartographer.selfScanAllowlist.v1",
      entries: [{ path: "src/cartographer/a.ts", stage: "read", messageContains: "boom" }],
    });

    const r = await runChecker(dir, { SELF_SCAN_ALLOWLIST_PATH: badAllow });
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/nonzero scan errors not allowlisted/i);
  });

  it("passes when error is allowlisted with a reason", async () => {
    const dir = path.join(tmpBase, "allowed");
    const files = {
      schemaVersion: "rector.cartographer.latestFiles.v1",
      repoRoot: REPO_ROOT,
      generatedAt: "2026-06-26T00:00:00.000Z",
      indexedFileCount: 5,
      scanErrorCount: 1,
      normalizedPaths: [
        "src/cartographer/a.ts",
        "src/orchestration/b.ts",
        "src/providers/c.ts",
        "src/tools/d.ts",
        "tests/e.test.ts",
      ],
      scanErrors: [{ path: "src/cartographer/a.ts", stage: "read", message: "boom", recoverable: true }],
    };
    const snap = { indexedFileCount: 5 };
    const md = "# report\n";
    await writeJson(path.join(dir, "latest-files.json"), files);
    await writeJson(path.join(dir, "latest-snapshot.json"), snap);
    await writeText(path.join(dir, "scan-report.md"), md);

    const okAllow = path.join(tmpBase, "ok-allow.json");
    await writeJson(okAllow, {
      schemaVersion: "rector.cartographer.selfScanAllowlist.v1",
      entries: [{ path: "src/cartographer/a.ts", stage: "read", messageContains: "boom", reason: "known transient fs flake in CI container" }],
    });

    const r = await runChecker(dir, { SELF_SCAN_ALLOWLIST_PATH: okAllow });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("PASS");
  });

  it("fails when generated artifact content contains .env.production (forbidden env filename)", async () => {
    const dir = path.join(tmpBase, "env-leak");
    const files = {
      schemaVersion: "rector.cartographer.latestFiles.v1",
      repoRoot: REPO_ROOT,
      generatedAt: "2026-06-26T00:00:00.000Z",
      indexedFileCount: 5,
      scanErrorCount: 0,
      normalizedPaths: [
        "src/cartographer/a.ts",
        "src/orchestration/b.ts",
        "src/providers/c.ts",
        "src/tools/d.ts",
        "tests/e.test.ts",
      ],
      scanErrors: [],
    };
    const snap = { indexedFileCount: 5 };
    const md = "indexed: src/cartographer/a.ts\n.env.production was present in some listing\n";
    await writeJson(path.join(dir, "latest-files.json"), files);
    await writeJson(path.join(dir, "latest-snapshot.json"), snap);
    await writeText(path.join(dir, "scan-report.md"), md);

    const r = await runChecker(dir);
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/forbidden non-example .env filename/i);
  });

  it("fails when generated artifact content contains synthetic secret marker sk-test-secret", async () => {
    const dir = path.join(tmpBase, "secret-leak");
    const files = {
      schemaVersion: "rector.cartographer.latestFiles.v1",
      repoRoot: REPO_ROOT,
      generatedAt: "2026-06-26T00:00:00.000Z",
      indexedFileCount: 5,
      scanErrorCount: 0,
      normalizedPaths: [
        "src/cartographer/a.ts",
        "src/orchestration/b.ts",
        "src/providers/c.ts",
        "src/tools/d.ts",
        "tests/e.test.ts",
      ],
      scanErrors: [],
    };
    const snap = { indexedFileCount: 5 };
    const md = "# report\nsecret=sk-test-secret\n";
    await writeJson(path.join(dir, "latest-files.json"), files);
    await writeJson(path.join(dir, "latest-snapshot.json"), snap);
    await writeText(path.join(dir, "scan-report.md"), md);

    const r = await runChecker(dir);
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/synthetic secret marker/i);
  });

  it("failure QA on OS temp copy does not modify real worktree .rector/.omo", async () => {
    // Create a tampered copy in the OS temp directory
    const tamperDir = path.join(os.tmpdir(), `rector-cartographer-tamper-${Date.now()}`);
    await fs.rm(tamperDir, { recursive: true, force: true });
    const files = {
      schemaVersion: "rector.cartographer.latestFiles.v1",
      repoRoot: REPO_ROOT,
      generatedAt: "2026-06-26T00:00:00.000Z",
      indexedFileCount: 5,
      scanErrorCount: 0,
      normalizedPaths: [
        "src/cartographer/a.ts",
        "src/orchestration/b.ts",
        "src/providers/c.ts",
        "src/tools/d.ts",
        "tests/e.test.ts",
      ],
      scanErrors: [],
    };
    const snap = { indexedFileCount: 5 };
    const md = "secret=sk-test-secret\n";
    await writeJson(path.join(tamperDir, "latest-files.json"), files);
    await writeJson(path.join(tamperDir, "latest-snapshot.json"), snap);
    await writeText(path.join(tamperDir, "scan-report.md"), md);

    const r = await runChecker(tamperDir);
    expect(r.code).not.toBe(0);

    // Assert real worktree .rector/.omo has no staged/tracked changes from this run
    const status = execSync("GIT_MASTER=1 git status --short -- .rector .omo", {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
    expect(status).toBe("");

    await fs.rm(tamperDir, { recursive: true, force: true });
  });
});
