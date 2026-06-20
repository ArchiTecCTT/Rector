import { afterEach, describe, expect, it } from "vitest";

import {
  hashString,
  InMemoryCartographerInventoryStore,
  SqliteCartographerInventoryStore,
  type CartographerInventoryStore,
  type FileNode,
  type IgnoredFileRef,
  type ScanError,
} from "../../src/cartographer";
import { STARTUP_MIGRATION_TABLES, createSqliteDriver, type SqlDriver } from "../../src/store";

type MutableFileNode = { -readonly [Property in keyof FileNode]: FileNode[Property] };
type MutableScanError = { -readonly [Property in keyof ScanError]: ScanError[Property] };

const repoRoot = "/repo/root";
const otherRepoRoot = "/other/repo";
const fixedCreatedAt = "2026-06-20T01:02:03.000Z";
const laterCreatedAt = "2026-06-20T01:02:04.000Z";

describe("SqliteCartographerInventoryStore", () => {
  const openDrivers = new Set<SqlDriver>();

  afterEach(() => {
    for (const driver of openDrivers) driver.close();
    openDrivers.clear();
  });

  function sqliteStore(now: () => Date = () => new Date(fixedCreatedAt)): SqliteCartographerInventoryStore {
    const driver = createSqliteDriver({ path: ":memory:" });
    openDrivers.add(driver);
    return new SqliteCartographerInventoryStore({ driver, now });
  }

  it("creates a snapshot with generated metadata and returns it as the latest snapshot", async () => {
    const store = sqliteStore();
    const files = [makeFile("src/index.ts", "hash-index"), makeFile("src/app.ts", "hash-app")];
    const ignoredFiles = [makeIgnoredFile("node_modules")];
    const deletedFiles = ["old.ts", "legacy.ts"];
    const changedFiles = [required(files.at(0), "changed file")];

    const snapshot = await store.createSnapshot({ repoRoot, files, ignoredFiles, deletedFiles, changedFiles });

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
    expect(await store.getLatestSnapshot(repoRoot)).toEqual(snapshot);
  });

  it("runs Cartographer-only DDL idempotently and creates no Rector store tables", () => {
    const driver = createSqliteDriver({ path: ":memory:" });
    openDrivers.add(driver);

    expect(() => {
      new SqliteCartographerInventoryStore({ driver });
      new SqliteCartographerInventoryStore({ driver });
    }).not.toThrow();
    const rows = driver.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    const names = rows.map((row) => row.name);
    const startupTables: readonly string[] = STARTUP_MIGRATION_TABLES;

    expect(names).toEqual(["cartographer_files", "cartographer_scan_errors", "cartographer_snapshots"]);
    expect(names.some((name) => startupTables.includes(name))).toBe(false);
  });

  it("selects and lists snapshots by createdAt descending with id ascending ties", async () => {
    const firstStore = sqliteStore();
    const secondStore = sqliteStore();
    const earlierInput = { repoRoot, files: [makeFile("a.ts", "a")], ignoredFiles: [], id: "snapshot-a", createdAt: fixedCreatedAt };
    const laterInput = { repoRoot, files: [makeFile("b.ts", "b")], ignoredFiles: [], id: "snapshot-b", createdAt: laterCreatedAt };

    await firstStore.createSnapshot(earlierInput);
    const firstLatest = await firstStore.createSnapshot(laterInput);
    const secondLatest = await secondStore.createSnapshot(laterInput);
    await secondStore.createSnapshot(earlierInput);
    await firstStore.createSnapshot({ repoRoot, files: [makeFile("tie.ts", "tie")], ignoredFiles: [], id: "snapshot-0", createdAt: fixedCreatedAt });

    expect(await firstStore.getLatestSnapshot(repoRoot)).toEqual(firstLatest);
    expect(await secondStore.getLatestSnapshot(repoRoot)).toEqual(secondLatest);
    expect((await firstStore.listSnapshots(repoRoot)).map((snapshot) => snapshot.id)).toEqual(["snapshot-b", "snapshot-0", "snapshot-a"]);
  });

  it("upserts current files, deletes ignored files, and lists code-unit sorted copies", async () => {
    const store = sqliteStore();
    const originalFile = makeFile("old.ts", "old");
    await store.upsertFiles(repoRoot, [makeFile("b.ts", "hash-b"), makeFile("ä.ts", "hash-umlaut"), makeFile("Z.ts", "hash-z"), makeFile("a.ts", "hash-a"), originalFile]);
    const ignoredReplacement = { ...originalFile, ignored: true, ignoreReason: "ignored now" };

    await store.upsertFiles(repoRoot, [ignoredReplacement]);
    const files = await store.listFiles(repoRoot);
    const returnedFile = required(files.at(0), "returned file");
    const mutableReturnedFile: MutableFileNode = returnedFile;
    mutableReturnedFile.hash = "mutated-returned-hash";

    expect(files.map((file) => file.normalizedPath)).toEqual(["Z.ts", "a.ts", "b.ts", "ä.ts"]);
    expect((await store.listFiles(repoRoot)).map((file) => file.hash)).toEqual(["hash-z", "hash-a", "hash-b", "hash-umlaut"]);
  });

  it("removes only named paths for the target repo and treats missing paths as no-ops", async () => {
    const store = sqliteStore();
    await store.upsertFiles(repoRoot, [makeFile("keep.ts", "keep"), makeFile("remove.ts", "remove")]);
    await store.upsertFiles(otherRepoRoot, [makeFile("remove.ts", "other-remove")]);

    await expect(store.removeFiles(repoRoot, ["remove.ts", "missing.ts"])).resolves.toBeUndefined();

    expect((await store.listFiles(repoRoot)).map((file) => file.normalizedPath)).toEqual(["keep.ts"]);
    expect((await store.listFiles(otherRepoRoot)).map((file) => file.normalizedPath)).toEqual(["remove.ts"]);
  });

  it("chunks large path deletions under SQLite variable limits", async () => {
    const store = sqliteStore();
    const files = Array.from({ length: 1_005 }, (_unused, index) => makeFile(`src/remove-${index}.ts`, `hash-${index}`));
    await store.upsertFiles(repoRoot, files);

    await expect(store.removeFiles(repoRoot, files.map((file) => file.normalizedPath))).resolves.toBeUndefined();

    expect(await store.listFiles(repoRoot)).toEqual([]);
  });

  it("appends scan errors across calls using per-snapshot sequence ordering", async () => {
    const store = sqliteStore();

    await store.recordErrors("snapshot-1", [makeError("src/a.ts", "hash", "hash denied")]);
    await store.recordErrors("snapshot-1", [makeUnrecoverableError("src/b.ts", "read", "read denied")]);
    const errors = await store.listErrors("snapshot-1");
    const mutableReturnedError: MutableScanError = required(errors.at(0), "returned error");
    mutableReturnedError.message = "mutated message";

    expect(await store.listErrors("snapshot-1")).toEqual([
      makeError("src/a.ts", "hash", "hash denied"),
      makeUnrecoverableError("src/b.ts", "read", "read denied"),
    ]);
  });

  it("uses snapshot and seq as the scan-error primary key", () => {
    const driver = createSqliteDriver({ path: ":memory:" });
    openDrivers.add(driver);
    new SqliteCartographerInventoryStore({ driver });

    const columns = driver.all<{ name: string }>("PRAGMA table_info(cartographer_scan_errors)").map((row) => row.name);

    expect(columns).toEqual(["snapshot_id", "seq", "path", "stage", "message", "recoverable", "created_at"]);
  });

  it("returns empty or undefined values for unknown roots and snapshots", async () => {
    const store = sqliteStore();

    await expect(store.getLatestSnapshot("/unknown/root")).resolves.toBeUndefined();
    await expect(store.listFiles("/unknown/root")).resolves.toEqual([]);
    await expect(store.listErrors("unknown-snapshot")).resolves.toEqual([]);
    await expect(store.removeFiles("/unknown/root", ["missing.ts"])).resolves.toBeUndefined();
  });

  it("matches in-memory observable reads after every operation in a shared sequence", async () => {
    const memory = new InMemoryCartographerInventoryStore({ now: () => new Date(fixedCreatedAt) });
    const sqlite = sqliteStore();
    const stores = [memory, sqlite] as const;
    const snapshotIds = ["snapshot-1", "snapshot-2"] as const;

    await expectSurfacesEqual(memory, sqlite, snapshotIds);
    await applyToAll(stores, (store) => store.upsertFiles(repoRoot, [makeFile("Z.ts", "z"), makeFile("a.ts", "a"), makeFile("ä.ts", "umlaut")]));
    await expectSurfacesEqual(memory, sqlite, snapshotIds);
    await applyToAll(stores, (store) => store.upsertFiles(repoRoot, [{ ...makeFile("a.ts", "ignored"), ignored: true, ignoreReason: "ignored" }]));
    await expectSurfacesEqual(memory, sqlite, snapshotIds);
    await applyToAll(stores, (store) => store.removeFiles(repoRoot, ["missing.ts", "Z.ts"]));
    await expectSurfacesEqual(memory, sqlite, snapshotIds);
    await applyToAll(stores, (store) => store.createSnapshot({ repoRoot, files: [makeFile("ä.ts", "umlaut")], ignoredFiles: [makeIgnoredFile("dist")], id: "snapshot-1", createdAt: laterCreatedAt }));
    await expectSurfacesEqual(memory, sqlite, snapshotIds);
    await applyToAll(stores, (store) => store.recordErrors("snapshot-1", [makeError("src/a.ts", "hash", "hash denied")]));
    await expectSurfacesEqual(memory, sqlite, snapshotIds);
    await applyToAll(stores, (store) => store.recordErrors("snapshot-1", [makeUnrecoverableError("src/b.ts", "read", "read denied")]));
    await expectSurfacesEqual(memory, sqlite, snapshotIds);
  });
});

