#!/usr/bin/env tsx
import { promises as fs } from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

import {
  getEvidenceRoot,
  getLegacyEvidenceRoot,
  sanitizeEvidencePayload,
  sanitizeEvidenceStringLeaves,
  type EvidencePathEnv,
} from "../../src/evidence";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const LEGACY_IMPORT_DIR = "legacy-omo-import";
const IMPORT_SUMMARY_SCHEMA_VERSION = "rector.legacy-omo-import.v1";
const IMPORT_FILE_SCHEMA_VERSION = "rector.legacy-omo-import-file.v1";
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

const RESIDUAL_SECRET_PATTERNS = [
  /\bBearer\s+(?!\[REDACTED])[^ \t\r\n,;]+/i,
  /\bBasic\s+(?!\[REDACTED])[^ \t\r\n,;]+/i,
  /\b(api[_-]?key|token|secret|password)=((?!\[REDACTED])[^ \t\r\n,;&]+)/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^ \t\r\n/@]+:[^ \t\r\n/@]+@/i,
] as const;

export type LegacyEvidenceMigrationAction = "copied" | "summarized" | "would_copy" | "would_summarize" | "skipped";

export interface LegacyEvidenceMigrationFile {
  schemaVersion: typeof IMPORT_FILE_SCHEMA_VERSION;
  sourceRelativePath: string;
  destinationRelativePath?: string;
  action: LegacyEvidenceMigrationAction;
  reason?: string;
  sizeBytes: number;
}

export interface LegacyEvidenceMigrationFailure {
  code: "unsafe_path" | "io_error";
  message: string;
  path?: string;
}

export interface LegacyEvidenceMigrationResult {
  schemaVersion: typeof IMPORT_SUMMARY_SCHEMA_VERSION;
  ok: boolean;
  applied: boolean;
  generatedAt: string;
  sourceRoot: string;
  destinationRoot: string;
  files: LegacyEvidenceMigrationFile[];
  copiedCount: number;
  summarizedCount: number;
  skippedCount: number;
  failures: LegacyEvidenceMigrationFailure[];
}

export interface MigrateLocalEvidenceOptions {
  repoRoot?: string;
  env?: EvidencePathEnv;
  apply?: boolean;
  maxFileBytes?: number;
  now?: () => Date;
}

interface LegacyEntry {
  absolutePath: string;
  relativePath: string;
  kind: "file" | "symlink" | "unsupported";
}

interface PreparedLegacyFile {
  action: "copy" | "summarize";
  reason?: string;
  content?: string;
  sizeBytes: number;
}

export async function migrateLocalEvidence(options: MigrateLocalEvidenceOptions = {}): Promise<LegacyEvidenceMigrationResult> {
  const repoRoot = path.resolve(options.repoRoot ?? REPO_ROOT);
  const env = options.env ?? process.env;
  const apply = options.apply === true;
  const generatedAt = (options.now?.() ?? new Date()).toISOString();
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const failures: LegacyEvidenceMigrationFailure[] = [];
  const files: LegacyEvidenceMigrationFile[] = [];

  let sourceRoot: string;
  let destinationRoot: string;
  try {
    sourceRoot = getLegacyEvidenceRoot(repoRoot, env);
    destinationRoot = path.join(getEvidenceRoot(repoRoot, env), LEGACY_IMPORT_DIR);
  } catch (error) {
    return makeResult({
      ok: false,
      apply,
      generatedAt,
      sourceRoot: "",
      destinationRoot: "",
      files,
      failures: [{ code: "unsafe_path", message: errorMessage(error) }],
    });
  }

  if (pathsOverlap(sourceRoot, destinationRoot)) {
    return makeResult({
      ok: false,
      apply,
      generatedAt,
      sourceRoot,
      destinationRoot,
      files,
      failures: [
        {
          code: "unsafe_path",
          message: "Legacy evidence source and Rector import destination must not overlap.",
          path: destinationRoot,
        },
      ],
    });
  }

  const sourceExists = await directoryExists(sourceRoot);
  if (!sourceExists) {
    return makeResult({ ok: true, apply, generatedAt, sourceRoot, destinationRoot, files, failures });
  }

  let entries: LegacyEntry[];
  try {
    entries = await collectLegacyEntries(sourceRoot);
  } catch (error) {
    return makeResult({
      ok: false,
      apply,
      generatedAt,
      sourceRoot,
      destinationRoot,
      files,
      failures: [{ code: "io_error", message: errorMessage(error), path: sourceRoot }],
    });
  }

  for (const entry of entries) {
    const prepared = await prepareLegacyEntry(entry, maxFileBytes);
    const action = materializedAction(prepared.action, apply);
    const destinationRelativePath =
      prepared.action === "copy" ? entry.relativePath : `${entry.relativePath}.metadata.json`;
    const record: LegacyEvidenceMigrationFile = sanitizeEvidenceStringLeaves({
      schemaVersion: IMPORT_FILE_SCHEMA_VERSION,
      sourceRelativePath: entry.relativePath,
      destinationRelativePath,
      action,
      ...(prepared.reason ? { reason: prepared.reason } : {}),
      sizeBytes: prepared.sizeBytes,
    });

    files.push(record);
    if (!apply) continue;

    if (prepared.action === "copy" && prepared.content !== undefined) {
      await writeTextInside(destinationRoot, destinationRelativePath, prepared.content);
    } else {
      await writeJsonInside(destinationRoot, destinationRelativePath, record);
    }
  }

  const result = makeResult({ ok: failures.length === 0, apply, generatedAt, sourceRoot, destinationRoot, files, failures });
  if (apply && result.ok) {
    await writeJsonInside(destinationRoot, "import-summary.json", result);
  }
  return result;
}

