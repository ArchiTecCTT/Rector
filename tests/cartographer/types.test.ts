import { describe, expect, it } from "vitest";
import {
  CartographerScanEventSchema,
  FileKindSchema,
  FileNodeSchema,
  IgnoreSourceSchema,
  ScanResultSchema,
  isCurrentlyIgnored,
  type CartographerScanEvent,
  type FileNode,
  type IgnoredFileRef,
  type RepoSnapshot,
  type ScanError,
  type ScanResult,
} from "../../src/cartographer";

const indexedAt = "2026-06-20T00:00:00.000Z";

const sampleFileNode = {
  id: "file-src-index",
  path: "src/index.ts",
  normalizedPath: "src/index.ts",
  hash: "abc123",
  sizeBytes: 128,
  mtimeMs: 1_234,
  language: "typescript",
  kind: "source",
  ignored: false,
  lastIndexedAt: indexedAt,
} satisfies FileNode;

const sampleSnapshot = {
  id: "snapshot-1",
  repoRoot: "/repo/root",
  createdAt: indexedAt,
  fileCount: 2,
  indexedFileCount: 1,
  ignoredFileCount: 1,
  deletedFileCount: 0,
  changedFileCount: 1,
} satisfies RepoSnapshot;

const sampleError = {
  path: "src/missing.ts",
  stage: "read",
  message: "cannot read file",
  recoverable: true,
} satisfies ScanError;

const sampleIgnoredFile = {
  path: "dist",
  reason: "built-in directory",
  source: "built_in",
  isDirectory: true,
} satisfies IgnoredFileRef;

const sampleScanResult = {
  snapshot: sampleSnapshot,
  files: [sampleFileNode],
  changedFiles: [sampleFileNode],
  deletedFiles: ["old/file.ts"],
  ignoredFiles: [sampleIgnoredFile],
  errors: [sampleError],
} satisfies ScanResult;

