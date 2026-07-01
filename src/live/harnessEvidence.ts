import crypto from "node:crypto";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { sanitizeEvidenceStringLeaves } from "../evidence";

export const SOURCE_WORKSPACE_MANIFEST_SCHEMA_VERSION = "rector.source-workspace-manifest.v1";
export const WORKSPACE_MANIFEST_SERIES_SCHEMA_VERSION = "rector.workspace-manifest-series.v1";

const EXCLUDED_DIR_NAMES = new Set([
  ".cache",
  ".git",
  ".next",
  ".nuxt",
  ".omo",
  ".rector",
  ".turbo",
  ".vite",
  "build",
  "cache",
  "coverage",
  "dist",
  "logs",
  "node_modules",
  "out",
  "temp",
  "tmp",
]);

const EXCLUDED_FILE_NAMES = new Set([
  ".DS_Store",
]);

const SECRET_LEAK_PATTERNS = [
  /\bBearer\s+(?!\[REDACTED])[^"\s,;]+/i,
  /\bBasic\s+(?!\[REDACTED])[^"\s,;]+/i,
  /\bsk-[A-Za-z0-9_-]{8,}\b/i,
  /\b(api[_-]?key|token|secret|password)=((?!\[REDACTED])[^"\s,;&]+)/i,
  /\bOPENAI_COMPATIBLE_API_KEY\b/i,
  /\bREGOLO_API_KEY\b/i,
  /\bZAI_API_KEY\b/i,
  /\bAuthorization\b/i,
];

/** Env var names that must never appear in live matrix command logs or rollups. */
export const LIVE_MATRIX_CREDENTIAL_ENV_KEYS = new Set([
  "ZAI_API_KEY",
  "REGOLO_API_KEY",
  "OPENAI_COMPATIBLE_API_KEY",
  "Authorization",
]);

const MATRIX_STEP_REPRO_ENV_EXACT = new Set([
  "CI",
  "LIVE_FACT_EVALS",
  "NODE_ENV",
  "OPENAI_COMPATIBLE_BASE_URL",
  "REGOLO_BASE_URL",
  "REGOLO_MODEL",
  "REGOLO_MODELS",
  "RECTOR_LIVE_PROVIDER",
  "ZAI_BASE_URL",
  "ZAI_MODEL",
  "ZAI_MODELS",
]);

const MATRIX_STEP_REPRO_ENV_PREFIXES = [
  "REGOLO_MATRIX_",
  "RECTOR_LIVE_",
  "RECTOR_REGOLO_",
  "RECTOR_ZAI_",
  "ZAI_MATRIX_",
] as const;

const SENSITIVE_MATRIX_ENV_NAME_PATTERN =
  /(?:^|_)(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION|PRIVATE[_-]?KEY)(?:$|_)/i;

/** True when an env var name must not be listed in matrix step logs (allowlist-only policy). */
export function isSensitiveMatrixEnvKeyName(key: string): boolean {
  if (LIVE_MATRIX_CREDENTIAL_ENV_KEYS.has(key)) return true;
  if (isMatrixStepReproEnvKey(key)) return false;
  return SENSITIVE_MATRIX_ENV_NAME_PATTERN.test(key);
}

/** Env keys safe to record for reproducing a matrix step (values are never written). */
export function isMatrixStepReproEnvKey(key: string): boolean {
  if (MATRIX_STEP_REPRO_ENV_EXACT.has(key)) return true;
  return MATRIX_STEP_REPRO_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function listMatrixStepReproEnvKeys(env: Record<string, string>): readonly string[] {
  return Object.keys(env).filter(isMatrixStepReproEnvKey).sort();
}

export interface SourceWorkspaceManifestFile {
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface SourceWorkspaceManifest {
  readonly schemaVersion: typeof SOURCE_WORKSPACE_MANIFEST_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly repoRoot: ".";
  readonly excludes: readonly string[];
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly files: readonly SourceWorkspaceManifestFile[];
}

export interface WorkspaceManifestDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
  readonly mutatedPaths: readonly string[];
  readonly mutationDetected: boolean;
}

export interface WorkspaceManifestSeriesEntry {
  readonly scenarioId: string;
  readonly manifest: SourceWorkspaceManifest;
}

export interface WorkspaceManifestSeries {
  readonly schemaVersion: typeof WORKSPACE_MANIFEST_SERIES_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly runId: string;
  readonly scenarios: readonly WorkspaceManifestSeriesEntry[];
}

export async function computeSourceWorkspaceManifest(
  repoRoot: string,
  options: { readonly generatedAt?: string; readonly now?: () => Date } = {},
): Promise<SourceWorkspaceManifest> {
  const root = path.resolve(repoRoot);
  const files = await collectSourceFiles(root);
  const entries: SourceWorkspaceManifestFile[] = [];
  for (const relativePath of files) {
    const absolutePath = path.join(root, relativePath);
    const content = await fs.readFile(absolutePath);
    entries.push({
      path: toPosix(relativePath),
      sizeBytes: content.byteLength,
      sha256: crypto.createHash("sha256").update(content).digest("hex"),
    });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return {
    schemaVersion: SOURCE_WORKSPACE_MANIFEST_SCHEMA_VERSION,
    generatedAt: options.generatedAt ?? (options.now?.() ?? new Date()).toISOString(),
    repoRoot: ".",
    excludes: [...EXCLUDED_DIR_NAMES].sort(),
    fileCount: entries.length,
    totalBytes: entries.reduce((total, entry) => total + entry.sizeBytes, 0),
    files: entries,
  };
}

export function diffWorkspaceManifests(
  before: SourceWorkspaceManifest,
  after: SourceWorkspaceManifest,
): WorkspaceManifestDiff {
  const beforeByPath = new Map(before.files.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.files.map((entry) => [entry.path, entry]));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const [filePath, afterEntry] of afterByPath) {
    const beforeEntry = beforeByPath.get(filePath);
    if (!beforeEntry) {
      added.push(filePath);
      continue;
    }
    if (beforeEntry.sha256 !== afterEntry.sha256 || beforeEntry.sizeBytes !== afterEntry.sizeBytes) {
      changed.push(filePath);
    }
  }
  for (const filePath of beforeByPath.keys()) {
    if (!afterByPath.has(filePath)) removed.push(filePath);
  }

  const mutatedPaths = [...added, ...removed, ...changed].sort();
  return {
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort(),
    mutatedPaths,
    mutationDetected: mutatedPaths.length > 0,
  };
}

export function buildWorkspaceManifestSeries(input: {
  readonly generatedAt: string;
  readonly runId: string;
  readonly scenarios: readonly WorkspaceManifestSeriesEntry[];
}): WorkspaceManifestSeries {
  return {
    schemaVersion: WORKSPACE_MANIFEST_SERIES_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    runId: input.runId,
    scenarios: input.scenarios,
  };
}

export async function writeJsonArtifact(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const safeValue = sanitizeHarnessEvidenceValue(value);
  await fs.writeFile(filePath, `${JSON.stringify(safeValue, null, 2)}\n`, "utf8");
}

export async function writeJsonlArtifact(filePath: string, values: readonly unknown[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const lines = values.map((value) => JSON.stringify(sanitizeHarnessEvidenceValue(value)));
  await fs.writeFile(filePath, lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf8");
}

export function sanitizeHarnessEvidenceValue<T>(value: T): T {
  return hardenStringLeaves(sanitizeEvidenceStringLeaves(value)) as T;
}

export function secretLeakFindings(value: unknown): string[] {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (!serialized) return [];
  return SECRET_LEAK_PATTERNS
    .map((pattern) => pattern.exec(serialized)?.[0])
    .filter((match): match is string => typeof match === "string" && match.length > 0)
    .map((match) => match.slice(0, 80));
}

export function assertLiveMatrixArtifactHasNoSecrets(
  value: unknown,
  options: {
    readonly artifactLabel: string;
    readonly credentialEnvKeys?: ReadonlySet<string>;
  },
): void {
  const credentialEnvKeys = options.credentialEnvKeys ?? LIVE_MATRIX_CREDENTIAL_ENV_KEYS;
  const findings = secretLeakFindings(value);
  if (findings.length > 0) {
    throw new Error(`${options.artifactLabel} artifact contains secret-like content: ${findings.join(", ")}`);
  }
  const serialized = JSON.stringify(value);
  for (const key of credentialEnvKeys) {
    const pattern = new RegExp(`${key}\\s*[:=]\\s*["']?[^\\s"']{8,}`, "i");
    if (pattern.test(serialized)) {
      throw new Error(`${options.artifactLabel} artifact must not embed ${key} values.`);
    }
  }
  assertMatrixArtifactEnvKeysAllowlist(value, options.artifactLabel);
}

function assertMatrixArtifactEnvKeysAllowlist(value: unknown, artifactLabel: string): void {
  if (Array.isArray(value)) {
    for (const entry of value) assertMatrixArtifactEnvKeysAllowlist(entry, artifactLabel);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "envKeys" && Array.isArray(child)) {
      for (const envKey of child) {
        if (typeof envKey !== "string") continue;
        if (isSensitiveMatrixEnvKeyName(envKey)) {
          throw new Error(
            `${artifactLabel} artifact must not enumerate sensitive env var name: ${envKey}`,
          );
        }
      }
    }
    assertMatrixArtifactEnvKeysAllowlist(child, artifactLabel);
  }
}

function hardenStringLeaves(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
      .replace(/\bBearer\s+(?!\[REDACTED])[^"\s,;]+/gi, "Bearer [REDACTED]")
      .replace(/\bBasic\s+(?!\[REDACTED])[^"\s,;]+/gi, "Basic [REDACTED]")
      .replace(/\bOPENAI_COMPATIBLE_API_KEY\b/g, "[REDACTED_KEY_NAME]")
      .replace(/\bREGOLO_API_KEY\b/g, "[REDACTED_KEY_NAME]")
      .replace(/\bZAI_API_KEY\b/g, "[REDACTED_KEY_NAME]")
      .replace(/\bAuthorization\b/g, "[REDACTED_HEADER_NAME]");
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => hardenStringLeaves(entry));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, hardenStringLeaves(child)]),
  );
}

async function collectSourceFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(relativeDir: string): Promise<void> {
    const absoluteDir = path.join(root, relativeDir);
    let entries: Dirent[];
    try {
      entries = await fs.readdir(absoluteDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name.includes("\0") || EXCLUDED_FILE_NAMES.has(entry.name)) continue;
      const relativePath = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
        await visit(relativePath);
        continue;
      }
      if (entry.isFile()) {
        output.push(relativePath);
      }
    }
  }
  await visit("");
  return output;
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}
