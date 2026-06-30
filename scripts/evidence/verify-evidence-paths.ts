#!/usr/bin/env tsx
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  defaultEvidenceTrackPointers,
  EVIDENCE_TRACKS,
  getEvidenceRoot,
  getLegacyEvidenceRoot,
  sanitizeEvidencePayload,
  type EvidenceManifest,
  type EvidencePathEnv,
  type EvidenceTrack,
} from "../../src/evidence";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DEFAULT_MANIFEST_NAMES = ["evidence-manifest.json", "manifest.json"] as const;
const TRACK_POINTER_FIELDS = ["directory", "latestJson", "latestMarkdown", "indexJson"] as const;

export type EvidencePathFailureCode =
  | "unsafe_override"
  | "missing_track_dir"
  | "invalid_manifest"
  | "manifest_path_outside_root"
  | "manifest_pointer_outside_root"
  | "manifest_pointer_invalid";

export interface EvidencePathFailure {
  code: EvidencePathFailureCode;
  message: string;
  path?: string;
  track?: string;
  pointer?: string;
}

export interface VerifyEvidencePathsOptions {
  repoRoot?: string;
  env?: EvidencePathEnv;
  requireTrackDirs?: boolean;
  manifestPath?: string;
  manifest?: EvidenceManifest;
}

export interface VerifyEvidencePathsResult {
  ok: boolean;
  repoRoot: string;
  evidenceRoot?: string;
  legacyEvidenceRoot?: string;
  checkedTrackDirs: string[];
  manifestPath?: string;
  manifestChecked: boolean;
  failures: EvidencePathFailure[];
}

export async function verifyEvidencePaths(options: VerifyEvidencePathsOptions = {}): Promise<VerifyEvidencePathsResult> {
  const repoRoot = path.resolve(options.repoRoot ?? REPO_ROOT);
  const env = options.env ?? process.env;
  const failures: EvidencePathFailure[] = [];
  const checkedTrackDirs: string[] = [];

  validateOverrideText(env, "RECTOR_EVIDENCE_DIR", failures);
  validateOverrideText(env, "RECTOR_LEGACY_EVIDENCE_DIR", failures);

  const evidenceRoot = resolveConfiguredRoot(() => getEvidenceRoot(repoRoot, env), "RECTOR_EVIDENCE_DIR", failures);
  const legacyEvidenceRoot = resolveConfiguredRoot(
    () => getLegacyEvidenceRoot(repoRoot, env),
    "RECTOR_LEGACY_EVIDENCE_DIR",
    failures,
  );

  let manifestPath: string | undefined;
  let manifestChecked = false;

  if (evidenceRoot) {
    if (options.requireTrackDirs) {
      const pointers = defaultEvidenceTrackPointers(evidenceRoot);
      for (const track of EVIDENCE_TRACKS) {
        const trackDir = path.normalize(pointers[track].directory);
        checkedTrackDirs.push(trackDir);
        try {
          const stat = await fs.stat(trackDir);
          if (!stat.isDirectory()) {
            failures.push({
              code: "missing_track_dir",
              track,
              path: trackDir,
              message: `Expected evidence track directory is not a directory: ${track}`,
            });
          }
        } catch {
          failures.push({
            code: "missing_track_dir",
            track,
            path: trackDir,
            message: `Expected evidence track directory is missing: ${track}`,
          });
        }
      }
    }

    const manifestLoad = await loadManifest(options, repoRoot, evidenceRoot, failures);
    manifestPath = manifestLoad.manifestPath;
    if (manifestLoad.manifest) {
      manifestChecked = true;
      validateManifestPointers(manifestLoad.manifest, repoRoot, evidenceRoot, failures);
    }
  }

  return sanitizeEvidencePayload({
    ok: failures.length === 0,
    repoRoot,
    evidenceRoot,
    legacyEvidenceRoot,
    checkedTrackDirs,
    manifestPath,
    manifestChecked,
    failures,
  });
}

