import { hashString } from "./fileHasher";
import type { FileNode, IgnoredFileRef, RepoSnapshot, ScanError, ScanResult, ScanSummary } from "./types";

export type AssembleScanResultInput = {
  readonly repoRoot: string;
  readonly files: readonly FileNode[];
  readonly ignoredFiles: readonly IgnoredFileRef[];
  readonly errors: readonly ScanError[];
  readonly now: () => Date;
  readonly changedFiles?: readonly FileNode[];
  readonly deletedFiles?: readonly string[];
};

export function assembleScanResult(input: AssembleScanResultInput): ScanResult {
  const files = sortByPath(input.files, (file) => file.normalizedPath);
  const changedFiles = sortByPath(input.changedFiles ?? files, (file) => file.normalizedPath);
  const ignoredFiles = sortByPath(input.ignoredFiles, (ignoredFile) => ignoredFile.path);
  const deletedFiles = [...(input.deletedFiles ?? [])].sort(compareUtf16);
  const createdAt = input.now().toISOString();
  const snapshot = buildSnapshot({ repoRoot: input.repoRoot, files, ignoredFiles, changedFiles, deletedFiles, createdAt });

  return { snapshot, files, changedFiles, deletedFiles, ignoredFiles, errors: input.errors };
}

export function buildScanSummary(snapshot: RepoSnapshot): ScanSummary {
  return {
    repoRoot: snapshot.repoRoot,
    fileCount: snapshot.fileCount,
    indexedFileCount: snapshot.indexedFileCount,
    ignoredFileCount: snapshot.ignoredFileCount,
    deletedFileCount: snapshot.deletedFileCount ?? 0,
    changedFileCount: snapshot.changedFileCount ?? 0,
  };
}

function buildSnapshot(input: {
  readonly repoRoot: string;
  readonly files: readonly FileNode[];
  readonly ignoredFiles: readonly IgnoredFileRef[];
  readonly changedFiles: readonly FileNode[];
  readonly deletedFiles: readonly string[];
  readonly createdAt: string;
}): RepoSnapshot {
  const fingerprintPayload = JSON.stringify(input.files.map((file) => [file.normalizedPath, file.hash]));
  return {
    id: hashString(fingerprintPayload),
    repoRoot: input.repoRoot,
    createdAt: input.createdAt,
    fileCount: input.files.length + input.ignoredFiles.length,
    indexedFileCount: input.files.length,
    ignoredFileCount: input.ignoredFiles.length,
    deletedFileCount: input.deletedFiles.length,
    changedFileCount: input.changedFiles.length,
  };
}

function sortByPath<T>(items: readonly T[], pathOf: (item: T) => string): T[] {
  return [...items].sort((left, right) => compareUtf16(pathOf(left), pathOf(right)));
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
