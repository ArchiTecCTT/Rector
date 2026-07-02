import fs from "node:fs/promises";
import path from "node:path";

import { getEvidenceTrackDir, getRegoloLiveEvidenceDir, getZaiLiveEvidenceDir } from "../evidence";

export type LiveMatrixEvidenceTrack = "zai" | "regolo";

/** Sentinel when a campaign did not capture an artifact into its isolated snapshot. */
export const MATRIX_ARTIFACT_NOT_CAPTURED = "not captured";

/** Live matrix steps that refresh specific canonical artifacts (copied after the step). */
export const MATRIX_LIVE_STEP_ARTIFACT_DEST: Record<string, readonly string[]> = {
  "eval:facts:live": ["phase2-live-fact-shadow-report.json"],
  "test:live:zai:provider": ["provider-smoke.json"],
  "test:live:regolo:provider": ["provider-smoke.json"],
  "test:live:zai:harness": ["latest.json", "latest.md"],
  "test:live:regolo:harness": ["latest.json", "latest.md"],
};

const MATRIX_SNAPSHOT_ARTIFACT_ORDER = [
  "latest.json",
  "latest.md",
  "provider-smoke.json",
  "phase2-live-fact-shadow-report.json",
] as const;

export type MatrixCampaignReportPointer = string;

export interface MatrixCampaignSnapshotPointers {
  readonly latestJson: MatrixCampaignReportPointer;
  readonly latestMd: MatrixCampaignReportPointer;
  readonly providerSmokeJson: MatrixCampaignReportPointer;
  readonly phase2ShadowJson: MatrixCampaignReportPointer;
}

export type MatrixSnapshotHealth = "complete" | "partial" | "empty";

export interface MatrixSkippedArtifact {
  readonly destName: string;
  readonly reason: string;
}

export interface MatrixCampaignSnapshotResult {
  readonly evidenceSnapshotDir: string;
  readonly reportPointers: MatrixCampaignSnapshotPointers;
  readonly copiedFiles: readonly string[];
  readonly skippedArtifacts: readonly MatrixSkippedArtifact[];
  readonly snapshotHealth: MatrixSnapshotHealth;
  readonly snapshotCopiedAt: string;
  readonly snapshotEffectiveModelId: string;
}

export function matrixCampaignNotCapturedPointers(): MatrixCampaignSnapshotPointers {
  return {
    latestJson: MATRIX_ARTIFACT_NOT_CAPTURED,
    latestMd: MATRIX_ARTIFACT_NOT_CAPTURED,
    providerSmokeJson: MATRIX_ARTIFACT_NOT_CAPTURED,
    phase2ShadowJson: MATRIX_ARTIFACT_NOT_CAPTURED,
  };
}

export interface MatrixCampaignSnapshotSession {
  readonly track: LiveMatrixEvidenceTrack;
  readonly repoRoot: string;
  readonly safeModelId: string;
  readonly runIndex: number;
  readonly modelId: string;
  readonly evidenceSnapshotDir: string;
  readonly absSnapshotDir: string;
  readonly copiedFiles: Set<string>;
  readonly skippedArtifacts: MatrixSkippedArtifact[];
}

export function getMatrixCampaignSnapshotRelativeDir(
  track: LiveMatrixEvidenceTrack,
  safeModelId: string,
  runIndex: number,
): string {
  return `.rector/evidence/live/${track}/matrix/${safeModelId}/${runIndex}`;
}

export function getMatrixLiveEvidenceDir(track: LiveMatrixEvidenceTrack, repoRoot?: string): string {
  return track === "zai" ? getZaiLiveEvidenceDir(repoRoot) : getRegoloLiveEvidenceDir(repoRoot);
}

export function getMatrixLiveMatrixEvidenceDir(track: LiveMatrixEvidenceTrack, repoRoot?: string): string {
  return path.join(getMatrixLiveEvidenceDir(track, repoRoot), "matrix");
}

