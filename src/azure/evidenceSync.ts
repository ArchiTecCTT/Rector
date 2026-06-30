import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { LEGACY_OMO_EVIDENCE_DIR, RECTOR_EVIDENCE_DIR } from "../evidence";

export const DEFAULT_EVIDENCE_DIR = RECTOR_EVIDENCE_DIR;

export const EVIDENCE_SYNC_MODES = ["off", "azure-blob"] as const;
export type EvidenceSyncMode = (typeof EVIDENCE_SYNC_MODES)[number];

export interface EvidenceSyncConfig {
  mode: EvidenceSyncMode;
  accountName: string;
  containerName: string;
  evidenceDir: string;
  blobPrefix: string;
}

export interface EvidenceSyncFile {
  localPath: string;
  blobPath: string;
}

export interface BlobUploadClient {
  upload(localPath: string, blobPath: string): Promise<void>;
}

const REPORT_FILES = new Set([
  "eval-report.json",
  "eval-report.md",
  "global-report.json",
  "global-report.md",
  "scorecard-audit.md",
  "phase0-baseline.json",
  "phase0-baseline.md",
  "fact-report.json",
  "fact-report.md",
  "live-fact-shadow-report.json",
  "live-fact-shadow-report.md",
  "live-fact-shadow-summary.json",
]);

const PROOF_ARTIFACT_DIRS = new Set([
  "raw-artifacts",
  "regressions",
  "live-fact-shadow-artifacts",
]);

const SAFE_PROOF_EXTENSIONS = new Set([".json", ".md", ".txt", ".log"]);

const FORBIDDEN_RECTOR_RUNTIME_FILES = new Set([
  "providers.json",
  "secrets.enc",
  "runtime-settings.json",
  "orchestration-assignments.json",
  "memory-assignments.json",
  "rector.db",
  "audit-events.jsonl",
]);

export function resolveEvidenceSyncMode(raw: string | undefined): EvidenceSyncMode {
  if (raw === "azure-blob") return "azure-blob";
  return "off";
}

export function resolveBackupContainerName(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return (
    env.AZURE_STORAGE_CONTAINER_BACKUPS
    ?? env.AZURE_STORAGE_CONTAINER_RECTOR_BACKUPDS
    ?? undefined
  );
}

export function resolveEvidenceSyncConfig(env: NodeJS.ProcessEnv = process.env): EvidenceSyncConfig | null {
  const mode = resolveEvidenceSyncMode(env.RECTOR_EVIDENCE_SYNC);
  if (mode === "off") return null;

  const accountName = env.AZURE_STORAGE_ACCOUNT_NAME?.trim();
  const containerName = env.AZURE_STORAGE_CONTAINER_HARNESS?.trim() ?? "harness-evidence";
  if (!accountName) {
    throw new Error("RECTOR_EVIDENCE_SYNC=azure-blob requires AZURE_STORAGE_ACCOUNT_NAME.");
  }

  const evidenceDir = env.RECTOR_EVIDENCE_DIR?.trim() || DEFAULT_EVIDENCE_DIR;
  const date = env.RECTOR_EVIDENCE_SYNC_DATE?.trim() || new Date().toISOString().slice(0, 10);
  const runId = env.RECTOR_EVIDENCE_SYNC_RUN_ID?.trim() || new Date().toISOString().replace(/[:.]/g, "-");
  const blobPrefix = `${date}/${runId}`;

  return { mode, accountName, containerName, evidenceDir, blobPrefix };
}

