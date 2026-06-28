import { describe, it, expect, vi, beforeEach } from "vitest";
import { runDailyTouch } from "../src/azure/dailyTouch.js";

vi.mock("@azure/keyvault-secrets", () => {
  class SecretClient {
    async *listPropertiesOfSecrets(): AsyncIterable<{ name: string }> {
      yield { name: "azure-openai-api-key" };
      yield { name: "github-pat" };
    }
  }
  return { SecretClient };
});

vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: class DefaultAzureCredential {},
}));

vi.mock("../src/azure/evidenceSync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/azure/evidenceSync.js")>();
  return {
    ...actual,
    collectEvidenceFiles: vi.fn(async () => []),
    createAzureBlobUploadClient: vi.fn(),
    syncEvidenceToBlob: vi.fn(async () => []),
  };
});

vi.mock("../src/azure/cartographerSync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/azure/cartographerSync.js")>();
  return {
    ...actual,
    collectCartographerFiles: vi.fn(async () => []),
    createAzureBlobUploadClient: vi.fn(),
    syncCartographerToBlob: vi.fn(async () => []),
  };
});

vi.mock("../src/observability/appInsightsAdapter.js", () => ({
  emitAzureDailyTouchTelemetry: vi.fn(),
}));

describe("runDailyTouch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists Key Vault secrets and skips blob when no local artifacts", async () => {
    const result = await runDailyTouch({
      repoRoot: "/tmp/rector",
      env: {
        AZURE_KEY_VAULT_URL: "https://kv-rector-dev.vault.azure.net/",
        AZURE_STORAGE_ACCOUNT_NAME: "stgrectordev",
        APPLICATIONINSIGHTS_CONNECTION_STRING: "InstrumentationKey=test",
      },
    });

    expect(result.ok).toBe(true);
    expect(result.steps.find((step) => step.id === "keyvault")).toMatchObject({ status: "ok" });
    expect(result.steps.find((step) => step.id === "blob-harness")).toMatchObject({ status: "skipped" });
    expect(result.steps.find((step) => step.id === "appinsights")).toMatchObject({ status: "ok" });
  });
});