import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashString, InMemoryCartographerInventoryStore, scanChangedFiles, SqliteCartographerInventoryStore, type CartographerInventoryStore, type FileNode, type ScanResult } from "../../src/cartographer";
import { createSqliteDriver, type SqlDriver } from "../../src/store";
import { collectEvents, fixedNow, labelForEvent, makeFixtureRepo, makeSpyingReader, tempRoots } from "./repoScannerTestHarness";

type StoreCase = { readonly name: string; readonly make: () => CartographerInventoryStore };

describe("Cartographer T8 incremental indexer", () => {
  const openDrivers = new Set<SqlDriver>();
  const cases: readonly StoreCase[] = [
    { name: "in-memory", make: () => new InMemoryCartographerInventoryStore({ now: () => fixedNow }) },
    {
      name: "sqlite",
      make: () => {
        const driver = createSqliteDriver({ path: ":memory:" });
        openDrivers.add(driver);
        return new SqliteCartographerInventoryStore({ driver, now: () => fixedNow });
      },
    },
  ];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
    for (const driver of openDrivers) driver.close();
    openDrivers.clear();
  });

  for (const storeCase of cases) {
    describe(storeCase.name, () => {
      it("indexes an empty store, persists all files, and fingerprints the snapshot", async () => {
        // Given: a fixture repo and an empty inventory store.
        const repoRoot = await makeFixtureRepo();
        const store = storeCase.make();

        // When: the first incremental scan runs.
        const result = await scanChangedFiles({ repoRoot, store, now: () => fixedNow });

        // Then: every non-ignored file is added, persisted, counted, and fingerprinted.
        expect(result.files.map(pathOf)).toEqual(fixtureIndexedPaths);
        expect(result.changedFiles.map(pathOf)).toEqual(fixtureIndexedPaths);
        expect(result.deletedFiles).toEqual([]);
        expect((await store.listFiles(path.resolve(repoRoot))).map(pathOf)).toEqual(fixtureIndexedPaths);
        expectSnapshotContract(result);
      });

      it("detects added files and byte modifications by hash", async () => {
        // Given: a previously indexed fixture repo.
        const repoRoot = await makeFixtureRepo();
        const store = storeCase.make();
        const first = await scanChangedFiles({ repoRoot, store, now: () => fixedNow });

        // When: one file is added and one existing file's bytes change.
        await writeFile(repoRoot, "src/new.ts", "export const newValue = 1;\n");
        const added = await scanChangedFiles({ repoRoot, store, now: () => fixedNow });
        await writeFile(repoRoot, "src/index.ts", "export const indexValue = 10;\n");
        const modified = await scanChangedFiles({ repoRoot, store, now: () => fixedNow });

        // Then: changedFiles reports only the touched path for each scan, and hashes alter the snapshot id.
        expect(added.changedFiles.map(pathOf)).toEqual(["src/new.ts"]);
        expect(added.deletedFiles).toEqual([]);
        expect(added.files.map(pathOf)).toEqual([...fixtureIndexedPaths.slice(0, 8), "src/new.ts", "tsconfig.json"]);
        expect(modified.changedFiles.map(pathOf)).toEqual(["src/index.ts"]);
        expect(modified.snapshot.id).not.toBe(first.snapshot.id);
        expectSnapshotContract(added);
        expectSnapshotContract(modified);
      });

      it("detects same-size byte edits even when mtime is restored", async () => {
        // Given: a previously indexed file with saved timestamps.
        const repoRoot = await makeFixtureRepo();
        const store = storeCase.make();
        await scanChangedFiles({ repoRoot, store, now: () => fixedNow });
        const absolutePath = path.join(repoRoot, "src", "app.ts");
        const stat = await fs.stat(absolutePath);

        // When: bytes change to equal-length content and mtime is restored.
        await fs.writeFile(absolutePath, "export const appValue = 3;\n", "utf8");
        await fs.utimes(absolutePath, stat.atime, stat.mtime);
        const result = await scanChangedFiles({ repoRoot, store, now: () => fixedNow });

        // Then: default mode rehashes and reports the file as modified.
        expect(result.changedFiles.map(pathOf)).toEqual(["src/app.ts"]);
        expectSnapshotContract(result);
      });

      it("skips hashing unchanged size-and-mtime matches only in fastPrecheck mode", async () => {
        // Given: a fixture repo with prior inventory and one subsequent new file.
        const repoRoot = await makeFixtureRepo();
        const store = storeCase.make();
        await scanChangedFiles({ repoRoot, store, now: () => fixedNow });
        await writeFile(repoRoot, "src/fast-added.ts", "export const fastAdded = 1;\n");
        const { reader, allCalls } = makeSpyingReader(repoRoot);

        // When: fastPrecheck scans the repo.
        const result = await scanChangedFiles({ repoRoot, store, fileReader: reader, fastPrecheck: true, now: () => fixedNow });

        // Then: the untouched prior file is unchanged without a readAll call, while the new file is hashed.
        expect(result.changedFiles.map(pathOf)).toEqual(["src/fast-added.ts"]);
        expect(allCalls.filter((call) => call.normalizedPath === "src/app.ts")).toEqual([]);
        expect(allCalls.map((call) => call.normalizedPath)).toContain("src/fast-added.ts");
      });

      it("removes deleted files from inventory and emits deterministic events", async () => {
        // Given: a prior inventory and an event collector for the next scan.
        const repoRoot = await makeFixtureRepo();
        const store = storeCase.make();
        await scanChangedFiles({ repoRoot, store, now: () => fixedNow });
        await fs.rm(path.join(repoRoot, "docs", "architecture.md"));
        const { events, emitter } = collectEvents();

        // When: the deletion scan runs.
        const result = await scanChangedFiles({ repoRoot, store, emitter, now: () => fixedNow });

        // Then: deletedFiles is disjoint from files, the store row is hard-removed, and events are ordered.
        expect(result.deletedFiles).toEqual(["docs/architecture.md"]);
        expect(result.files.map(pathOf)).not.toContain("docs/architecture.md");
        expect((await store.listFiles(path.resolve(repoRoot))).map(pathOf)).not.toContain("docs/architecture.md");
        expect(events.map(labelForEvent)).toEqual(expectedDeletionEvents(repoRoot));
        expectSnapshotContract(result);
      });

      it("treats newly ignored files and ancestor directories as removed inventory", async () => {
        // Given: prior inventories containing a file and a nested descendant that can become ignored.
        const fileRoot = await makeFixtureRepo();
        const dirRoot = await makeFixtureRepo();
        const fileStore = storeCase.make();
        const dirStore = storeCase.make();
        await writeFile(dirRoot, "src/subdir/nested.ts", "export const nested = 1;\n");
        await scanChangedFiles({ repoRoot: fileRoot, store: fileStore, now: () => fixedNow });
        await scanChangedFiles({ repoRoot: dirRoot, store: dirStore, now: () => fixedNow });

        // When: .rectorignore starts covering a prior file and a prior ancestor directory.
        await appendIgnore(fileRoot, ".env.example\n");
        await appendIgnore(dirRoot, "src/subdir/\n");
        const fileIgnored = await scanChangedFiles({ repoRoot: fileRoot, store: fileStore, now: () => fixedNow });
        const dirIgnored = await scanChangedFiles({ repoRoot: dirRoot, store: dirStore, now: () => fixedNow });

        // Then: each prior path appears once in deletedFiles, is ignored, and is absent from inventory/files.
        expect(fileIgnored.deletedFiles.filter((entry) => entry === ".env.example")).toEqual([".env.example"]);
        expect(fileIgnored.ignoredFiles).toContainEqual({ path: ".env.example", reason: "matched .rectorignore", source: "rectorignore", isDirectory: false });
        expect(fileIgnored.files.map(pathOf)).not.toContain(".env.example");
        expect((await fileStore.listFiles(path.resolve(fileRoot))).map(pathOf)).not.toContain(".env.example");
        expect(dirIgnored.deletedFiles.filter((entry) => entry === "src/subdir/nested.ts")).toEqual(["src/subdir/nested.ts"]);
        expect(dirIgnored.ignoredFiles).toContainEqual({ path: "src/subdir", reason: "matched .rectorignore", source: "rectorignore", isDirectory: true });
        expect((await dirStore.listFiles(path.resolve(dirRoot))).map(pathOf)).not.toContain("src/subdir/nested.ts");
        expectSnapshotContract(fileIgnored);
        expectSnapshotContract(dirIgnored);
      });

      it("records hash failures without changing that prior inventory row", async () => {
        // Given: prior inventory and a reader that rejects hashing one existing file while another file changes.
        const repoRoot = await makeFixtureRepo();
        const store = storeCase.make();
        const first = await scanChangedFiles({ repoRoot, store, now: () => fixedNow });
        const priorApp = required(first.files.find((file) => file.normalizedPath === "src/app.ts"), "prior app");
        await writeFile(repoRoot, "src/index.ts", "export const indexValue = 4;\n");

        // When: the second scan hits a hash failure.
        const result = await scanChangedFiles({ repoRoot, store, fileReader: makeSpyingReader(repoRoot, [{ method: "readAll", normalizedPath: "src/app.ts", message: "hash denied" }]).reader, now: () => fixedNow });

        // Then: the failed path is omitted from scan buckets, retained unchanged in the store, and persisted as an error.
        expect(result.errors).toContainEqual({ path: path.join(path.resolve(repoRoot), "src", "app.ts"), stage: "hash", message: "hash denied", recoverable: true });
        expect(result.files.map(pathOf)).not.toContain("src/app.ts");
        expect(result.changedFiles.map(pathOf)).toEqual(["src/index.ts"]);
        expect(result.deletedFiles).toEqual([]);
        expect(required((await store.listFiles(path.resolve(repoRoot))).find((file) => file.normalizedPath === "src/app.ts"), "stored app")).toEqual(priorApp);
        expect(await store.listErrors(result.snapshot.id)).toEqual(result.errors);
      });
    });
  }
});

