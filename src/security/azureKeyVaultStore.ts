import type { SecretStore, SecretStoreResult } from "./secretStore";
import { redactString } from "./redaction";

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
  setSecret(name: string, value: string): Promise<unknown>;
  listPropertiesOfSecrets(): AsyncIterable<{ name?: string }>;
};

function defaultSecretName(providerId: string): string {
  return PROVIDER_SECRET_NAME[providerId] ?? `${providerId}-api-key`;
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
      clientPromise = (async () => {
        const { SecretClient } = await import("@azure/keyvault-secrets");
        const { DefaultAzureCredential } = await import("@azure/identity");
        return new SecretClient(vaultUrl, new DefaultAzureCredential()) as KeyVaultSecretClient;
      })();
    }
    return clientPromise;
  }

  return {
    async setSecret(providerId: string, value: string): Promise<SecretStoreResult<void>> {
      try {
        const client = await getClient();
        await client.setSecret(secretNameFor(providerId), value);
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
          const providerId = Object.entries(PROVIDER_SECRET_NAME).find(([, name]) => name === props.name)?.[0]
            ?? props.name.replace(/-api-key$/, "");
          ids.push(providerId);
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