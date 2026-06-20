import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryCartographerInventoryStore, scanChangedFiles, scanRepository, type CartographerScanEvent, type FileNode, type IgnoredFileRef, type ScanError } from "../../src/cartographer";
import { collectEvents, fixedNow, labelForEvent, makeSpyingReader, stripVolatile, tempRoots, type ScanEventLabel } from "./repoScannerTestHarness";

describe("Cartographer integration inventory slice", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  it("scans the brief fixture deterministically without reading ignored env secrets", async () => {
    // Given: the brief fixture repo with env secrets, env example, ignored dirs, docs, source, and config.
    const repoRoot = await makeBriefFixtureRepo();
    const { reader, headCalls, allCalls } = makeSpyingReader(repoRoot);
    const { events, emitter } = collectEvents();

    // When: two pinned full scans run, one with event capture and one without.
    const first = await scanRepository({ repoRoot, fileReader: reader, emitter, now: () => fixedNow });
    const second = await scanRepository({ repoRoot, now: () => fixedNow });

    // Then: indexed files, ignored refs, event order, env no-read safety, and snapshot determinism match the T9 contract.
    expect(first.files.map(pathOf)).toEqual(indexedPaths);
    expect(first.files.find((file) => file.normalizedPath === ".env.example")).toMatchObject({ kind: "config", language: "unknown" });
    expect(first.ignoredFiles).toEqual(expectedIgnoredFiles);
    expect(first.ignoredFiles.some((ignored) => ignored.path === "node_modules/ignored/index.js" || ignored.path === "dist/generated.js" || ignored.path === ".git/HEAD")).toBe(false);
    expect(first.files.some((file) => file.normalizedPath === "node_modules/ignored/index.js" || file.normalizedPath === "dist/generated.js" || file.normalizedPath === ".git/HEAD")).toBe(false);
    expect(events.map(labelForEvent)).toEqual(expectedFullEvents(repoRoot));
    expect(headCalls.filter(isSecretEnvRead)).toEqual([]);
    expect(allCalls.filter(isSecretEnvRead)).toEqual([]);
    expect(headCalls.map((call) => call.normalizedPath)).toContain(".env.example");
    expect(allCalls.map((call) => call.normalizedPath)).toContain(".env.example");
    expect(stripVolatile(first)).toEqual(stripVolatile(second));
    expect(first.snapshot.id).toBe(second.snapshot.id);
  });

  it("detects incremental additions and deletions with deterministic deletion events", async () => {
    // Given: the brief fixture has already been indexed into an in-memory store.
    const repoRoot = await makeBriefFixtureRepo();
    const store = new InMemoryCartographerInventoryStore({ now: () => fixedNow });
    const first = await scanChangedFiles({ repoRoot, store, now: () => fixedNow });

    // When: a file is added, then an existing file is deleted with events captured.
    await writeFixtureFile(repoRoot, "src/new.ts", "export const newValue = 1;\n");
    const added = await scanChangedFiles({ repoRoot, store, now: () => fixedNow });
    await fs.rm(path.join(repoRoot, "src", "app.ts"));
    const { events, emitter } = collectEvents();
    const deleted = await scanChangedFiles({ repoRoot, store, emitter, now: () => fixedNow });

    // Then: the first scan indexes all files, the add scan reports only the new file, and the deletion event follows sorted per-entry events.
    expect(first.changedFiles.map(pathOf)).toEqual(indexedPaths);
    expect(added.changedFiles.map(pathOf)).toEqual(["src/new.ts"]);
    expect(deleted.deletedFiles).toEqual(["src/app.ts"]);
    expect(events.map(labelForEvent)).toEqual(expectedIncrementalDeletionEvents(repoRoot));
  });

  it("keeps scan results identical without an emitter and with a no-op emitter", async () => {
    // Given: the brief fixture is unchanged and both scans share the same pinned clock.
    const repoRoot = await makeBriefFixtureRepo();

    // When: scanRepository runs once without an emitter and once with a no-op emitter.
    const noEmitter = await scanRepository({ repoRoot, now: () => fixedNow });
    const noopEmitter = await scanRepository({ repoRoot, emitter: () => {}, now: () => fixedNow });

    // Then: the full ScanResult remains byte-for-byte equal.
    expect(noopEmitter).toEqual(noEmitter);
  });

  it("records throwing emitter failures without altering indexed files or the snapshot", async () => {
    // Given: a baseline no-emitter result and an emitter that rejects every indexed-file event.
    const repoRoot = await makeBriefFixtureRepo();
    const noEmitter = await scanRepository({ repoRoot, now: () => fixedNow });

    // When: the throwing emitter observes the scan.
    const throwing = await scanRepository({ repoRoot, emitter: throwingIndexedEmitter, now: () => fixedNow });

    // Then: the scan completes, records recoverable store errors, and keeps files/snapshot unchanged.
    expect(throwing.errors.length).toBe(noEmitter.files.length);
    expect(throwing.errors.every(isRecoverableEmitterError)).toBe(true);
    expect(throwing.files).toEqual(noEmitter.files);
    expect(throwing.snapshot).toEqual(noEmitter.snapshot);
  });
});