/** Clears the provider matrix tree so prior-run snapshot dirs cannot leak stale artifacts. */
export async function resetLiveMatrixEvidenceSnapshots(input: {
  readonly track: LiveMatrixEvidenceTrack;
  readonly repoRoot: string;
}): Promise<void> {
  const matrixDir = getMatrixLiveMatrixEvidenceDir(input.track, path.resolve(input.repoRoot));
  await fs.rm(matrixDir, { recursive: true, force: true });
}

export async function beginMatrixCampaignSnapshotSession(input: {
  readonly track: LiveMatrixEvidenceTrack;
  readonly repoRoot: string;
  readonly safeModelId: string;
  readonly runIndex: number;
  readonly modelId: string;
}): Promise<MatrixCampaignSnapshotSession> {
  const evidenceSnapshotDir = getMatrixCampaignSnapshotRelativeDir(
    input.track,
    input.safeModelId,
    input.runIndex,
  );
  const absSnapshotDir = path.join(
    getMatrixLiveMatrixEvidenceDir(input.track, input.repoRoot),
    input.safeModelId,
    String(input.runIndex),
  );
  await fs.rm(absSnapshotDir, { recursive: true, force: true });
  await fs.mkdir(absSnapshotDir, { recursive: true });
  return {
    track: input.track,
    repoRoot: path.resolve(input.repoRoot),
    safeModelId: input.safeModelId,
    runIndex: input.runIndex,
    modelId: input.modelId,
    evidenceSnapshotDir,
    absSnapshotDir,
    copiedFiles: new Set<string>(),
    skippedArtifacts: [],
  };
}

export async function copyMatrixCampaignArtifactsForStep(
  session: MatrixCampaignSnapshotSession,
  stepId: string,
): Promise<void> {
  const destNames = MATRIX_LIVE_STEP_ARTIFACT_DEST[stepId];
  if (!destNames?.length) return;
  await copyMatrixCampaignArtifactDestNames(session, destNames);
}

export async function finalizeMatrixCampaignSnapshot(
  session: MatrixCampaignSnapshotSession,
  options?: { readonly now?: () => Date },
): Promise<MatrixCampaignSnapshotResult> {
  const snapshotCopiedAt = (options?.now?.() ?? new Date()).toISOString();
  const validatedCopied = new Set<string>();
  const skippedArtifacts: MatrixSkippedArtifact[] = [...session.skippedArtifacts];

  for (const destName of [...session.copiedFiles].sort()) {
    const absDest = path.join(session.absSnapshotDir, destName);
    const valid = await validateSnapshotArtifactOnDisk(absDest, destName, session.modelId);
    if (valid) {
      validatedCopied.add(destName);
      continue;
    }
    try {
      await fs.rm(absDest, { force: true });
    } catch {
      // best-effort removal of stale or mismatched snapshot bytes
    }
    skippedArtifacts.push({
      destName,
      reason: "stale_or_model_mismatch_on_finalize",
    });
  }

  const prefix = `${session.evidenceSnapshotDir}/`;
  const reportPointers: MatrixCampaignSnapshotPointers = {
    latestJson: pointerForArtifact("latest.json", validatedCopied, prefix),
    latestMd: pointerForArtifact("latest.md", validatedCopied, prefix),
    providerSmokeJson: pointerForArtifact("provider-smoke.json", validatedCopied, prefix),
    phase2ShadowJson: pointerForArtifact("phase2-live-fact-shadow-report.json", validatedCopied, prefix),
  };

  const copiedFiles = MATRIX_SNAPSHOT_ARTIFACT_ORDER.filter((name) => validatedCopied.has(name));
  return {
    evidenceSnapshotDir: session.evidenceSnapshotDir,
    reportPointers,
    copiedFiles,
    skippedArtifacts,
    snapshotHealth: deriveSnapshotHealth(copiedFiles),
    snapshotCopiedAt,
    snapshotEffectiveModelId: session.modelId,
  };
}

/** @deprecated Prefer session-based incremental snapshots during matrix campaigns. */
export async function snapshotMatrixCampaignEvidenceLegacy(input: {
  readonly track: LiveMatrixEvidenceTrack;
  readonly repoRoot: string;
  readonly safeModelId: string;
  readonly runIndex: number;
  readonly modelId: string;
}): Promise<MatrixCampaignSnapshotResult> {
  const session = await beginMatrixCampaignSnapshotSession(input);
  await copyMatrixCampaignArtifactDestNames(session, [...MATRIX_SNAPSHOT_ARTIFACT_ORDER]);
  return finalizeMatrixCampaignSnapshot(session);
}

