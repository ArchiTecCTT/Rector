import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

  it("falls back to legacy .omo/evidence when the default .rector/evidence tree is empty", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rector-evidence-sync-legacy-"));
    const uploads: string[] = [];
    const client: BlobUploadClient = {
      async upload(_localPath: string, blobPath: string): Promise<void> {
        uploads.push(blobPath);
      },
    };
    try {
      await mkdir(path.join(root, ".omo", "evidence"), { recursive: true });
      await writeFile(path.join(root, ".omo", "evidence", "global-report.json"), "{}\n", "utf8");

      const files = await syncEvidenceToBlob(
        {
          mode: "azure-blob",
          accountName: "stgrectordev",
          containerName: "harness-evidence",
          evidenceDir: path.join(root, ".rector", "evidence"),
          blobPrefix: "2026-06-27/test",
        },
        client,
      );

      expect(files.map((file) => file.blobPath)).toEqual(["global-report.json"]);
      expect(uploads).toEqual(["2026-06-27/test/global-report.json"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

});

describe("collectEvidenceFiles", () => {
  it("returns an empty list when the evidence directory does not exist", async () => {
    const files = await collectEvidenceFiles(".omo/evidence-missing-for-test-ENOENT");
    expect(files).toEqual([]);
  });

  it("collects report artifacts from .omo/evidence when present", async () => {
    const files = await collectEvidenceFiles(".omo/evidence");
    const names = files.map((file) => file.blobPath);
    for (const name of names) {
      expect(["eval-report.json", "eval-report.md", "global-report.json", "global-report.md", "scorecard-audit.md"]).toContain(name);
    }
  });

  it("collects nested .rector/evidence reports and proof artifacts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rector-evidence-sync-"));
    try {
      const evidenceRoot = path.join(root, ".rector", "evidence");
      await mkdir(path.join(evidenceRoot, "capabilities", "raw-artifacts", "case-1"), { recursive: true });
      await mkdir(path.join(evidenceRoot, "global", "regressions"), { recursive: true });
      await mkdir(path.join(evidenceRoot, "phase2", "live-fact-shadow-artifacts"), { recursive: true });
      await writeFile(path.join(evidenceRoot, "capabilities", "eval-report.json"), "{}\n", "utf8");
      await writeFile(path.join(evidenceRoot, "capabilities", "raw-artifacts", "case-1", "artifact.txt"), "proof\n", "utf8");
      await writeFile(path.join(evidenceRoot, "global", "regressions", "case.json"), "{}\n", "utf8");
      await writeFile(path.join(evidenceRoot, "phase2", "live-fact-shadow-summary.json"), "{}\n", "utf8");
      await writeFile(path.join(evidenceRoot, "phase2", "live-fact-shadow-artifacts", "case.json"), "{}\n", "utf8");

      const names = (await collectEvidenceFiles(evidenceRoot)).map((file) => file.blobPath);

      expect(names).toEqual([
        "capabilities/eval-report.json",
        "capabilities/raw-artifacts/case-1/artifact.txt",
        "global/regressions/case.json",
        "phase2/live-fact-shadow-artifacts/case.json",
        "phase2/live-fact-shadow-summary.json",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not upload .rector runtime state when pointed at .rector", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rector-evidence-sync-safe-"));
    try {
      const rectorRoot = path.join(root, ".rector");
      await mkdir(path.join(rectorRoot, "evidence", "phase0"), { recursive: true });
      await writeFile(path.join(rectorRoot, "evidence", "phase0", "phase0-baseline.json"), "{}\n", "utf8");
      await writeFile(path.join(rectorRoot, "providers.json"), "{\"secretRef\":\"provider\"}\n", "utf8");
      await writeFile(path.join(rectorRoot, "secrets.enc"), "ciphertext\n", "utf8");
      await writeFile(path.join(rectorRoot, "runtime-settings.json"), "{}\n", "utf8");

      const names = (await collectEvidenceFiles(rectorRoot)).map((file) => file.blobPath);

      expect(names).toEqual(["evidence/phase0/phase0-baseline.json"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