export function formatVerifyEvidencePathsResult(result: VerifyEvidencePathsResult): string {
  const lines = [
    result.ok ? "[evidence:verify-paths] PASS" : "[evidence:verify-paths] FAIL",
    `  repoRoot: ${result.repoRoot}`,
    result.evidenceRoot ? `  evidenceRoot: ${result.evidenceRoot}` : "",
    result.legacyEvidenceRoot ? `  legacyEvidenceRoot: ${result.legacyEvidenceRoot}` : "",
    result.manifestPath ? `  manifest: ${result.manifestPath}` : "  manifest: not checked",
    `  checkedTrackDirs: ${result.checkedTrackDirs.length}`,
  ].filter(Boolean);

  for (const failure of result.failures) {
    lines.push(`  failure: ${failure.code}: ${failure.message}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function verifyEvidencePathsCli(
  argv: readonly string[] = process.argv.slice(2),
  io: Pick<NodeJS.Process, "stdout" | "stderr"> = process,
): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    io.stdout.write(`${usage()}\n`);
    return 0;
  }

  const result = await verifyEvidencePaths({
    repoRoot: args.repoRoot,
    requireTrackDirs: args.requireTrackDirs,
    manifestPath: args.manifestPath,
  });
  io[result.ok ? "stdout" : "stderr"].write(formatVerifyEvidencePathsResult(result));
  return result.ok ? 0 : 1;
}

function validateOverrideText(env: EvidencePathEnv, key: keyof EvidencePathEnv, failures: EvidencePathFailure[]): void {
  if (!Object.prototype.hasOwnProperty.call(env, key)) return;
  const value = env[key];
  if (value === undefined) return;
  if (value.trim().length === 0) {
    failures.push({
      code: "unsafe_override",
      message: `${key} override must not be empty or whitespace-only.`,
    });
  }
  if (value.includes("\0")) {
    failures.push({
      code: "unsafe_override",
      message: `${key} override must not contain NUL bytes.`,
    });
  }
}

function resolveConfiguredRoot(
  resolver: () => string,
  envName: keyof EvidencePathEnv,
  failures: EvidencePathFailure[],
): string | undefined {
  try {
    return resolver();
  } catch (error) {
    failures.push({
      code: "unsafe_override",
      message: `${envName} is unsafe: ${errorMessage(error)}`,
    });
    return undefined;
  }
}

async function loadManifest(
  options: VerifyEvidencePathsOptions,
  repoRoot: string,
  evidenceRoot: string,
  failures: EvidencePathFailure[],
): Promise<{ manifest?: EvidenceManifest; manifestPath?: string }> {
  if (options.manifest) {
    return { manifest: options.manifest, manifestPath: options.manifestPath };
  }

  const manifestPath = options.manifestPath
    ? resolvePointerPath(options.manifestPath, repoRoot)
    : await findDefaultManifestPath(evidenceRoot);
  if (!manifestPath) return {};

  if (!isPathInside(evidenceRoot, manifestPath)) {
    failures.push({
      code: "manifest_path_outside_root",
      path: manifestPath,
      message: "Evidence manifest path must resolve inside the evidence root.",
    });
    return { manifestPath };
  }

  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    return { manifest: JSON.parse(raw) as EvidenceManifest, manifestPath };
  } catch (error) {
    failures.push({
      code: "invalid_manifest",
      path: manifestPath,
      message: `Could not read or parse evidence manifest: ${errorMessage(error)}`,
    });
    return { manifestPath };
  }
}

async function findDefaultManifestPath(evidenceRoot: string): Promise<string | undefined> {
  for (const name of DEFAULT_MANIFEST_NAMES) {
    const candidate = path.join(evidenceRoot, name);
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // Missing default manifests are allowed; writer scripts are intentionally separate.
    }
  }
  return undefined;
}

function validateManifestPointers(
  manifest: EvidenceManifest,
  repoRoot: string,
  evidenceRoot: string,
  failures: EvidencePathFailure[],
): void {
  if (!manifest || typeof manifest !== "object" || !manifest.tracks || typeof manifest.tracks !== "object") {
    failures.push({
      code: "invalid_manifest",
      message: "Evidence manifest must include a tracks object.",
    });
    return;
  }

  for (const [track, trackPointer] of Object.entries(manifest.tracks) as Array<[EvidenceTrack, Record<string, unknown>]>) {
    for (const field of TRACK_POINTER_FIELDS) {
      const value = trackPointer[field];
      if (value === undefined) continue;
      if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
        failures.push({
          code: "manifest_pointer_invalid",
          track,
          pointer: field,
          message: `Manifest pointer ${track}.${field} must be a non-empty safe string.`,
        });
        continue;
      }

      const resolved = resolvePointerPath(value, repoRoot);
      if (!isPathInside(evidenceRoot, resolved)) {
        failures.push({
          code: "manifest_pointer_outside_root",
          track,
          pointer: field,
          path: resolved,
          message: `Manifest pointer ${track}.${field} resolves outside the evidence root.`,
        });
      }
    }
  }
}

function resolvePointerPath(pointer: string, repoRoot: string): string {
  if (path.isAbsolute(pointer) || path.win32.isAbsolute(pointer)) {
    return path.normalize(pointer);
  }
  return path.resolve(repoRoot, pointer);
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function parseArgs(argv: readonly string[]): { repoRoot?: string; manifestPath?: string; requireTrackDirs: boolean; help: boolean } {
  let repoRoot: string | undefined;
  let manifestPath: string | undefined;
  let requireTrackDirs = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--repo-root") {
      repoRoot = requireValue(argv, ++index, arg);
    } else if (arg === "--manifest") {
      manifestPath = requireValue(argv, ++index, arg);
    } else if (arg === "--require-track-dirs") {
      requireTrackDirs = true;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return { repoRoot, manifestPath, requireTrackDirs, help };
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value.`);
  return value;
}

function usage(): string {
  return [
    "Usage: tsx scripts/evidence/verify-evidence-paths.ts [--repo-root <path>] [--manifest <path>] [--require-track-dirs]",
    "",
    "Verifies Rector evidence roots, optional post-run track directories, and manifest pointer confinement.",
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
  verifyEvidencePathsCli().then((code) => {
    process.exitCode = code;
  }).catch((error: unknown) => {
    process.stderr.write(`[evidence:verify-paths] FAILED: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
