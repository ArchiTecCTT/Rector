import { createHash } from "node:crypto";
import type { SecretStore, SecretStoreResult } from "./secretStore";
import { redactString } from "./redaction";

/** Tag key storing the original Rector secret ref on Key Vault secrets (hashed names are not reversible). */
export const RECTOR_SECRET_REF_TAG = "rectorSecretRef";

const KEY_VAULT_SECRET_NAME_MAX_LEN = 127;
const KEY_VAULT_SECRET_NAME_PATTERN = /^[0-9a-zA-Z-]+$/;

const PROVIDER_SECRET_NAME: Record<string, string> = {
  "azure-openai": "azure-openai-api-key",
  github: "github-pat",
};

export interface AzureKeyVaultStoreOptions {
  vaultUrl: string;
  secretNameForProvider?: (providerId: string) => string;
}

type KeyVaultSecretClient = {
  getSecret(name: string): Promise<{ value?: string }>;
  setSecret(name: string, value: string, options?: { tags?: Record<string, string> }): Promise<unknown>;
  listPropertiesOfSecrets(): AsyncIterable<{ name?: string; tags?: Record<string, string> }>;
};

/**
 * Map a Rector secret ref (provider id, memory ref, etc.) to an Azure Key Vault secret name.
 * Key Vault allows only alphanumerics and hyphens (1–127 chars).
 */
export function secretRefToKeyVaultSecretName(secretRef: string): string {
  const mapped = PROVIDER_SECRET_NAME[secretRef];
  if (mapped) return mapped;

  const legacy = `${secretRef}-api-key`;
  if (
    legacy.length <= KEY_VAULT_SECRET_NAME_MAX_LEN
    && KEY_VAULT_SECRET_NAME_PATTERN.test(legacy)
  ) {
    return legacy;
  }

  const digest = createHash("sha256").update(secretRef, "utf8").digest("hex");
  return `rector-${digest}`;
}

function defaultSecretName(providerId: string): string {
  return secretRefToKeyVaultSecretName(providerId);
}

function toRedactedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactString(message);
}

export function createAzureKeyVaultSecretStore(options: AzureKeyVaultStoreOptions): SecretStore {
  const vaultUrl = options.vaultUrl.replace(/\/$/, "");
  const secretNameFor = options.secretNameForProvider ?? defaultSecretName;
  let clientPromise: Promise<KeyVaultSecretClient> | undefined;

  async function getClient(): Promise<KeyVaultSecretClient> {
    if (!clientPromise) {
      const pending = (async () => {
        const { SecretClient } = await import("@azure/keyvault-secrets");
        const { DefaultAzureCredential } = await import("@azure/identity");
        return new SecretClient(vaultUrl, new DefaultAzureCredential()) as KeyVaultSecretClient;
      })();
      clientPromise = pending;
      pending.catch(() => {
        clientPromise = undefined;
      });
    }
    return clientPromise;
  }

  return {
    async setSecret(providerId: string, value: string): Promise<SecretStoreResult<void>> {
      try {
        const client = await getClient();
        await client.setSecret(secretNameFor(providerId), value, {
          tags: { [RECTOR_SECRET_REF_TAG]: providerId },
        });
        return { ok: true, value: undefined };
      } catch (error) {
        return { ok: false, error: toRedactedError(error) };
      }
    },

    async getSecret(providerId: string): Promise<SecretStoreResult<string>> {
      try {
        const client = await getClient();
        const secret = await client.getSecret(secretNameFor(providerId));
        if (!secret.value) {
          return { ok: false, error: `Secret for provider "${providerId}" is absent.` };
        }
        return { ok: true, value: secret.value };
      } catch (error) {
        return { ok: false, error: toRedactedError(error) };
      }
    },

    async hasSecret(providerId: string): Promise<boolean> {
      const result = await this.getSecret(providerId);
      return result.ok;
    },

    async listSecretIds(): Promise<string[]> {
      try {
        const client = await getClient();
        const ids: string[] = [];
        for await (const props of client.listPropertiesOfSecrets()) {
          if (!props.name) continue;
          const taggedRef = props.tags?.[RECTOR_SECRET_REF_TAG];
          if (taggedRef) {
            ids.push(taggedRef);
            continue;
          }
          const fromMap = Object.entries(PROVIDER_SECRET_NAME).find(([, name]) => name === props.name)?.[0];
          if (fromMap) {
            ids.push(fromMap);
            continue;
          }
          if (/^rector-[0-9a-f]{64}$/.test(props.name)) {
            continue;
          }
          if (props.name.endsWith("-api-key")) {
            ids.push(props.name.slice(0, -"-api-key".length));
          }
        }
        return [...new Set(ids)].sort();
      } catch {
        return [];
      }
    },

    async deleteSecret(providerId: string): Promise<SecretStoreResult<void>> {
      try {
        const client = await getClient() as KeyVaultSecretClient & {
          beginDeleteSecret(name: string): Promise<{ pollUntilDone(): Promise<unknown> }>;
        };
        const poller = await client.beginDeleteSecret(secretNameFor(providerId));
        await poller.pollUntilDone();
        return { ok: true, value: undefined };
      } catch (error) {
        return { ok: false, error: toRedactedError(error) };
      }
    },
  };
}