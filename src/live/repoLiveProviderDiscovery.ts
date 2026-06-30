import { existsSync, readFileSync } from "node:fs";
import { randomBytes, scryptSync } from "node:crypto";
import path from "node:path";

import { createLocalRuntimeSettingsStore } from "../config/runtimeSettings";
import { createLocalProviderConfigStore } from "../providers/configStore";
import { getRectorLocalDir } from "../evidence/paths";
import { createSecretStoreFromEnv } from "../security/secretStoreFactory";
import {
  discoverLiveProvider,
  type LiveProviderDiscoveryOptions,
  type LiveProviderDiscoveryResult,
} from "./liveProviderDiscovery";

interface SecretKeyFileV2 {
  key?: string;
  version?: string;
}

/**
 * Build discovery options that include repo-local configured-product stores
 * (runtime settings, provider config, secrets) in addition to env overrides.
 */
export function buildRepoLiveProviderDiscoveryOptions(
  repoRoot?: string,
  env: Record<string, string | undefined> = process.env,
): LiveProviderDiscoveryOptions {
  const rectorDir = getRectorLocalDir(repoRoot);
  const encryptionKey = resolveRepoSecretEncryptionKey(rectorDir, env);
  return {
    env,
    runtimeSettingsStore: createLocalRuntimeSettingsStore({
      filePath: path.join(rectorDir, "runtime-settings.json"),
    }),
    providerConfigStore: createLocalProviderConfigStore({
      filePath: path.join(rectorDir, "providers.json"),
    }),
    secretStore: createSecretStoreFromEnv({
      env,
      local: {
        filePath: path.join(rectorDir, "secrets.enc"),
        encryptionKey,
      },
    }),
  };
}

export async function discoverLiveProviderFromRepo(
  repoRoot?: string,
  env: Record<string, string | undefined> = process.env,
): Promise<LiveProviderDiscoveryResult> {
  return discoverLiveProvider(buildRepoLiveProviderDiscoveryOptions(repoRoot, env));
}

function resolveRepoSecretEncryptionKey(
  rectorDir: string,
  env: Record<string, string | undefined>,
): Buffer {
  const envKey = env.RECTOR_SECRET_KEY?.trim();
  if (envKey) {
    return scryptSync(envKey, "rector.secret-store.v1", 32);
  }

  const keyFile = path.join(rectorDir, "secret.key");
  try {
    if (existsSync(keyFile)) {
      const stored = readFileSync(keyFile, "utf8").trim();
      try {
        const parsed = JSON.parse(stored) as SecretKeyFileV2;
        if (parsed.version === "v2" && typeof parsed.key === "string") {
          const key = Buffer.from(parsed.key, "hex");
          if (key.length === 32) return key;
        }
      } catch {
        // fall through to v1 hex
      }
      if (/^[0-9a-f]{64}$/i.test(stored)) {
        const key = Buffer.from(stored, "hex");
        if (key.length === 32) return key;
      }
    }
  } catch {
    // unreadable key file — fall through
  }

  // Ephemeral key for read-only discovery when the store is empty or unused.
  return randomBytes(32);
}