function eventLabel(event: CartographerScanEvent): string {
  switch (event.type) {
    case "CARTOGRAPHER_SCAN_STARTED":
      return event.repoRoot;
    case "CARTOGRAPHER_FILE_INDEXED":
      return event.file.normalizedPath;
    case "CARTOGRAPHER_FILE_IGNORED":
      return event.ignoredFile.path;
    case "CARTOGRAPHER_FILE_DELETED":
      return event.path;
    case "CARTOGRAPHER_SCAN_COMPLETED":
      return String(event.summary.fileCount);
    case "CARTOGRAPHER_SCAN_FAILED":
      return event.error.message;
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

describe("Cartographer T1 data model", () => {
  it("constructs core typed records with the expected key sets", () => {
    // Given: sample T1 values for the public data model.
    const event = {
      type: "CARTOGRAPHER_FILE_INDEXED",
      path: sampleFileNode.path,
      file: sampleFileNode,
      at: indexedAt,
    } satisfies CartographerScanEvent;

    // When: callers inspect the record shape and discriminate events.
    const fileKeys = Object.keys(sampleFileNode).sort();
    const resultKeys = Object.keys(sampleScanResult).sort();
    const label = eventLabel(event);

    // Then: the public shape is stable for T1 consumers.
    expect(fileKeys).toEqual([
      "hash",
      "id",
      "ignored",
      "kind",
      "language",
      "lastIndexedAt",
      "mtimeMs",
      "normalizedPath",
      "path",
      "sizeBytes",
    ]);
    expect(resultKeys).toEqual(["changedFiles", "deletedFiles", "errors", "files", "ignoredFiles", "snapshot"]);
    expect(label).toBe("src/index.ts");
  });

  it("keeps file paths as repo-relative normalized paths", () => {
    // Given: a sample node using the T1 path contract.
    const pathValues = [
      sampleFileNode.path,
      sampleFileNode.normalizedPath,
      sampleIgnoredFile.path,
      sampleScanResult.deletedFiles[0],
    ];

    // When: the values are checked for absolute path forms.
    const invalidPath = pathValues.find((path) => path.startsWith("/") || path.startsWith("./") || /^[A-Za-z]:/.test(path));

    // Then: every public path remains repo-relative POSIX text.
    expect(sampleFileNode.path).toBe(sampleFileNode.normalizedPath);
    expect(invalidPath).toBeUndefined();
  });

  it("detects exact ignored files and directory descendants", () => {
    // Given: one ignored file and one ignored directory.
    const ignoredFiles = [
      {
        path: "src/secret.ts",
        reason: "explicit ignore",
        source: "rectorignore",
        isDirectory: false,
      },
      sampleIgnoredFile,
    ] satisfies readonly IgnoredFileRef[];

    // When: current paths are compared against ignore refs.
    const exactFile = isCurrentlyIgnored("src/secret.ts", ignoredFiles);
    const directoryDescendant = isCurrentlyIgnored("dist/generated.js", ignoredFiles);
    const siblingPrefix = isCurrentlyIgnored("dist-other/generated.js", ignoredFiles);
    const fileDescendant = isCurrentlyIgnored("src/secret.ts/nested", ignoredFiles);

    // Then: exact-file and directory-descendant behavior are distinct.
    expect(exactFile).toBe(true);
    expect(directoryDescendant).toBe(true);
    expect(siblingPrefix).toBe(false);
    expect(fileDescendant).toBe(false);
  });

  it("rejects invalid runtime union values and mismatched path shapes", () => {
    // Given: runtime data from outside TypeScript's compiler guarantees.
    const invalidKind = "banana";
    const invalidSource = "custom-ignore";
    const mismatchedNode = {
      ...sampleFileNode,
      path: "src/other.ts",
    };

    // When: schemas parse the values at the boundary.
    const kindResult = FileKindSchema.safeParse(invalidKind);
    const sourceResult = IgnoreSourceSchema.safeParse(invalidSource);
    const fileNodeResult = FileNodeSchema.safeParse(mismatchedNode);
    const scanResult = ScanResultSchema.safeParse(sampleScanResult);

    // Then: invalid values fail without needing compiler-error comments.
    expect(kindResult.success).toBe(false);
    expect(sourceResult.success).toBe(false);
    expect(fileNodeResult.success).toBe(false);
    expect(scanResult.success).toBe(true);
  });

  it("validates every scan event runtime shape", () => {
    // Given: one representative event for each event variant.
    const events = [
      { type: "CARTOGRAPHER_SCAN_STARTED", repoRoot: "/repo/root", at: indexedAt },
      { type: "CARTOGRAPHER_FILE_INDEXED", path: "src/index.ts", file: sampleFileNode, at: indexedAt },
      { type: "CARTOGRAPHER_FILE_IGNORED", path: "dist", ignoredFile: sampleIgnoredFile, at: indexedAt },
      { type: "CARTOGRAPHER_FILE_DELETED", path: "old/file.ts", at: indexedAt },
      {
        type: "CARTOGRAPHER_SCAN_COMPLETED",
        summary: {
          fileCount: 2,
          indexedFileCount: 1,
          ignoredFileCount: 1,
          deletedFileCount: 0,
          changedFileCount: 1,
        },
        at: indexedAt,
      },
      { type: "CARTOGRAPHER_SCAN_FAILED", error: sampleError, at: indexedAt },
    ] satisfies readonly CartographerScanEvent[];

    // When: the event schema validates each variant.
    const parsedEvents = events.map((event) => CartographerScanEventSchema.safeParse(event));

    // Then: all known variants are accepted and an unknown type is rejected.
    expect(parsedEvents.every((event) => event.success)).toBe(true);
    expect(CartographerScanEventSchema.safeParse({ type: "CARTOGRAPHER_UNKNOWN", at: indexedAt }).success).toBe(false);
  });
});
