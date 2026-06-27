import { stat } from "node:fs/promises";
import path from "node:path";

import { createAzureBlobUploadClient, type BlobUploadClient } from "./evidenceSync.js";

export const DEFAULT_CARTOGRAPHER_DIR = ".rector/cartographer";

export const CARTOGRAPHER_ARTIFACT_NAMES = [
  "latest-snapshot.json",
  "latest-files.json",
  "scan-report.md",
] as const;

export interface CartographerSyncConfig {
  accountName: string;
  containerName: string;
  cartographerDir: string;
  blobPrefix: string;
}

export interface CartographerSyncFile {
  localPath: string;
  blobPath: string;
}

export function resolveCartographerSyncConfig(env: NodeJS.ProcessEnv = process.env): CartographerSyncConfig | null {
  const accountName = env.AZURE_STORAGE_ACCOUNT_NAME?.trim();
  const containerName = env.AZURE_STORAGE_CONTAINER_CARTOGRAPHER?.trim() ?? "cartographer";
  if (!accountName) return null;

  const cartographerDir = env.RECTOR_CARTOGRAPHER_DIR?.trim() || DEFAULT_CARTOGRAPHER_DIR;
  const date = env.RECTOR_EVIDENCE_SYNC_DATE?.trim() || new Date().toISOString().slice(0, 10);
  const runId = env.RECTOR_EVIDENCE_SYNC_RUN_ID?.trim() || new Date().toISOString().replace(/[:.]/g, "-");
  const blobPrefix = `${date}/${runId}`;

  return { accountName, containerName, cartographerDir, blobPrefix };
}

export async function collectCartographerFiles(cartographerDir: string): Promise<CartographerSyncFile[]> {
  const absDir = path.resolve(cartographerDir);
  const files: CartographerSyncFile[] = [];

  for (const name of CARTOGRAPHER_ARTIFACT_NAMES) {
    const localPath = path.join(absDir, name);
    try {
      const info = await stat(localPath);
      if (!info.isFile()) continue;
      files.push({ localPath, blobPath: name });
    } catch {
      continue;
    }
  }

  return files;
}

export async function syncCartographerToBlob(
  config: CartographerSyncConfig,
  client: BlobUploadClient,
): Promise<CartographerSyncFile[]> {
  const files = await collectCartographerFiles(config.cartographerDir);
  for (const file of files) {
    await client.upload(file.localPath, `${config.blobPrefix}/${file.blobPath}`);
  }
  return files;
}

export async function createCartographerBlobClient(config: CartographerSyncConfig): Promise<BlobUploadClient> {
  return createAzureBlobUploadClient(config.accountName, config.containerName);
}