import path from "node:path";

import { syncCartographerToBlob, resolveCartographerSyncConfig, collectCartographerFiles } from "./cartographerSync.js";
import {
  createAzureBlobUploadClient,
  resolveEvidenceSyncConfig,
  syncEvidenceToBlob,
  collectEvidenceFiles,
} from "./evidenceSync.js";
import { emitAzureDailyTouchTelemetry } from "../observability/appInsightsAdapter.js";

export interface DailyTouchStepResult {
  id: string;
  status: "ok" | "skipped" | "error";
  detail: string;
}

export interface DailyTouchResult {
  steps: DailyTouchStepResult[];
  ok: boolean;
}

export interface DailyTouchOptions {
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
}

async function touchKeyVault(vaultUrl: string): Promise<DailyTouchStepResult> {
  try {
    const { SecretClient } = await import("@azure/keyvault-secrets");
    const { DefaultAzureCredential } = await import("@azure/identity");
    const client = new SecretClient(vaultUrl.replace(/\/$/, ""), new DefaultAzureCredential());
    let count = 0;
    for await (const _props of client.listPropertiesOfSecrets()) {
      count += 1;
    }
    return { id: "keyvault", status: "ok", detail: `listed ${count} secret(s)` };
  } catch (error) {
    return { id: "keyvault", status: "error", detail: error instanceof Error ? error.message : String(error) };
  }
}

async function touchBlobHarness(repoRoot: string, env: NodeJS.ProcessEnv): Promise<DailyTouchStepResult> {
  const config = resolveEvidenceSyncConfig({ ...env, RECTOR_EVIDENCE_SYNC: "azure-blob" });
  if (!config) {
    return { id: "blob-harness", status: "skipped", detail: "AZURE_STORAGE_ACCOUNT_NAME not set" };
  }
  const evidenceDir = path.isAbsolute(config.evidenceDir)
    ? config.evidenceDir
    : path.join(repoRoot, config.evidenceDir);
  const pending = await collectEvidenceFiles(evidenceDir);
  if (pending.length === 0) {
    return { id: "blob-harness", status: "skipped", detail: "no harness reports in .omo/evidence" };
  }
  try {
    const client = await createAzureBlobUploadClient(config.accountName, config.containerName);
    const uploaded = await syncEvidenceToBlob({ ...config, evidenceDir }, client);
    return { id: "blob-harness", status: "ok", detail: `uploaded ${uploaded.length} file(s) to ${config.containerName}/${config.blobPrefix}` };
  } catch (error) {
    return { id: "blob-harness", status: "error", detail: error instanceof Error ? error.message : String(error) };
  }
}

async function touchBlobCartographer(repoRoot: string, env: NodeJS.ProcessEnv): Promise<DailyTouchStepResult> {
  const config = resolveCartographerSyncConfig(env);
  if (!config) {
    return { id: "blob-cartographer", status: "skipped", detail: "AZURE_STORAGE_ACCOUNT_NAME not set" };
  }
  const cartographerDir = path.isAbsolute(config.cartographerDir)
    ? config.cartographerDir
    : path.join(repoRoot, config.cartographerDir);
  const pending = await collectCartographerFiles(cartographerDir);
  if (pending.length === 0) {
    return {
      id: "blob-cartographer",
      status: "skipped",
      detail: "no cartographer artifacts — run npm run cartographer:self-scan first",
    };
  }
  try {
    const client = await createAzureBlobUploadClient(config.accountName, config.containerName);
    const uploaded = await syncCartographerToBlob({ ...config, cartographerDir }, client);
    return {
      id: "blob-cartographer",
      status: "ok",
      detail: `uploaded ${uploaded.length} file(s) to ${config.containerName}/${config.blobPrefix}`,
    };
  } catch (error) {
    return { id: "blob-cartographer", status: "error", detail: error instanceof Error ? error.message : String(error) };
  }
}

function touchAppInsights(env: NodeJS.ProcessEnv, steps: DailyTouchStepResult[]): DailyTouchStepResult {
  const connectionString = env.APPLICATIONINSIGHTS_CONNECTION_STRING?.trim();
  if (!connectionString) {
    return { id: "appinsights", status: "skipped", detail: "APPLICATIONINSIGHTS_CONNECTION_STRING not set" };
  }
  emitAzureDailyTouchTelemetry({
    steps: steps.map((step) => `${step.id}:${step.status}`).join(","),
    ok: steps.every((step) => step.status !== "error"),
  });
  return { id: "appinsights", status: "ok", detail: "heartbeat event emitted" };
}

/**
 * One-shot Azure daily ritual: Key Vault list, Blob uploads (harness + cartographer), App Insights heartbeat.
 * VM + Foundry usage happen outside this script during Grok Build sessions.
 */
export async function runDailyTouch(options: DailyTouchOptions): Promise<DailyTouchResult> {
  const env = options.env ?? process.env;
  const steps: DailyTouchStepResult[] = [];

  const vaultUrl = env.AZURE_KEY_VAULT_URL?.trim();
  if (vaultUrl) {
    steps.push(await touchKeyVault(vaultUrl));
  } else {
    steps.push({ id: "keyvault", status: "skipped", detail: "AZURE_KEY_VAULT_URL not set" });
  }

  steps.push(await touchBlobHarness(options.repoRoot, env));
  steps.push(await touchBlobCartographer(options.repoRoot, env));

  const insightsStep = touchAppInsights(env, steps);
  steps.push(insightsStep);

  const ok = steps.every((step) => step.status !== "error");
  return { steps, ok };
}