export function formatMigrateLocalEvidenceResult(result: LegacyEvidenceMigrationResult): string {
  const lines = [
    result.ok ? "[evidence:migrate-local] PASS" : "[evidence:migrate-local] FAIL",
    `  applied: ${result.applied}`,
    `  sourceRoot: ${result.sourceRoot || "unresolved"}`,
    `  destinationRoot: ${result.destinationRoot || "unresolved"}`,
    `  copied: ${result.copiedCount}`,
    `  summarized: ${result.summarizedCount}`,
    `  skipped: ${result.skippedCount}`,
  ];
  for (const failure of result.failures) {
    lines.push(`  failure: ${failure.code}: ${failure.message}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function migrateLocalEvidenceCli(
  argv: readonly string[] = process.argv.slice(2),
  io: Pick<NodeJS.Process, "stdout" | "stderr"> = process,
): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    io.stdout.write(`${usage()}\n`);
    return 0;
  }

  const result = await migrateLocalEvidence({
    repoRoot: args.repoRoot,
    apply: args.apply,
    maxFileBytes: args.maxFileBytes,
  });
  io[result.ok ? "stdout" : "stderr"].write(formatMigrateLocalEvidenceResult(result));
  return result.ok ? 0 : 1;
}

async function collectLegacyEntries(root: string, current = root): Promise<LegacyEntry[]> {
  const dirents = (await fs.readdir(current, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const entries: LegacyEntry[] = [];

  for (const dirent of dirents) {
    const absolutePath = path.join(current, dirent.name);
    const relativePath = safeRelativePath(root, absolutePath);
    if (dirent.isDirectory()) {
      entries.push(...(await collectLegacyEntries(root, absolutePath)));
    } else if (dirent.isFile()) {
      entries.push({ absolutePath, relativePath, kind: "file" });
    } else if (dirent.isSymbolicLink()) {
      entries.push({ absolutePath, relativePath, kind: "symlink" });
    } else {
      entries.push({ absolutePath, relativePath, kind: "unsupported" });
    }
  }

  return entries;
}

async function prepareLegacyEntry(entry: LegacyEntry, maxFileBytes: number): Promise<PreparedLegacyFile> {
  if (entry.kind !== "file") {
    return { action: "summarize", reason: `${entry.kind}_not_imported`, sizeBytes: 0 };
  }

  const stat = await fs.stat(entry.absolutePath);
  if (stat.size > maxFileBytes) {
    return { action: "summarize", reason: "file_too_large_for_safe_import", sizeBytes: stat.size };
  }

  const buffer = await fs.readFile(entry.absolutePath);
  const decoded = decodeUtf8(buffer);
  if (decoded === undefined || buffer.includes(0)) {
    return { action: "summarize", reason: "binary_or_non_utf8_file", sizeBytes: stat.size };
  }

  const sanitizedContent = sanitizeLegacyContent(decoded, entry.relativePath);
  if (hasResidualSecret(sanitizedContent)) {
    return { action: "summarize", reason: "residual_secret_pattern_after_redaction", sizeBytes: stat.size };
  }

  return { action: "copy", content: sanitizedContent, sizeBytes: stat.size };
}

function sanitizeLegacyContent(content: string, relativePath: string): string {
  if (relativePath.toLowerCase().endsWith(".json")) {
    try {
      const parsed = JSON.parse(content) as unknown;
      return `${JSON.stringify(sanitizeEvidencePayload(parsed), null, 2)}\n`;
    } catch {
      // Invalid legacy JSON is imported as redacted text instead of being trusted as structured data.
    }
  }

  return sanitizeEvidencePayload({ content }).content;
}

function decodeUtf8(buffer: Buffer): string | undefined {
  try {
    return UTF8_DECODER.decode(buffer);
  } catch {
    return undefined;
  }
}

function hasResidualSecret(content: string): boolean {
  return RESIDUAL_SECRET_PATTERNS.some((pattern) => pattern.test(content));
}

async function writeTextInside(root: string, relativePath: string, content: string): Promise<void> {
  const absolutePath = resolveInside(root, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, "utf8");
}

async function writeJsonInside(root: string, relativePath: string, payload: unknown): Promise<void> {
  await writeTextInside(root, relativePath, `${JSON.stringify(sanitizeEvidenceStringLeaves(payload), null, 2)}\n`);
}

function resolveInside(root: string, relativePath: string): string {
  if (path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    throw new Error(`Import destination must be relative: ${relativePath}`);
  }
  const absolutePath = path.resolve(root, ...relativePath.split("/"));
  if (!isPathInside(root, absolutePath)) {
    throw new Error(`Import destination escapes target root: ${relativePath}`);
  }
  return absolutePath;
}

function safeRelativePath(root: string, absolutePath: string): string {
  const relative = path.relative(root, absolutePath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Legacy evidence path escapes source root: ${absolutePath}`);
  }
  return relative.split(path.sep).join("/");
}

