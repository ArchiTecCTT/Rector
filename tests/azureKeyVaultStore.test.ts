import { describe, it, expect, vi, beforeEach } from "vitest";

const secretStore = new Map<string, string>();
const secretTags = new Map<string, Record<string, string>>();
let failKeyVaultClientInitOnce = false;
let secretClientConstructAttempts = 0;

vi.mock("@azure/keyvault-secrets", () => {
  class SecretClient {
    constructor() {
      secretClientConstructAttempts += 1;
      if (failKeyVaultClientInitOnce) {
        failKeyVaultClientInitOnce = false;
        throw new Error("transient Key Vault client init failure");
      }
    }

    async getSecret(name: string): Promise<{ value?: string }> {
      return { value: secretStore.get(name) };
    }

    async setSecret(
      name: string,
      value: string,
      options?: { tags?: Record<string, string> },
    ): Promise<void> {
      secretStore.set(name, value);
      if (options?.tags) {
        secretTags.set(name, options.tags);
      }
    }

    async *listPropertiesOfSecrets(): AsyncIterable<{ name?: string; tags?: Record<string, string> }> {
      for (const name of secretStore.keys()) {
        yield { name, tags: secretTags.get(name) };
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

import {
  createAzureKeyVaultSecretStore,
  secretRefToKeyVaultSecretName,
} from "../src/security/azureKeyVaultStore.js";

describe("secretRefToKeyVaultSecretName", () => {
  it("keeps known provider mappings", () => {
    expect(secretRefToKeyVaultSecretName("azure-openai")).toBe("azure-openai-api-key");
  });

  it("maps simple provider ids to legacy -api-key names", () => {
    expect(secretRefToKeyVaultSecretName("anthropic")).toBe("anthropic-api-key");
  });

  it("maps refs with colons and underscores to deterministic rector- hashes", () => {
    const a = secretRefToKeyVaultSecretName("openai-compatible:main");
    const b = secretRefToKeyVaultSecretName("openai-compatible:main");
    expect(a).toBe(b);
    expect(a).toMatch(/^rector-[0-9a-f]{64}$/);
    expect(secretRefToKeyVaultSecretName("memory:tidb:prod")).toMatch(/^rector-[0-9a-f]{64}$/);
  });
});

describe("createAzureKeyVaultSecretStore", () => {
  beforeEach(() => {
    secretStore.clear();
    secretTags.clear();
    secretClientConstructAttempts = 0;
    failKeyVaultClientInitOnce = false;
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

  it("round-trips provider refs that contain invalid Key Vault name characters", async () => {
    const ref = "openai-compatible:main";
    const vaultName = secretRefToKeyVaultSecretName(ref);
    const store = createAzureKeyVaultSecretStore({ vaultUrl: "https://kv-rector-dev.vault.azure.net/" });

    const setResult = await store.setSecret(ref, "compat-key");
    expect(setResult.ok).toBe(true);
    expect(secretStore.get(vaultName)).toBe("compat-key");

    const getResult = await store.getSecret(ref);
    expect(getResult).toEqual({ ok: true, value: "compat-key" });

    const ids = await store.listSecretIds!();
    expect(ids).toContain(ref);
  });

  it("retries Key Vault client initialization after a transient failure", async () => {
    failKeyVaultClientInitOnce = true;
    const store = createAzureKeyVaultSecretStore({ vaultUrl: "https://kv-rector-dev.vault.azure.net/" });

    const first = await store.getSecret("azure-openai");
    expect(first.ok).toBe(false);

    secretStore.set("azure-openai-api-key", "after-retry");
    const second = await store.getSecret("azure-openai");
    expect(second).toEqual({ ok: true, value: "after-retry" });
    expect(secretClientConstructAttempts).toBe(2);
  });
});