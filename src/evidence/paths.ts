import path from "node:path";

export const RECTOR_LOCAL_DIR = ".rector";
export const RECTOR_EVIDENCE_DIR = ".rector/evidence";
export const LEGACY_OMO_EVIDENCE_DIR = ".omo/evidence";

export const EVIDENCE_TRACKS = ["phase0", "phase0.5", "phase1", "phase2", "live/zai", "global", "capabilities"] as const;
export type EvidenceTrack = (typeof EVIDENCE_TRACKS)[number];

export interface EvidencePathEnv {
  RECTOR_EVIDENCE_DIR?: string;
  RECTOR_LEGACY_EVIDENCE_DIR?: string;
}

const TRACK_SEGMENTS: Record<EvidenceTrack, readonly string[]> = {
  phase0: ["phase0"],
  "phase0.5": ["phase0.5"],
  phase1: ["phase1"],
  phase2: ["phase2"],
  "live/zai": ["live", "zai"],
  global: ["global"],
  capabilities: ["capabilities"],
};

/** Single-segment run id safe for evidence directory layout (exported for gate/schema alignment). */
export const SAFE_EVIDENCE_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function getRectorLocalDir(repoRoot?: string): string {
  return path.join(resolveRepoRoot(repoRoot), RECTOR_LOCAL_DIR);
}

export function getEvidenceRoot(repoRoot?: string, env: EvidencePathEnv = process.env): string {
  return resolveEvidenceConfiguredPath(env.RECTOR_EVIDENCE_DIR, RECTOR_EVIDENCE_DIR, "RECTOR_EVIDENCE_DIR", repoRoot);
}

export function getLegacyEvidenceRoot(repoRoot?: string, env: EvidencePathEnv = process.env): string {
  return resolveEvidenceConfiguredPath(
    env.RECTOR_LEGACY_EVIDENCE_DIR,
    LEGACY_OMO_EVIDENCE_DIR,
    "RECTOR_LEGACY_EVIDENCE_DIR",
    repoRoot,
  );
}

export function getEvidenceTrackDir(track: EvidenceTrack, repoRoot?: string): string {
  const segments = TRACK_SEGMENTS[track];
  if (!segments) {
    throw new Error(`Unknown evidence track: ${String(track)}`);
  }
  return path.join(getEvidenceRoot(repoRoot), ...segments);
}

export function getZaiLiveEvidenceDir(repoRoot?: string): string {
  return getEvidenceTrackDir("live/zai", repoRoot);
}

export function getZaiLiveRunEvidenceDir(runId: string, repoRoot?: string): string {
  assertSafeRunId(runId);
  return path.join(getZaiLiveEvidenceDir(repoRoot), "runs", runId);
}

function resolveRepoRoot(repoRoot?: string): string {
  return path.resolve(repoRoot ?? process.cwd());
}

function resolveEvidenceConfiguredPath(
  envValue: string | undefined,
  defaultRelativePath: string,
  envName: string,
  repoRoot?: string,
): string {
  const root = resolveRepoRoot(repoRoot);
  const trimmed = envValue?.trim();
  const hasExplicitOverride = !!trimmed;
  const requestedPath = hasExplicitOverride ? trimmed : defaultRelativePath;
  assertUsablePathText(requestedPath, envName);

  if (isAnyPlatformAbsolute(requestedPath)) {
    if (!hasExplicitOverride) {
      throw new Error(`${envName} default must be repo-relative.`);
    }
    return path.normalize(requestedPath);
  }

  assertNoTraversalSegments(requestedPath, envName);
  const resolved = path.resolve(root, requestedPath);
  assertPathInsideRepo(resolved, root, envName);
  return resolved;
}

export function assertSafeEvidenceRunId(runId: string): void {
  if (!SAFE_EVIDENCE_RUN_ID_PATTERN.test(runId) || runId === "." || runId === "..") {
    throw new Error("Z.ai evidence run id must be a single safe path segment.");
  }
}

function assertSafeRunId(runId: string): void {
  assertSafeEvidenceRunId(runId);
}

function assertUsablePathText(value: string, label: string): void {
  if (value.length === 0) {
    throw new Error(`${label} must not be empty.`);
  }
  if (value.includes("\0")) {
    throw new Error(`${label} must not contain NUL bytes.`);
  }
}

function assertNoTraversalSegments(value: string, label: string): void {
  const segments = value.split(/[\\/]+/);
  if (segments.includes("..")) {
    throw new Error(`${label} must not contain path traversal segments.`);
  }
}

function assertPathInsideRepo(resolvedPath: string, repoRoot: string, label: string): void {
  const relative = path.relative(repoRoot, resolvedPath);
  if (relative === "") return;
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must resolve inside the repo root unless set as an explicit absolute override.`);
  }
}

function isAnyPlatformAbsolute(value: string): boolean {
  return path.isAbsolute(value) || path.win32.isAbsolute(value);
}
