import { describe, expect, it } from "vitest";
import { hashString, InMemoryCartographerInventoryStore, type FileNode, type IgnoredFileRef, type ScanError } from "../../src/cartographer";

type MutableFileNode = { -readonly [Property in keyof FileNode]: FileNode[Property] };
type MutableScanError = { -readonly [Property in keyof ScanError]: ScanError[Property] };

const repoRoot = "/repo/root";
const otherRepoRoot = "/other/repo";
const fixedCreatedAt = "2026-06-20T01:02:03.000Z";
const laterCreatedAt = "2026-06-20T01:02:04.000Z";

describe("InMemoryCartographerInventoryStore", () => {
  it("creates a snapshot with generated metadata and returns it as the latest snapshot", async () => {
    // Given: an inventory store with a deterministic clock and snapshot inputs carrying indexed, ignored, deleted, and changed files.
    const store = new InMemoryCartographerInventoryStore({ now: () => new Date(fixedCreatedAt) });
    const files = [makeFile("src/index.ts", "hash-index"), makeFile("src/app.ts", "hash-app")];
    const ignoredFiles = [makeIgnoredFile("node_modules")];
    const deletedFiles = ["old.ts", "legacy.ts"];
    const changedFiles = [files[0] ?? missingFile("src/index.ts")];

    // When: a snapshot is created without an explicit id or createdAt.
    const snapshot = await store.createSnapshot({ repoRoot, files, ignoredFiles, deletedFiles, changedFiles });
    const latest = await store.getLatestSnapshot(repoRoot);

    // Then: id, timestamp, and counts are derived from the canonical payload and the snapshot becomes latest.
    expect(snapshot).toEqual({
      id: hashString(JSON.stringify({ files: files.map((file) => [file.normalizedPath, file.hash]), createdAt: fixedCreatedAt })),
      repoRoot,
      createdAt: fixedCreatedAt,
      fileCount: 3,
      indexedFileCount: 2,
      ignoredFileCount: 1,
      deletedFileCount: 2,
      changedFileCount: 1,
    });
    expect(latest).toEqual(snapshot);
  });

  it("selects the latest snapshot by createdAt regardless of insertion order", async () => {
    // Given: two stores that receive the same snapshots in opposite insertion orders.
    const firstStore = new InMemoryCartographerInventoryStore();
    const secondStore = new InMemoryCartographerInventoryStore();
    const earlierInput = { repoRoot, files: [makeFile("a.ts", "a")], ignoredFiles: [], id: "snapshot-a", createdAt: fixedCreatedAt };
    const laterInput = { repoRoot, files: [makeFile("b.ts", "b")], ignoredFiles: [], id: "snapshot-b", createdAt: laterCreatedAt };

    // When: snapshots are inserted earlier-then-later and later-then-earlier.
    await firstStore.createSnapshot(earlierInput);
    const firstLatest = await firstStore.createSnapshot(laterInput);
    const secondLatest = await secondStore.createSnapshot(laterInput);
    await secondStore.createSnapshot(earlierInput);

    // Then: getLatestSnapshot always returns the snapshot with the higher createdAt value.
    expect(await firstStore.getLatestSnapshot(repoRoot)).toEqual(firstLatest);
    expect(await secondStore.getLatestSnapshot(repoRoot)).toEqual(secondLatest);
  });

  it("lists snapshots by createdAt descending and id ascending for ties", async () => {
    // Given: snapshots inserted in an order that differs from the required read ordering.
    const store = new InMemoryCartographerInventoryStore();
    await store.createSnapshot({ repoRoot, files: [makeFile("b.ts", "b")], ignoredFiles: [], id: "snapshot-b", createdAt: fixedCreatedAt });
    await store.createSnapshot({ repoRoot, files: [makeFile("latest.ts", "latest")], ignoredFiles: [], id: "snapshot-latest", createdAt: laterCreatedAt });
    await store.createSnapshot({ repoRoot, files: [makeFile("a.ts", "a")], ignoredFiles: [], id: "snapshot-a", createdAt: fixedCreatedAt });

    // When: snapshots are listed.
    const snapshots = await store.listSnapshots(repoRoot);

    // Then: newer snapshots come first, and same-createdAt snapshots use id ascending order.
    expect(snapshots.map((snapshot) => snapshot.id)).toEqual(["snapshot-latest", "snapshot-a", "snapshot-b"]);
  });

  it("upserts current files and lists code-unit sorted copies", async () => {
    // Given: files inserted out of UTF-16 code-unit order.
    const store = new InMemoryCartographerInventoryStore();
    await store.upsertFiles(repoRoot, [makeFile("b.ts", "hash-b"), makeFile("ä.ts", "hash-umlaut"), makeFile("Z.ts", "hash-z"), makeFile("a.ts", "hash-a")]);

    // When: current inventory files are listed.
    const files = await store.listFiles(repoRoot);

    // Then: sorting uses UTF-16 code-unit order, not locale collation.
    expect(files.map((file) => file.normalizedPath)).toEqual(["Z.ts", "a.ts", "b.ts", "ä.ts"]);
  });

  it("isolates stored files from returned object mutation and input object mutation", async () => {
    // Given: a mutable input file is upserted into the store.
    const store = new InMemoryCartographerInventoryStore();
    const inputFile = makeFile("src/index.ts", "original-hash");
    await store.upsertFiles(repoRoot, [inputFile]);

    // When: the caller mutates both the returned object and the original input object after storage.
    const firstRead = await store.listFiles(repoRoot);
    const returnedFile = firstRead[0] ?? missingFile("src/index.ts");
    const mutableReturnedFile: MutableFileNode = returnedFile;
    mutableReturnedFile.hash = "mutated-returned-hash";
    inputFile.hash = "mutated-input-hash";
    const secondRead = await store.listFiles(repoRoot);

    // Then: stored state remains the original clone.
    expect(secondRead).toEqual([makeFile("src/index.ts", "original-hash")]);
  });

  it("removes only named paths for the target repo and treats missing paths as no-ops", async () => {
    // Given: two repositories with overlapping and distinct file inventories.
    const store = new InMemoryCartographerInventoryStore();
    await store.upsertFiles(repoRoot, [makeFile("keep.ts", "keep"), makeFile("remove.ts", "remove")]);
    await store.upsertFiles(otherRepoRoot, [makeFile("remove.ts", "other-remove")]);

    // When: one existing path and one missing path are removed from the target repository.
    await store.removeFiles(repoRoot, ["remove.ts", "missing.ts"]);

    // Then: only the named target-repo file is removed.
    expect((await store.listFiles(repoRoot)).map((file) => file.normalizedPath)).toEqual(["keep.ts"]);
    expect((await store.listFiles(otherRepoRoot)).map((file) => file.normalizedPath)).toEqual(["remove.ts"]);
  });

  it("appends scan errors by snapshot id and returns insertion-ordered copies", async () => {
    // Given: scan errors recorded across multiple calls for the same snapshot id.
    const store = new InMemoryCartographerInventoryStore();
    await store.recordErrors("snapshot-1", [makeError("src/a.ts", "hash", "hash denied")]);
    await store.recordErrors("snapshot-1", [makeError("src/b.ts", "read", "read denied")]);

    // When: errors are listed and the caller mutates a returned error object.
    const errors = await store.listErrors("snapshot-1");
    const returnedError = errors[0] ?? missingError("src/a.ts");
    const mutableReturnedError: MutableScanError = returnedError;
    mutableReturnedError.message = "mutated message";
    const secondRead = await store.listErrors("snapshot-1");

    // Then: append order is retained and stored errors are copy-isolated.
    expect(secondRead).toEqual([makeError("src/a.ts", "hash", "hash denied"), makeError("src/b.ts", "read", "read denied")]);
  });

  it("returns empty or undefined values for unknown roots and snapshots", async () => {
    // Given: an empty inventory store.
    const store = new InMemoryCartographerInventoryStore();

    // When/Then: missing reads resolve to empty values instead of throwing.
    await expect(store.getLatestSnapshot("/unknown/root")).resolves.toBeUndefined();
    await expect(store.listFiles("/unknown/root")).resolves.toEqual([]);
    await expect(store.listErrors("unknown-snapshot")).resolves.toEqual([]);
    await expect(store.removeFiles("/unknown/root", ["missing.ts"])).resolves.toBeUndefined();
  });
});

function makeFile(normalizedPath: string, hash: string): MutableFileNode {
  return {
    id: `file:${normalizedPath}`,
    path: normalizedPath,
    normalizedPath,
    hash,
    sizeBytes: 42,
    mtimeMs: 100,
    language: "typescript",
    kind: "source",
    ignored: false,
    lastIndexedAt: fixedCreatedAt,
  };
}

function makeIgnoredFile(path: string): IgnoredFileRef {
  return { path, reason: "built-in ignore", source: "built_in", isDirectory: true };
}

function makeError(path: string, stage: ScanError["stage"], message: string): ScanError {
  return { path, stage, message, recoverable: true };
}

function missingFile(path: string): FileNode {
  throw new Error(`missing fixture file: ${path}`);
}

function missingError(path: string): ScanError {
  throw new Error(`missing fixture error: ${path}`);
}
