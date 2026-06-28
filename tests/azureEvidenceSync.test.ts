import { describe, it, expect } from "vitest";
import {
  collectEvidenceFiles,
  resolveBackupContainerName,
  resolveEvidenceSyncConfig,
  resolveEvidenceSyncMode,
  syncEvidenceToBlob,
  type BlobUploadClient,
} from "../src/azure/evidenceSync.js";

describe("resolveEvidenceSyncMode", () => {
  it("defaults to off", () => {
    expect(resolveEvidenceSyncMode(undefined)).toBe("off");
    expect(resolveEvidenceSyncMode("")).toBe("off");
  });

  it("accepts azure-blob", () => {
    expect(resolveEvidenceSyncMode("azure-blob")).toBe("azure-blob");
  });
});

describe("resolveBackupContainerName", () => {
  it("prefers BACKUPS over BACKUPDS typo alias", () => {
    expect(resolveBackupContainerName({ AZURE_STORAGE_CONTAINER_BACKUPS: "backups" })).toBe("backups");
    expect(resolveBackupContainerName({ AZURE_STORAGE_CONTAINER_RECTOR_BACKUPDS: "legacy" })).toBe("legacy");
  });
});

describe("resolveEvidenceSyncConfig", () => {
  it("returns null when sync is off", () => {
    expect(resolveEvidenceSyncConfig({ RECTOR_EVIDENCE_SYNC: "off" })).toBeNull();
  });

  it("requires account name when sync is enabled", () => {
    expect(() => resolveEvidenceSyncConfig({ RECTOR_EVIDENCE_SYNC: "azure-blob" })).toThrow(
      /AZURE_STORAGE_ACCOUNT_NAME/,
    );
  });

  it("builds blob prefix from date and run id", () => {
    const config = resolveEvidenceSyncConfig({
      RECTOR_EVIDENCE_SYNC: "azure-blob",
      AZURE_STORAGE_ACCOUNT_NAME: "stgrectordev",
      AZURE_STORAGE_CONTAINER_HARNESS: "harness-evidence",
      RECTOR_EVIDENCE_SYNC_DATE: "2026-06-27",
      RECTOR_EVIDENCE_SYNC_RUN_ID: "run-1",
    });
    expect(config).toMatchObject({
      accountName: "stgrectordev",
      containerName: "harness-evidence",
      blobPrefix: "2026-06-27/run-1",
    });
  });
});

describe("syncEvidenceToBlob", () => {
  it("uploads only known report files", async () => {
    const uploads: string[] = [];
    const client: BlobUploadClient = {
      async upload(_localPath: string, blobPath: string): Promise<void> {
        uploads.push(blobPath);
      },
    };

    const files = await syncEvidenceToBlob(
      {
        mode: "azure-blob",
        accountName: "stgrectordev",
        containerName: "harness-evidence",
        evidenceDir: "tests/fixtures/eval-corpus",
        blobPrefix: "2026-06-27/test",
      },
      client,
    );

    expect(files).toEqual([]);
    expect(uploads).toEqual([]);
  });

});

describe("collectEvidenceFiles", () => {
  it("collects report artifacts from .omo/evidence when present", async () => {
    const files = await collectEvidenceFiles(".omo/evidence");
    const names = files.map((file) => file.blobPath);
    for (const name of names) {
      expect(["eval-report.json", "eval-report.md", "global-report.json", "global-report.md", "scorecard-audit.md"]).toContain(name);
    }
  });
});