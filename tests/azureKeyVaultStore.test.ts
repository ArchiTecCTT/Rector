import { describe, it, expect, vi, beforeEach } from "vitest";

const secretStore = new Map<string, string>();

vi.mock("@azure/keyvault-secrets", () => {
  class SecretClient {
    async getSecret(name: string): Promise<{ value?: string }> {
      return { value: secretStore.get(name) };
    }

    async setSecret(name: string, value: string): Promise<void> {
      secretStore.set(name, value);
    }

    async *listPropertiesOfSecrets(): AsyncIterable<{ name?: string }> {
      for (const name of secretStore.keys()) {
        yield { name };
      }
    }

    async beginDeleteSecret(name: string): Promise<{ pollUntilDone(): Promise<void> }> {
      return {
        async pollUntilDone(): Promise<void> {
          secretStore.delete(name);
        },
      };
    }
  }

  return { SecretClient };
});

vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: class DefaultAzureCredential {},
}));

import { createAzureKeyVaultSecretStore } from "../src/security/azureKeyVaultStore.js";

describe("createAzureKeyVaultSecretStore", () => {
  beforeEach(() => {
    secretStore.clear();
  });

  it("maps azure-openai provider id to azure-openai-api-key secret", async () => {
    secretStore.set("azure-openai-api-key", "test-key");
    const store = createAzureKeyVaultSecretStore({ vaultUrl: "https://kv-rector-dev.vault.azure.net/" });

    const result = await store.getSecret("azure-openai");
    expect(result).toEqual({ ok: true, value: "test-key" });
  });

  it("returns redacted error when secret is absent", async () => {
    const store = createAzureKeyVaultSecretStore({ vaultUrl: "https://kv-rector-dev.vault.azure.net/" });
    const result = await store.getSecret("azure-openai");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("absent");
    }
  });

  it("writes secrets using provider mapping", async () => {
    const store = createAzureKeyVaultSecretStore({ vaultUrl: "https://kv-rector-dev.vault.azure.net/" });
    const setResult = await store.setSecret("azure-openai", "fresh-key");
    expect(setResult.ok).toBe(true);
    expect(secretStore.get("azure-openai-api-key")).toBe("fresh-key");
  });
});