export async function collectEvidenceFiles(evidenceDir: string): Promise<EvidenceSyncFile[]> {
  const absDir = path.resolve(evidenceDir);
  const { rootDir, blobPrefix } = evidenceTraversalRoot(absDir);
  let entries: string[];
  try {
    entries = await readdir(rootDir);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? (error as NodeJS.ErrnoException).code
      : undefined;
    if (code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const files: EvidenceSyncFile[] = [];

  await collectEvidenceFilesRecursive({
    dir: rootDir,
    relBase: blobPrefix,
    initialEntries: entries,
    files,
  });

  return files.sort((a, b) => a.blobPath.localeCompare(b.blobPath));
}

export async function syncEvidenceToBlob(
  config: EvidenceSyncConfig,
  client: BlobUploadClient,
): Promise<EvidenceSyncFile[]> {
  const files = await collectEvidenceFiles(config.evidenceDir);
  const fallbackFiles = files.length > 0 ? files : await collectLegacyEvidenceFiles(config.evidenceDir);
  const filesToUpload = fallbackFiles.length > 0 ? fallbackFiles : files;
  for (const file of filesToUpload) {
    const destination = `${config.blobPrefix}/${file.blobPath}`;
    await client.upload(file.localPath, destination);
  }
  return filesToUpload;
}

async function collectLegacyEvidenceFiles(evidenceDir: string): Promise<EvidenceSyncFile[]> {
  const absDir = path.resolve(evidenceDir);
  const normalizedDefault = path.normalize(RECTOR_EVIDENCE_DIR);
  const normalizedInput = path.normalize(evidenceDir);
  const isDefaultEvidenceDir =
    normalizedInput === normalizedDefault ||
    (path.basename(absDir) === "evidence" && path.basename(path.dirname(absDir)) === ".rector");
  if (!isDefaultEvidenceDir) return [];
  const legacyDir = path.resolve(path.dirname(path.dirname(absDir)), LEGACY_OMO_EVIDENCE_DIR);
  return collectEvidenceFiles(legacyDir);
}

async function collectEvidenceFilesRecursive(input: {
  readonly dir: string;
  readonly relBase: string;
  readonly initialEntries?: readonly string[];
  readonly files: EvidenceSyncFile[];
}): Promise<void> {
  const entries = input.initialEntries ?? await readdir(input.dir);
  for (const name of entries) {
    if (FORBIDDEN_RECTOR_RUNTIME_FILES.has(name)) continue;
    const localPath = path.join(input.dir, name);
    const info = await stat(localPath);
    const blobPath = path.posix.join(input.relBase, name.replace(/\\/g, "/"));
    if (info.isDirectory()) {
      await collectEvidenceFilesRecursive({ dir: localPath, relBase: blobPath, files: input.files });
      continue;
    }
    if (!info.isFile() || !isUploadableEvidenceBlob(blobPath)) continue;
    input.files.push({ localPath, blobPath });
  }
}

function evidenceTraversalRoot(absDir: string): { rootDir: string; blobPrefix: string } {
  if (path.basename(absDir) === ".rector") {
    return { rootDir: path.join(absDir, "evidence"), blobPrefix: "evidence" };
  }
  return { rootDir: absDir, blobPrefix: "" };
}

function isUploadableEvidenceBlob(blobPath: string): boolean {
  const normalized = blobPath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  const basename = segments[segments.length - 1] ?? "";
  if (FORBIDDEN_RECTOR_RUNTIME_FILES.has(basename)) return false;
  if (REPORT_FILES.has(basename)) return true;
  if (basename.endsWith(".metadata.json")) return true;
  if (!segments.some((segment) => PROOF_ARTIFACT_DIRS.has(segment))) return false;
  return SAFE_PROOF_EXTENSIONS.has(path.extname(basename));
}

/** Factory for a real Azure Blob client using DefaultAzureCredential. */
export async function createAzureBlobUploadClient(
  accountName: string,
  containerName: string,
): Promise<BlobUploadClient> {
  const { BlobServiceClient } = await import("@azure/storage-blob");
  const { DefaultAzureCredential } = await import("@azure/identity");
  const credential = new DefaultAzureCredential();
  const service = new BlobServiceClient(`https://${accountName}.blob.core.windows.net`, credential);
  const container = service.getContainerClient(containerName);

  return {
    async upload(localPath: string, blobPath: string): Promise<void> {
      const block = container.getBlockBlobClient(blobPath);
      await block.uploadStream(createReadStream(localPath));
    },
  };
}