const indexedPaths = [".env.example", ".gitignore", ".rectorignore", "docs/architecture.md", "package.json", "src/app.test.ts", "src/app.ts", "src/index.ts", "tsconfig.json"] as const;

const expectedIgnoredFiles = [
  { path: ".env", reason: "env file (never read)", source: "env", isDirectory: false },
  { path: ".env.local", reason: "env file (never read)", source: "env", isDirectory: false },
  { path: ".git", reason: "built-in ignore", source: "built_in", isDirectory: true },
  { path: "dist", reason: "built-in ignore", source: "built_in", isDirectory: true },
  { path: "node_modules", reason: "built-in ignore", source: "built_in", isDirectory: true },
] satisfies readonly IgnoredFileRef[];

function pathOf(file: FileNode): string { return file.normalizedPath; }

function isSecretEnvRead(call: { readonly normalizedPath: string }): boolean {
  return call.normalizedPath === ".env" || call.normalizedPath === ".env.local";
}

function throwingIndexedEmitter(event: CartographerScanEvent): void {
  if (event.type === "CARTOGRAPHER_FILE_INDEXED") throw new Error(`blocked ${event.path}`);
}

function isRecoverableEmitterError(error: ScanError): boolean {
  return error.stage === "store" && error.recoverable && error.message.startsWith("emitter failed:");
}

async function makeBriefFixtureRepo(): Promise<string> {
  const repoRoot = await fs.mkdtemp(path.join(tmpdir(), "rector-cartographer-integration-"));
  tempRoots.push(repoRoot);
  await writeFixtureFile(repoRoot, "package.json", "{\"name\":\"fixture\"}\n");
  await writeFixtureFile(repoRoot, "tsconfig.json", "{\"compilerOptions\":{}}\n");
  await writeFixtureFile(repoRoot, "src/index.ts", "export const indexValue = 1;\n");
  await writeFixtureFile(repoRoot, "src/app.ts", "export const appValue = 2;\n");
  await writeFixtureFile(repoRoot, "src/app.test.ts", "import './app';\n");
  await writeFixtureFile(repoRoot, "docs/architecture.md", "# Architecture\n");
  await writeFixtureFile(repoRoot, "node_modules/ignored/index.js", "module.exports = 1;\n");
  await writeFixtureFile(repoRoot, "dist/generated.js", "// Code generated by build\n");
  await writeFixtureFile(repoRoot, ".env", "SECRET=value\n");
  await writeFixtureFile(repoRoot, ".env.local", "LOCAL_SECRET=value\n");
  await writeFixtureFile(repoRoot, ".env.example", "EXAMPLE=value\n");
  await writeFixtureFile(repoRoot, ".gitignore", "ignored-by-git.txt\n");
  await writeFixtureFile(repoRoot, ".rectorignore", "ignored-by-rector.txt\n");
  await fs.mkdir(path.join(repoRoot, ".git"));
  return repoRoot;
}

