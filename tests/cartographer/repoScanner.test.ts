import type { Dirent, Stats } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_HEAD_SNIFF_BYTES, scanRepository, type CartographerScanEmitter, type CartographerScanEvent, type FileReader, type IgnoredFileRef } from "../../src/cartographer";
import { normalizeRepositoryPath } from "../../src/cartographer/repoScanner";
import {
  collectEvents,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  fixedNow,
  isSortedUtf16,
  labelForEvent,
  makeFixtureRepo,
  makeNestedIgnoreLimitationRepo,
  makeSpyingReader,
  stripVolatile,
  tempRoots,
  writeOversizedFile,
  type ScanEventLabel,
} from "./repoScannerTestHarness";

describe("Cartographer T5 repo scanner", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  it("indexes, ignores, sorts, emits, and remains deterministic for the fixture repo", async () => {
    // Given: a fixture repo with source, config, docs, ignored dirs, env, and a symlink.
    const repoRoot = await makeFixtureRepo();
    const { reader, headCalls, allCalls } = makeSpyingReader(repoRoot);
    const { events, emitter } = collectEvents();

    // When: two full scans run with an injected clock and reader.
    const first = await scanRepository({ repoRoot, fileReader: reader, emitter, now: () => fixedNow });
    const second = await scanRepository({ repoRoot, fileReader: makeSpyingReader(repoRoot).reader, now: () => fixedNow });

    // Then: indexed files, ignored refs, counts, path shapes, event order, no-read safety, and determinism all match T5.
    expect(first.files.map((file) => file.normalizedPath)).toEqual([
      ".env.example",
      ".gitignore",
      ".rectorignore",
      "docs/architecture.md",
      "package.json",
      "src/app.test.ts",
      "src/app.ts",
      "src/index.ts",
      "tsconfig.json",
    ]);
    expect(first.files.find((file) => file.normalizedPath === ".env.example")).toMatchObject({ kind: "config", language: "unknown" });
    expect(first.files.every((file) => file.path === file.normalizedPath)).toBe(true);
    expect(first.files.some((file) => file.path.startsWith("/") || file.path.startsWith("./") || /^[A-Za-z]:/.test(file.path))).toBe(false);
    expect(isSortedUtf16(first.files.map((file) => file.normalizedPath))).toBe(true);
    expect(isSortedUtf16(first.changedFiles.map((file) => file.normalizedPath))).toBe(true);
    expect(isSortedUtf16(first.ignoredFiles.map((ignored) => ignored.path))).toBe(true);
    expect(first.ignoredFiles).toEqual([
      { path: ".env.production", reason: "env file (never read)", source: "env", isDirectory: false },
      { path: ".git", reason: "built-in ignore", source: "built_in", isDirectory: true },
      { path: "dist", reason: "built-in ignore", source: "built_in", isDirectory: true },
      { path: "linked-index.ts", reason: "symlink not followed", source: "symlink", isDirectory: false },
      { path: "node_modules", reason: "built-in ignore", source: "built_in", isDirectory: true },
    ] satisfies readonly IgnoredFileRef[]);
    expect(first.ignoredFiles.some((ignored) => ignored.path === "node_modules/ignored/index.js" || ignored.path === "dist/generated.js" || ignored.path === ".git/HEAD")).toBe(false);
    expect(first.files.some((file) => file.normalizedPath === "node_modules/ignored/index.js" || file.normalizedPath === "dist/generated.js" || file.normalizedPath === ".git/HEAD")).toBe(false);
    expect(first.snapshot).toMatchObject({ repoRoot: path.resolve(repoRoot), fileCount: 14, indexedFileCount: 9, ignoredFileCount: 5, deletedFileCount: 0, changedFileCount: 9 });
    expect(first.changedFiles.map((file) => file.normalizedPath)).toEqual(first.files.map((file) => file.normalizedPath));
    expect(first.deletedFiles).toEqual([]);
    expect(headCalls.some((call) => call.normalizedPath === ".env.production")).toBe(false);
    expect(allCalls.some((call) => call.normalizedPath === ".env.production")).toBe(false);
    expect(headCalls.some((call) => call.normalizedPath === ".env.example")).toBe(true);
    expect(allCalls.some((call) => call.normalizedPath === ".env.example")).toBe(true);
    expect(events.map(labelForEvent)).toEqual(expectedFixtureEvents(repoRoot));
    expect(stripVolatile(first)).toEqual(stripVolatile(second));
    expect(first.snapshot.id).toBe(second.snapshot.id);
  });

  it("normalizes backslash paths and caps head-sniff reads", async () => {
    // Given: a fixture repo and an intentionally oversized head-sniff request.
    const repoRoot = await makeFixtureRepo();
    const { reader, headCalls } = makeSpyingReader(repoRoot);

    // When: path normalization is applied and a scan requests a larger head buffer than the hard cap.
    const normalized = normalizeRepositoryPath("C:\\repo", "C:\\repo\\src\\index.ts");
    await scanRepository({ repoRoot, fileReader: reader, headSniffBytes: 1_000_000, now: () => fixedNow });

    // Then: paths are POSIX-normalized and every head read uses the default hard cap.
    expect(normalized).toBe("src/index.ts");
    expect(headCalls.length).toBeGreaterThan(0);
    expect(headCalls.every((call) => call.maxBytes === DEFAULT_HEAD_SNIFF_BYTES)).toBe(true);
  });

  it("rejects normalized paths that escape the repository root", () => {
    // Given: a repository root and a sibling path outside that root.
    const repoRoot = path.resolve("/repo/root");
    const outsidePath = path.resolve("/repo/outside.ts");

    // When/Then: normalization rejects paths outside the repository boundary.
    expect(() => normalizeRepositoryPath(repoRoot, outsidePath)).toThrow("Path escapes repository root");
  });

  it("continues after readAll, readHead, descendant readdir, and emitter failures", async () => {
    // Given: scanner dependencies that fail at each recoverable seam.
    const hashRoot = await makeFixtureRepo();
    const readRoot = await makeFixtureRepo();
    const walkRoot = await makeFixtureRepo();
    const emitRoot = await makeFixtureRepo();
    const throwingEmitter: CartographerScanEmitter = (event) => {
      if (event.type === "CARTOGRAPHER_FILE_INDEXED") {
        throw new Error(`blocked ${event.path}`);
      }
    };

    // When: each failure mode is scanned independently.
    const hashFailure = await scanRepository({ repoRoot: hashRoot, fileReader: makeSpyingReader(hashRoot, [{ method: "readAll", normalizedPath: "src/app.ts", message: "hash denied" }]).reader, now: () => fixedNow });
    const readFailure = await scanRepository({ repoRoot: readRoot, fileReader: makeSpyingReader(readRoot, [{ method: "readHead", normalizedPath: "src/app.ts", message: "head denied" }]).reader, now: () => fixedNow });
    const walkFailure = await scanRepository({ repoRoot: walkRoot, fileReader: makeSpyingReader(walkRoot, [{ method: "readdir", normalizedPath: "docs", message: "walk denied" }]).reader, now: () => fixedNow });
    const emitFailure = await scanRepository({ repoRoot: emitRoot, fileReader: makeSpyingReader(emitRoot).reader, emitter: throwingEmitter, now: () => fixedNow });

    // Then: scans complete, affected files are omitted only from the current result, and recoverable errors are recorded.
    expect(hashFailure.files.some((file) => file.normalizedPath === "src/app.ts")).toBe(false);
    expect(hashFailure.errors).toContainEqual({ path: path.join(path.resolve(hashRoot), "src", "app.ts"), stage: "hash", message: "hash denied", recoverable: true });
    expect(readFailure.files.some((file) => file.normalizedPath === "src/app.ts")).toBe(false);
    expect(readFailure.ignoredFiles.some((ignored) => ignored.path === "src/app.ts")).toBe(false);
    expect(readFailure.errors).toContainEqual({ path: "src/app.ts", stage: "read", message: "head denied", recoverable: true });
    expect(walkFailure.files.some((file) => file.normalizedPath === "docs/architecture.md")).toBe(false);
    expect(walkFailure.files.some((file) => file.normalizedPath === "src/index.ts")).toBe(true);
    expect(walkFailure.errors).toContainEqual({ path: "docs", stage: "walk", message: "walk denied", recoverable: true });
    expect(emitFailure.files.map((file) => file.normalizedPath)).toContain("src/app.ts");
    expect(emitFailure.errors.some((error) => error.stage === "store" && error.recoverable && error.message.startsWith("emitter failed:"))).toBe(true);
  });

  it("rejects and emits failed for a non-recoverable root lstat failure", async () => {
    // Given: a reader that cannot stat the root directory.
    const repoRoot = await makeFixtureRepo();
    const events: CartographerScanEvent[] = [];
    const reader: FileReader = rootFailureReader();

    // When/Then: the root failure rejects and emits exactly the failed scan event kind.
    await expect(
      scanRepository({
        repoRoot,
        fileReader: reader,
        emitter: (event) => {
          events.push(event);
        },
        now: () => fixedNow,
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(events.map((event) => event.type)).toEqual(["CARTOGRAPHER_SCAN_STARTED", "CARTOGRAPHER_SCAN_FAILED"]);
    expect(events[1]).toMatchObject({ type: "CARTOGRAPHER_SCAN_FAILED", error: { path: path.resolve(repoRoot), stage: "walk", message: "root denied", recoverable: false } });
  });

  it("ignores files above DEFAULT_MAX_FILE_SIZE_BYTES before calling readAll and records them exactly once with source size_limit", async () => {
    // Given: a repo containing one oversized file and a spying reader that throws on readAll for it.
    const repoRoot = await makeFixtureRepo();
    await writeOversizedFile(repoRoot, "oversized.bin");
    const { reader, allCalls } = makeSpyingReader(repoRoot, [
      { method: "readAll", normalizedPath: "oversized.bin", message: "readAll must not be called for oversized files" },
    ]);

    // When: the scanner runs.
    const result = await scanRepository({ repoRoot, fileReader: reader, now: () => fixedNow });

    // Then: scan succeeds, oversized file appears exactly once in ignoredFiles with source size_limit,
    // and the readAll spy proves the oversized file was never passed to readAll.
    expect(result.errors.some((e) => e.message.includes("readAll must not be called"))).toBe(false);
    const oversizedRefs = result.ignoredFiles.filter((ref) => ref.path === "oversized.bin");
    expect(oversizedRefs).toHaveLength(1);
    expect(oversizedRefs[0]).toEqual({ path: "oversized.bin", reason: `file exceeds ${DEFAULT_MAX_FILE_SIZE_BYTES} bytes`, source: "size_limit", isDirectory: false });
    expect(allCalls.some((call) => call.normalizedPath === "oversized.bin")).toBe(false);
  });

  it("applies root .gitignore and root .rectorignore but intentionally does not apply nested .gitignore (deferred limitation)", async () => {
    // Given: a repo with root ignores and a nested .gitignore inside a subdirectory.
    const repoRoot = await makeNestedIgnoreLimitationRepo();

    // When: the scanner runs.
    const result = await scanRepository({ repoRoot, now: () => fixedNow });

    // Then: root ignores are applied; the file covered only by the nested .gitignore is indexed (behavior is explicitly deferred).
    expect(result.ignoredFiles.some((ref) => ref.path === "root-ignored.txt" && ref.source === "gitignore")).toBe(true);
    expect(result.ignoredFiles.some((ref) => ref.path === "root-rector-ignored.txt" && ref.source === "rectorignore")).toBe(true);
    expect(result.files.some((f) => f.normalizedPath === "subdir/nested/nested-ignored.txt")).toBe(true);
    expect(result.ignoredFiles.some((ref) => ref.path === "subdir/nested/nested-ignored.txt")).toBe(false);
  });
});

function expectedFixtureEvents(repoRoot: string): readonly ScanEventLabel[] {
  const resolvedRoot = path.resolve(repoRoot);
  return [
    { type: "CARTOGRAPHER_SCAN_STARTED", path: resolvedRoot },
    { type: "CARTOGRAPHER_FILE_INDEXED", path: ".env.example" },
    { type: "CARTOGRAPHER_FILE_IGNORED", path: ".env.production" },
    { type: "CARTOGRAPHER_FILE_IGNORED", path: ".git" },
    { type: "CARTOGRAPHER_FILE_INDEXED", path: ".gitignore" },
    { type: "CARTOGRAPHER_FILE_INDEXED", path: ".rectorignore" },
    { type: "CARTOGRAPHER_FILE_IGNORED", path: "dist" },
    { type: "CARTOGRAPHER_FILE_INDEXED", path: "docs/architecture.md" },
    { type: "CARTOGRAPHER_FILE_IGNORED", path: "linked-index.ts" },
    { type: "CARTOGRAPHER_FILE_IGNORED", path: "node_modules" },
    { type: "CARTOGRAPHER_FILE_INDEXED", path: "package.json" },
    { type: "CARTOGRAPHER_FILE_INDEXED", path: "src/app.test.ts" },
    { type: "CARTOGRAPHER_FILE_INDEXED", path: "src/app.ts" },
    { type: "CARTOGRAPHER_FILE_INDEXED", path: "src/index.ts" },
    { type: "CARTOGRAPHER_FILE_INDEXED", path: "tsconfig.json" },
    { type: "CARTOGRAPHER_SCAN_COMPLETED", path: resolvedRoot },
  ];
}

function rootFailureReader(): FileReader {
  return {
    async lstat(_absolutePath: string): Promise<Stats> {
      throw new Error("root denied");
    },
    async readdir(_absolutePath: string): Promise<readonly Dirent[]> {
      throw new Error("unused readdir");
    },
    async readHead(_absolutePath: string, _maxBytes: number): Promise<Uint8Array> {
      throw new Error("unused readHead");
    },
    async readAll(_absolutePath: string): Promise<Uint8Array> {
      throw new Error("unused readAll");
    },
  };
}
