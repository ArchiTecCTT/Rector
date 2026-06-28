import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createAzureBlobUploadClient,
  resolveEvidenceSyncConfig,
  syncEvidenceToBlob,
} from "../../src/azure/evidenceSync.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

async function main(): Promise<void> {
  const config = resolveEvidenceSyncConfig(process.env);
  if (!config) {
    process.stdout.write("[evidence:sync] skipped (RECTOR_EVIDENCE_SYNC is off)\n");
    return;
  }

  const evidenceDir = path.isAbsolute(config.evidenceDir)
    ? config.evidenceDir
    : path.join(REPO_ROOT, config.evidenceDir);

  const client = await createAzureBlobUploadClient(config.accountName, config.containerName);
  const uploaded = await syncEvidenceToBlob({ ...config, evidenceDir }, client);

  process.stdout.write(
    [
      "[evidence:sync] uploaded to Azure Blob.",
      `  account: ${config.accountName}`,
      `  container: ${config.containerName}`,
      `  prefix: ${config.blobPrefix}`,
      `  files: ${uploaded.length}`,
      ...uploaded.map((file) => `    - ${file.blobPath}`),
    ].join("\n") + "\n",
  );
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return fileURLToPath(import.meta.url) === path.resolve(entry);
}

if (isMain()) {
  main().catch((error: unknown) => {
    process.stderr.write(`[evidence:sync] FAILED: ${String(error)}\n`);
    process.exitCode = 1;
  });
}