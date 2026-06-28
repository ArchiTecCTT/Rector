import { describe, it, expect } from "vitest";
import { resolveCartographerSyncConfig, CARTOGRAPHER_ARTIFACT_NAMES } from "../src/azure/cartographerSync.js";

describe("resolveCartographerSyncConfig", () => {
  it("returns null without storage account", () => {
    expect(resolveCartographerSyncConfig({})).toBeNull();
  });

  it("uses cartographer container from env", () => {
    const config = resolveCartographerSyncConfig({
      AZURE_STORAGE_ACCOUNT_NAME: "stgrectordev",
      AZURE_STORAGE_CONTAINER_CARTOGRAPHER: "cartographer",
      RECTOR_EVIDENCE_SYNC_DATE: "2026-06-27",
      RECTOR_EVIDENCE_SYNC_RUN_ID: "run-1",
    });
    expect(config).toMatchObject({
      accountName: "stgrectordev",
      containerName: "cartographer",
      blobPrefix: "2026-06-27/run-1",
    });
  });
});

describe("CARTOGRAPHER_ARTIFACT_NAMES", () => {
  it("matches self-scan output files", () => {
    expect(CARTOGRAPHER_ARTIFACT_NAMES).toContain("latest-snapshot.json");
    expect(CARTOGRAPHER_ARTIFACT_NAMES).toContain("scan-report.md");
  });
});