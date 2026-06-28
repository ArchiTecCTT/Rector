import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { createSecretStoreFromEnv, resolveSecretStoreBacking } from "../src/security/secretStoreFactory.js";
describe("resolveSecretStoreBacking", () => {
  it("defaults to local", () => {
    expect(resolveSecretStoreBacking(undefined)).toBe("local");
  });

  it("accepts azure-key-vault", () => {
    expect(resolveSecretStoreBacking("azure-key-vault")).toBe("azure-key-vault");
  });
});

describe("createSecretStoreFromEnv", () => {
  it("returns local secret store by default", async () => {
    const store = createSecretStoreFromEnv({
      local: {
        filePath: ":memory:",
        encryptionKey: randomBytes(32),
        fsImpl: {
          readFile: async () => undefined,
          writeFile: async () => undefined,
          rename: async () => undefined,
          mkdir: async () => undefined,
        },
      },
      env: {},
    });
    await expect(store.hasSecret("missing-provider")).resolves.toBe(false);
  });

  it("requires vault url for azure-key-vault backing", () => {
    expect(() => createSecretStoreFromEnv({
      local: {
        filePath: ":memory:",
        encryptionKey: randomBytes(32),
      },
      env: { RECTOR_SECRET_STORE: "azure-key-vault" },
    })).toThrow(/AZURE_KEY_VAULT_URL/);
  });
});