async function copyMatrixCampaignArtifactDestNames(
  session: MatrixCampaignSnapshotSession,
  destNames: readonly string[],
): Promise<void> {
  for (const destName of destNames) {
    const plan = resolveArtifactCopyPlan(session.track, session.repoRoot, destName);
    if (!plan) {
      session.skippedArtifacts.push({ destName, reason: "unknown_artifact" });
      continue;
    }
    try {
      const allowed = await artifactMatchesCampaignModel(plan.src, destName, session.modelId);
      if (!allowed) {
        session.skippedArtifacts.push({
          destName,
          reason: "model_mismatch_or_missing",
        });
        continue;
      }
      await fs.copyFile(plan.src, path.join(session.absSnapshotDir, destName));
      session.copiedFiles.add(destName);
    } catch {
      session.skippedArtifacts.push({ destName, reason: "source_missing" });
    }
  }
}

function resolveArtifactCopyPlan(
  track: LiveMatrixEvidenceTrack,
  repoRoot: string,
  destName: string,
): { readonly src: string } | undefined {
  switch (destName) {
    case "latest.json":
      return { src: path.join(getMatrixLiveEvidenceDir(track, repoRoot), "latest.json") };
    case "latest.md":
      return { src: path.join(getMatrixLiveEvidenceDir(track, repoRoot), "latest.md") };
    case "provider-smoke.json":
      return { src: path.join(getMatrixLiveEvidenceDir(track, repoRoot), "provider-smoke.json") };
    case "phase2-live-fact-shadow-report.json":
      return {
        src: path.join(getEvidenceTrackDir("phase2", repoRoot), "live-fact-shadow-report.json"),
      };
    default:
      return undefined;
  }
}

async function validateSnapshotArtifactOnDisk(
  absDest: string,
  destName: string,
  expectedModelId: string,
): Promise<boolean> {
  try {
    await fs.access(absDest);
  } catch {
    return false;
  }
  if (destName === "latest.md" || destName === "phase2-live-fact-shadow-report.json") {
    return true;
  }
  if (destName !== "latest.json" && destName !== "provider-smoke.json") {
    return true;
  }
  try {
    const raw = await fs.readFile(absDest, "utf8");
    const parsed = JSON.parse(raw) as { modelId?: string | null };
    if (typeof parsed.modelId !== "string" || !parsed.modelId.trim()) {
      return false;
    }
    return parsed.modelId === expectedModelId;
  } catch {
    return false;
  }
}

async function artifactMatchesCampaignModel(
  srcPath: string,
  destName: string,
  expectedModelId: string,
): Promise<boolean> {
  if (destName === "phase2-live-fact-shadow-report.json" || destName === "latest.md") {
    return true;
  }
  if (destName !== "latest.json" && destName !== "provider-smoke.json") {
    return true;
  }
  try {
    const raw = await fs.readFile(srcPath, "utf8");
    const parsed = JSON.parse(raw) as { modelId?: string | null };
    if (typeof parsed.modelId !== "string" || !parsed.modelId.trim()) {
      return false;
    }
    return parsed.modelId === expectedModelId;
  } catch {
    return false;
  }
}

function pointerForArtifact(
  destName: string,
  validatedCopied: ReadonlySet<string>,
  prefix: string,
): MatrixCampaignReportPointer {
  if (!validatedCopied.has(destName)) {
    return MATRIX_ARTIFACT_NOT_CAPTURED;
  }
  return `${prefix}${destName}`;
}

function deriveSnapshotHealth(copiedFiles: readonly string[]): MatrixSnapshotHealth {
  if (copiedFiles.length === 0) {
    return "empty";
  }
  if (copiedFiles.length === MATRIX_SNAPSHOT_ARTIFACT_ORDER.length) {
    return "complete";
  }
  return "partial";
}