#!/usr/bin/env tsx
/**
 * check-self-scan.ts (Todo 9)
 * Strict checker for deterministic self-scan artifacts with allowlist + secret-leak assertions.
 *
 * Usage:
 *   tsx scripts/cartographer/check-self-scan.ts [artifactsDir]
 *
 * Default artifactsDir: <repoRoot>/.rector/cartographer
 *
 * Allowlist:
 * - Default: scripts/cartographer/self-scan-allowlist.json (sibling to this script)
 * - Override via env SELF_SCAN_ALLOWLIST_PATH (absolute or relative to repo root)
 * - Absent or empty entries list => zero allowed errors (strict default)
 * - Every entry requires: path, stage, messageContains, reason (all non-empty)
 *
 * Fails (nonzero) if:
 * - expected paths missing
 * - forbidden paths indexed
 * - non-example .env indexed
 * - scanErrorCount > 0 and any error is not allowlisted with a reason
 * - normalizedPaths not sorted ascending
 * - generated artifacts (latest-files.json or scan-report.md) contain forbidden env filenames
 *   beyond .env.example or synthetic secret markers (e.g. sk-test-secret)
 *
 * Tamper QA: pass a temp artifacts dir; checker must exit nonzero on leaks; real artifacts untouched.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SelfScanAllowlistSchema,
  type SelfScanAllowlist,
  type ScanErrorAllowlistEntry,
  type ScanError,
} from "../../src/cartographer";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");

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

const DEFAULT_ALLOWLIST_PATH = path.join(SCRIPT_DIR, "self-scan-allowlist.json");

type LatestFilesArtifact = {
  readonly schemaVersion: string;
  readonly repoRoot: string;
  readonly generatedAt: string;
  readonly indexedFileCount: number;
  readonly scanErrorCount: number;
  readonly normalizedPaths: readonly string[];
  readonly scanErrors?: readonly ScanError[];
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
    if (base === pat || base.startsWith(pat + "/")) return true;
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

async function readAndValidateLatestFilesArtifact(filePath: string): Promise<LatestFilesArtifact> {
  let art: LatestFilesArtifact;
  try {
    art = await readJson<LatestFilesArtifact>(filePath);
  } catch (e) {
    fail(`failed to parse latest-files.json: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(art.normalizedPaths)) {
    fail("latest-files.json missing normalizedPaths array");
  }
  if (!isSortedAscending(art.normalizedPaths)) {
    fail("normalizedPaths is not sorted ascending (nondeterministic)");
  }
  return art;
}

function resolveAllowlistPath(): string {
  const override = process.env.SELF_SCAN_ALLOWLIST_PATH;
  if (override && override.trim().length > 0) {
    return path.isAbsolute(override) ? override : path.resolve(REPO_ROOT, override);
  }
  return DEFAULT_ALLOWLIST_PATH;
}

async function loadAllowlist(): Promise<SelfScanAllowlist> {
  const allowPath = resolveAllowlistPath();
  try {
    const raw = await fs.readFile(allowPath, "utf8");
    const parsed = JSON.parse(raw);
    return SelfScanAllowlistSchema.parse(parsed);
  } catch (e) {
    // Absent file or parse failure => empty allowlist (strict: zero allowed)
    return { schemaVersion: "rector.cartographer.selfScanAllowlist.v1", entries: [] };
  }
}

async function ensureArtifactsExist(paths: readonly string[]): Promise<void> {
  for (const p of paths) {
    try {
      await fs.access(p);
    } catch {
      fail(`missing artifact: ${p}`);
    }
  }
}

function errorMatchesEntry(err: ScanError, entry: ScanErrorAllowlistEntry): boolean {
  if (err.path !== entry.path) return false;
  if (err.stage !== entry.stage) return false;
  return err.message.includes(entry.messageContains);
}

function isErrorAllowlisted(err: ScanError, allowlist: SelfScanAllowlist): boolean {
  return allowlist.entries.some((e) => errorMatchesEntry(err, e));
}

function containsForbiddenEnvInContent(text: string): boolean {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (/\.env \(non-example\)/i.test(line)) continue;
    const m = line.match(/(^|[\s"'`:,\/])((\.env)(?!\.example)(\.[A-Za-z0-9_-]+)?)($|[\s"'`:,\/])/);
    if (m) {
      const candidate = m[2];
      if (candidate && candidate !== ".env.example") return true;
    }
  }
  return false;
}

const SECRET_MARKERS = ["sk-test-secret", "AKIA_TEST_SECRET"] as const;

function containsSecretLeak(text: string): boolean {
  for (const m of SECRET_MARKERS) {
    if (text.includes(m)) return true;
  }
  return false;
}

async function main(): Promise<void> {
  const argDir = process.argv[2];
  const artifactsDir = argDir ? path.resolve(argDir) : path.join(REPO_ROOT, ".rector", "cartographer");

  const filesPath = path.join(artifactsDir, "latest-files.json");
  const snapshotPath = path.join(artifactsDir, "latest-snapshot.json");
  const mdPath = path.join(artifactsDir, "scan-report.md");

  await ensureArtifactsExist([filesPath, snapshotPath, mdPath]);

  const filesArt = await readAndValidateLatestFilesArtifact(filesPath);

  const indexed = filesArt.normalizedPaths;

  for (const exp of DEFAULT_EXPECTED) {
    const present = indexed.some((p) => p === exp || p.startsWith(exp + "/"));
    if (!present) {
      fail(`expected path not indexed: ${exp}`);
    }
  }

  for (const p of indexed) {
    if (matchesForbidden(p, FORBIDDEN_DIR_PATTERNS)) {
      fail(`forbidden path indexed: ${p}`);
    }
  }

  for (const p of indexed) {
    if (isNonExampleEnv(p)) {
      fail(`env file indexed (non-example): ${p}`);
    }
  }

  if (typeof filesArt.scanErrorCount !== "number") {
    fail("scanErrorCount missing or invalid in latest-files.json");
  }

  const allowlist = await loadAllowlist();

  const errors: readonly ScanError[] = Array.isArray(filesArt.scanErrors) ? filesArt.scanErrors : [];
  if (filesArt.scanErrorCount !== errors.length) {
    // keep counts honest; if mismatch, treat as error surface
    fail(`scanErrorCount (${filesArt.scanErrorCount}) does not match scanErrors array length (${errors.length})`);
  }

  if (filesArt.scanErrorCount !== 0) {
    const unallowed = errors.filter((e) => !isErrorAllowlisted(e, allowlist));
    if (unallowed.length > 0) {
      const first = unallowed[0];
      fail(`nonzero scan errors not allowlisted: ${unallowed.length} (first: path=${first.path} stage=${first.stage} msg=${first.message})`);
    }
  }

  // Content leakage checks on generated artifacts (JSON + MD)
  const filesRaw = await fs.readFile(filesPath, "utf8");
  const mdRaw = await fs.readFile(mdPath, "utf8");

  if (containsForbiddenEnvInContent(filesRaw) || containsForbiddenEnvInContent(mdRaw)) {
    fail("generated artifact contains forbidden non-example .env filename in content");
  }
  if (containsSecretLeak(filesRaw) || containsSecretLeak(mdRaw)) {
    fail("generated artifact contains synthetic secret marker (leak)");
  }

  try {
    const snap = await readJson<{ indexedFileCount?: number }>(snapshotPath);
    if (typeof snap.indexedFileCount === "number" && snap.indexedFileCount !== filesArt.indexedFileCount) {
      fail("snapshot indexedFileCount does not match latest-files count");
    }
  } catch {
    // secondary
  }

  console.log(`[cartographer:self-scan:check] PASS (artifactsDir=${artifactsDir})`);
  console.log(`  indexed=${filesArt.indexedFileCount} errors=${filesArt.scanErrorCount}`);
  console.log(`  allowlist=${resolveAllowlistPath()} entries=${allowlist.entries.length}`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[cartographer:self-scan:check] UNEXPECTED ERROR: ${msg}`);
  process.exit(1);
});