async function applyToAll(stores: readonly CartographerInventoryStore[], action: (store: CartographerInventoryStore) => Promise<unknown>): Promise<void> {
  for (const store of stores) await action(store);
}

async function expectSurfacesEqual(memory: CartographerInventoryStore, sqlite: CartographerInventoryStore, snapshotIds: readonly string[]): Promise<void> {
  expect(await readSurface(sqlite, snapshotIds)).toEqual(await readSurface(memory, snapshotIds));
}

async function readSurface(store: CartographerInventoryStore, snapshotIds: readonly string[]): Promise<unknown> {
  const errors: Record<string, readonly ScanError[]> = {};
  for (const snapshotId of snapshotIds) errors[snapshotId] = await store.listErrors(snapshotId);
  return {
    latest: await store.getLatestSnapshot(repoRoot),
    unknownLatest: await store.getLatestSnapshot("/unknown/root"),
    snapshots: await store.listSnapshots(repoRoot),
    files: await store.listFiles(repoRoot),
    unknownFiles: await store.listFiles("/unknown/root"),
    errors,
  };
}

function makeFile(normalizedPath: string, hash: string): MutableFileNode {
  return { id: `file:${normalizedPath}`, path: normalizedPath, normalizedPath, hash, sizeBytes: 42, mtimeMs: 100, language: "typescript", kind: "source", ignored: false, lastIndexedAt: fixedCreatedAt };
}

function makeIgnoredFile(path: string): IgnoredFileRef {
  return { path, reason: "built-in ignore", source: "built_in", isDirectory: true };
}

function makeError(path: string, stage: ScanError["stage"], message: string): ScanError {
  return { path, stage, message, recoverable: true };
}

function makeUnrecoverableError(path: string, stage: ScanError["stage"], message: string): ScanError {
  return { path, stage, message, recoverable: false };
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`missing fixture ${label}`);
  return value;
}
