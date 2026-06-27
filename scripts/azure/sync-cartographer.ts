import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createCartographerBlobClient,
  resolveCartographerSyncConfig,
  syncCartographerToBlob,
} from "../../src/azure/cartographerSync.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

async function main(): Promise<void> {
  const config = resolveCartographerSyncConfig(process.env);
  if (!config) {
    process.stdout.write("[cartographer:sync] skipped (AZURE_STORAGE_ACCOUNT_NAME not set)\n");
    return;
  }

  const cartographerDir = path.isAbsolute(config.cartographerDir)
    ? config.cartographerDir
    : path.join(REPO_ROOT, config.cartographerDir);

  const client = await createCartographerBlobClient(config);
  const uploaded = await syncCartographerToBlob({ ...config, cartographerDir }, client);

  process.stdout.write(
    [
      "[cartographer:sync] uploaded to Azure Blob.",
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
    process.stderr.write(`[cartographer:sync] FAILED: ${String(error)}\n`);
    process.exitCode = 1;
  });
}