async function writeFixtureFile(repoRoot: string, normalizedPath: string, contents: string): Promise<void> {
  const absolutePath = path.join(repoRoot, ...normalizedPath.split("/"));
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, contents, "utf8");
}

function expectedFullEvents(repoRoot: string): readonly ScanEventLabel[] {
  const resolvedRoot = path.resolve(repoRoot);
  return [
    { type: "CARTOGRAPHER_SCAN_STARTED", path: resolvedRoot },
    { type: "CARTOGRAPHER_FILE_IGNORED", path: ".env" },
    { type: "CARTOGRAPHER_FILE_INDEXED", path: ".env.example" },
    { type: "CARTOGRAPHER_FILE_IGNORED", path: ".env.local" },
    { type: "CARTOGRAPHER_FILE_IGNORED", path: ".git" },
    { type: "CARTOGRAPHER_FILE_INDEXED", path: ".gitignore" },
    { type: "CARTOGRAPHER_FILE_INDEXED", path: ".rectorignore" },
    { type: "CARTOGRAPHER_FILE_IGNORED", path: "dist" },
    { type: "CARTOGRAPHER_FILE_INDEXED", path: "docs/architecture.md" },
    { type: "CARTOGRAPHER_FILE_IGNORED", path: "node_modules" },
    { type: "CARTOGRAPHER_FILE_INDEXED", path: "package.json" },
    { type: "CARTOGRAPHER_FILE_INDEXED", path: "src/app.test.ts" },
    { type: "CARTOGRAPHER_FILE_INDEXED", path: "src/app.ts" },
    { type: "CARTOGRAPHER_FILE_INDEXED", path: "src/index.ts" },
    { type: "CARTOGRAPHER_FILE_INDEXED", path: "tsconfig.json" },
    { type: "CARTOGRAPHER_SCAN_COMPLETED", path: resolvedRoot },
  ];
}

function expectedIncrementalDeletionEvents(repoRoot: string): readonly ScanEventLabel[] {
  const resolvedRoot = path.resolve(repoRoot);
  return [
    { type: "CARTOGRAPHER_SCAN_STARTED", path: resolvedRoot },
    { type: "CARTOGRAPHER_FILE_IGNORED", path: ".env" },
    { type: "CARTOGRAPHER_FILE_INDEXED", path: ".env.example" },
    { type: "CARTOGRAPHER_FILE_IGNORED", path: ".env.local" },
    { type: "CARTOGRAPHER_FILE_IGNORED", path: ".git" },
    { type: "CARTOGRAPHER_FILE_INDEXED", path: ".gitignore" },
    { type: "CARTOGRAPHER_FILE_INDEXED", path: ".rectorignore" },
    { type: "CARTOGRAPHER_FILE_IGNORED", path: "dist" },
    { type: "CARTOGRAPHER_FILE_INDEXED", path: "docs/architecture.md" },
    { type: "CARTOGRAPHER_FILE_IGNORED", path: "node_modules" },
    { type: "CARTOGRAPHER_FILE_INDEXED", path: "package.json" },
    { type: "CARTOGRAPHER_FILE_INDEXED", path: "src/app.test.ts" },
    { type: "CARTOGRAPHER_FILE_INDEXED", path: "src/index.ts" },
    { type: "CARTOGRAPHER_FILE_INDEXED", path: "src/new.ts" },
    { type: "CARTOGRAPHER_FILE_INDEXED", path: "tsconfig.json" },
    { type: "CARTOGRAPHER_FILE_DELETED", path: "src/app.ts" },
    { type: "CARTOGRAPHER_SCAN_COMPLETED", path: resolvedRoot },
  ];
}
