import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_EVIDENCE_DIR = ".omo/evidence";

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
  const entries = await readdir(absDir);
  const files: EvidenceSyncFile[] = [];

  for (const name of entries) {
    if (!REPORT_FILES.has(name)) continue;
    const localPath = path.join(absDir, name);
    const info = await stat(localPath);
    if (!info.isFile()) continue;
    files.push({ localPath, blobPath: name });
  }

  return files.sort((a, b) => a.blobPath.localeCompare(b.blobPath));
}

export async function syncEvidenceToBlob(
  config: EvidenceSyncConfig,
  client: BlobUploadClient,
): Promise<EvidenceSyncFile[]> {
  const files = await collectEvidenceFiles(config.evidenceDir);
  for (const file of files) {
    const destination = `${config.blobPrefix}/${file.blobPath}`;
    await client.upload(file.localPath, destination);
  }
  return files;
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