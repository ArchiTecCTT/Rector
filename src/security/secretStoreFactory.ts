import { createAzureKeyVaultSecretStore } from "./azureKeyVaultStore";
import { createLocalSecretStore, type LocalSecretStoreOptions, type SecretStore } from "./secretStore";

export const SECRET_STORE_BACKINGS = ["local", "azure-key-vault"] as const;
export type SecretStoreBacking = (typeof SECRET_STORE_BACKINGS)[number];

export function resolveSecretStoreBacking(raw: string | undefined): SecretStoreBacking {
  if (raw === "azure-key-vault") return "azure-key-vault";
  return "local";
}

/**
 * Key rotation re-encrypts secrets into the local `.rector/secrets.enc` file.
 * Refuse when secrets are backed by Azure Key Vault so cloud-managed values are not copied to disk.
 */
export function assertKeyRotationAllowed(env: NodeJS.ProcessEnv = process.env): void {
  if (resolveSecretStoreBacking(env.RECTOR_SECRET_STORE) === "azure-key-vault") {
    throw new Error(
      "RECTOR_ROTATE_KEY_ON_BOOT is not supported when RECTOR_SECRET_STORE=azure-key-vault: "
      + "cloud-managed secrets must not be copied to the local .rector/secrets.enc file.",
    );
  }
}

export interface CreateSecretStoreFromEnvOptions {
  local: LocalSecretStoreOptions;
  env?: NodeJS.ProcessEnv;
}

export function createSecretStoreFromEnv(options: CreateSecretStoreFromEnvOptions): SecretStore {
  const env = options.env ?? process.env;
  const backing = resolveSecretStoreBacking(env.RECTOR_SECRET_STORE);
  if (backing === "azure-key-vault") {
    const vaultUrl = env.AZURE_KEY_VAULT_URL?.trim();
    if (!vaultUrl) {
      throw new Error("RECTOR_SECRET_STORE=azure-key-vault requires AZURE_KEY_VAULT_URL.");
    }
    return createAzureKeyVaultSecretStore({ vaultUrl });
  }
  return createLocalSecretStore(options.local);
}