function materializedAction(action: PreparedLegacyFile["action"], apply: boolean): LegacyEvidenceMigrationAction {
  if (action === "copy") return apply ? "copied" : "would_copy";
  return apply ? "summarized" : "would_summarize";
}

function makeResult(input: {
  ok: boolean;
  apply: boolean;
  generatedAt: string;
  sourceRoot: string;
  destinationRoot: string;
  files: LegacyEvidenceMigrationFile[];
  failures: LegacyEvidenceMigrationFailure[];
}): LegacyEvidenceMigrationResult {
  const copiedCount = input.files.filter((file) => file.action === "copied" || file.action === "would_copy").length;
  const summarizedCount = input.files.filter(
    (file) => file.action === "summarized" || file.action === "would_summarize",
  ).length;
  const skippedCount = input.files.filter((file) => file.action === "skipped").length;
  return sanitizeEvidenceStringLeaves({
    schemaVersion: IMPORT_SUMMARY_SCHEMA_VERSION,
    ok: input.ok,
    applied: input.apply,
    generatedAt: input.generatedAt,
    sourceRoot: displayPath(input.sourceRoot),
    destinationRoot: displayPath(input.destinationRoot),
    files: input.files,
    copiedCount,
    summarizedCount,
    skippedCount,
    failures: input.failures,
  });
}

async function directoryExists(absolutePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(absolutePath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function pathsOverlap(left: string, right: string): boolean {
  return isPathInside(left, right) || isPathInside(right, left);
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function displayPath(absolutePath: string): string {
  if (!absolutePath) return "";
  const relative = path.relative(REPO_ROOT, absolutePath);
  if (relative === "") return ".";
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join("/");
  }
  return sanitizeEvidencePayload({ path: absolutePath }).path;
}

function parseArgs(argv: readonly string[]): { repoRoot?: string; apply: boolean; maxFileBytes?: number; help: boolean } {
  let repoRoot: string | undefined;
  let apply = false;
  let maxFileBytes: number | undefined;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--repo-root") {
      repoRoot = requireValue(argv, ++index, arg);
    } else if (arg === "--apply") {
      apply = true;
    } else if (arg === "--max-file-bytes") {
      maxFileBytes = Number(requireValue(argv, ++index, arg));
      if (!Number.isInteger(maxFileBytes) || maxFileBytes < 0) {
        throw new Error("--max-file-bytes must be a non-negative integer.");
      }
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return { repoRoot, apply, maxFileBytes, help };
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value.`);
  return value;
}

function usage(): string {
  return [
    "Usage: tsx scripts/evidence/migrate-local-evidence.ts [--repo-root <path>] [--apply] [--max-file-bytes <bytes>]",
    "",
    "Dry-runs by default. With --apply, imports redacted legacy .omo/evidence files into .rector/evidence/legacy-omo-import/.",
  ].join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMain(): boolean {
  const entry = process.argv[1];
  return !!entry && fileURLToPath(import.meta.url) === path.resolve(entry);
}

if (isMain()) {
  migrateLocalEvidenceCli().then((code) => {
    process.exitCode = code;
  }).catch((error: unknown) => {
    process.stderr.write(`[evidence:migrate-local] FAILED: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
