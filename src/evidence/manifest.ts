import type { CampaignBudgetRollup } from "./campaignBudget";
import { RECTOR_EVIDENCE_DIR, type EvidenceTrack } from "./paths";
import { sanitizeEvidencePayload, sanitizeEvidenceStringLeaves } from "./sanitize";

export const EVIDENCE_MANIFEST_SCHEMA_VERSION = "rector.evidence-manifest.v1";

export const LIVE_EVIDENCE_STATUSES = ["skipped", "test_only_injected", "live_provider", "failed", "unknown"] as const;
export type LiveEvidenceStatus = (typeof LIVE_EVIDENCE_STATUSES)[number];

export interface EvidenceTrackPointer {
  directory: string;
  latestJson?: string;
  latestMarkdown?: string;
  indexJson?: string;
}

export type EvidenceManifestTracks = Record<EvidenceTrack, EvidenceTrackPointer>;

export interface EvidenceManifest {
  schemaVersion: typeof EVIDENCE_MANIFEST_SCHEMA_VERSION;
  generatedAt: string;
  repoRef?: string;
  tracks: EvidenceManifestTracks;
  liveEvidenceStatus?: LiveEvidenceStatus;
  secretScanPassedAt?: string;
  campaignBudget?: CampaignBudgetRollup;
}

export interface BuildEvidenceManifestOptions {
  now?: () => Date;
  generatedAt?: string | Date;
  repoRef?: string;
  tracks?: Partial<Record<EvidenceTrack, EvidenceTrackPointer>>;
  liveEvidenceStatus?: LiveEvidenceStatus;
  secretScanPassedAt?: string | Date;
  campaignBudget?: CampaignBudgetRollup;
}

export function defaultEvidenceTrackPointers(evidenceDir = RECTOR_EVIDENCE_DIR): EvidenceManifestTracks {
  return {
    phase0: reportPointers(evidenceDir, "phase0", "latest"),
    "phase0.5": reportPointers(evidenceDir, "phase0.5", "latest"),
    phase1: reportPointers(evidenceDir, "phase1", "latest"),
    phase2: reportPointers(evidenceDir, "phase2", "fact-report"),
    "live/zai": {
      directory: pointer(evidenceDir, "live", "zai"),
      latestJson: pointer(evidenceDir, "live", "zai", "latest.json"),
      latestMarkdown: pointer(evidenceDir, "live", "zai", "latest.md"),
      indexJson: pointer(evidenceDir, "live", "zai", "index.json"),
    },
    global: reportPointers(evidenceDir, "global", "global-report"),
    capabilities: reportPointers(evidenceDir, "capabilities", "eval-report"),
  };
}

export function buildEvidenceManifest(options: BuildEvidenceManifestOptions = {}): EvidenceManifest {
  const tracks: EvidenceManifestTracks = {
    ...defaultEvidenceTrackPointers(),
    ...options.tracks,
  };
  const manifest: EvidenceManifest = {
    schemaVersion: EVIDENCE_MANIFEST_SCHEMA_VERSION,
    generatedAt: timestamp(options.generatedAt, options.now),
    ...(options.repoRef !== undefined ? { repoRef: sanitizeString(options.repoRef) } : {}),
    tracks: sanitizeTrackPointers(tracks),
    ...(options.liveEvidenceStatus !== undefined ? { liveEvidenceStatus: options.liveEvidenceStatus } : {}),
    ...(options.secretScanPassedAt !== undefined
      ? { secretScanPassedAt: sanitizeString(timestamp(options.secretScanPassedAt)) }
      : {}),
    ...(options.campaignBudget !== undefined
      ? { campaignBudget: sanitizeCampaignBudget(options.campaignBudget) }
      : {}),
  };

  return manifest;
}

function sanitizeCampaignBudget(rollup: CampaignBudgetRollup): CampaignBudgetRollup {
  return sanitizeEvidenceStringLeaves(rollup);
}

function reportPointers(evidenceDir: string, track: string, basename: string): EvidenceTrackPointer {
  return {
    directory: pointer(evidenceDir, track),
    latestJson: pointer(evidenceDir, track, `${basename}.json`),
    latestMarkdown: pointer(evidenceDir, track, `${basename}.md`),
  };
}

function pointer(...segments: string[]): string {
  return segments.join("/").replace(/\/+/g, "/");
}

function sanitizeTrackPointers(tracks: EvidenceManifestTracks): EvidenceManifestTracks {
  return Object.fromEntries(
    Object.entries(tracks).map(([track, trackPointer]) => [
      track,
      {
        directory: sanitizeString(trackPointer.directory),
        ...(trackPointer.latestJson !== undefined ? { latestJson: sanitizeString(trackPointer.latestJson) } : {}),
        ...(trackPointer.latestMarkdown !== undefined ? { latestMarkdown: sanitizeString(trackPointer.latestMarkdown) } : {}),
        ...(trackPointer.indexJson !== undefined ? { indexJson: sanitizeString(trackPointer.indexJson) } : {}),
      },
    ]),
  ) as EvidenceManifestTracks;
}

function sanitizeString(value: string): string {
  return sanitizeEvidencePayload({ value }).value;
}

function timestamp(value?: string | Date, now?: () => Date): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return (now?.() ?? new Date()).toISOString();
}