const fixtureIndexedPaths = [".env.example", ".gitignore", ".rectorignore", "docs/architecture.md", "package.json", "src/app.test.ts", "src/app.ts", "src/index.ts", "tsconfig.json"] as const;

function pathOf(file: FileNode): string { return file.normalizedPath; }

function expectSnapshotContract(result: ScanResult): void {
  expect(result.snapshot.id).toBe(hashString(JSON.stringify(result.files.map((file) => [file.normalizedPath, file.hash]))));
  expect(result.snapshot).toMatchObject({ indexedFileCount: result.files.length, ignoredFileCount: result.ignoredFiles.length, changedFileCount: result.changedFiles.length, deletedFileCount: result.deletedFiles.length });
  expect(result.deletedFiles.filter((deleted) => result.files.some((file) => file.normalizedPath === deleted))).toEqual([]);
}

async function writeFile(repoRoot: string, normalizedPath: string, contents: string): Promise<void> {
  const absolutePath = path.join(repoRoot, ...normalizedPath.split("/"));
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, contents, "utf8");
}

async function appendIgnore(repoRoot: string, line: string): Promise<void> { await fs.appendFile(path.join(repoRoot, ".rectorignore"), line, "utf8"); }

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`missing ${label}`);
  return value;
}

function expectedDeletionEvents(repoRoot: string): ReturnType<typeof labelForEvent>[] {
  const resolvedRoot = path.resolve(repoRoot);
  return [
    { type: "CARTOGRAPHER_SCAN_STARTED", path: resolvedRoot },
    { type: "CARTOGRAPHER_FILE_INDEXED", path: ".env.example" },
    { type: "CARTOGRAPHER_FILE_IGNORED", path: ".env.production" },
    { type: "CARTOGRAPHER_FILE_IGNORED", path: ".git" },
    { type: "CARTOGRAPHER_FILE_INDEXED", path: ".gitignore" },
    { type: "CARTOGRAPHER_FILE_INDEXED", path: ".rectorignore" },
    { type: "CARTOGRAPHER_FILE_IGNORED", path: "dist" },
    { type: "CARTOGRAPHER_FILE_IGNORED", path: "linked-index.ts" },
    { type: "CARTOGRAPHER_FILE_IGNORED", path: "node_modules" },
    { type: "CARTOGRAPHER_FILE_INDEXED", path: "package.json" },
    { type: "CARTOGRAPHER_FILE_INDEXED", path: "src/app.test.ts" },
    { type: "CARTOGRAPHER_FILE_INDEXED", path: "src/app.ts" },
    { type: "CARTOGRAPHER_FILE_INDEXED", path: "src/index.ts" },
    { type: "CARTOGRAPHER_FILE_INDEXED", path: "tsconfig.json" },
    { type: "CARTOGRAPHER_FILE_DELETED", path: "docs/architecture.md" },
    { type: "CARTOGRAPHER_SCAN_COMPLETED", path: resolvedRoot },
  ];
}
