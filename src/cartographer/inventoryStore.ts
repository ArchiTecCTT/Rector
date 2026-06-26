import { hashString } from "./fileHasher";
import type { CartographerInventoryStore, CreateSnapshotInput, FileNode, RepoSnapshot, ScanError } from "./types";

export type InMemoryCartographerInventoryStoreOptions = {
  readonly now?: () => Date;
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryCartographerInventoryStore implements CartographerInventoryStore {
  private readonly filesByRepoRoot = new Map<string, Map<string, FileNode>>();
  private readonly snapshotsByRepoRoot = new Map<string, RepoSnapshot[]>();
  private readonly errorsBySnapshotId = new Map<string, ScanError[]>();

  constructor(private readonly options: InMemoryCartographerInventoryStoreOptions = {}) {}

  async getLatestSnapshot(repoRoot: string): Promise<RepoSnapshot | undefined> {
    const snapshots = await this.listSnapshots(repoRoot);
    return snapshots[0];
  }

  async listSnapshots(repoRoot: string): Promise<readonly RepoSnapshot[]> {
    return [...(this.snapshotsByRepoRoot.get(repoRoot) ?? [])]
      .sort(compareSnapshots)
      .map(clone);
  }

  async listFiles(repoRoot: string): Promise<readonly FileNode[]> {
    return [...(this.filesByRepoRoot.get(repoRoot)?.values() ?? [])]
      .sort((left, right) => compareUtf16(left.normalizedPath, right.normalizedPath))
      .map(clone);
  }

  async upsertFiles(repoRoot: string, files: readonly FileNode[]): Promise<void> {
    const repoFiles = this.repoFiles(repoRoot);
    for (const file of files) {
      if (file.ignored) {
        repoFiles.delete(file.normalizedPath);
      } else {
        repoFiles.set(file.normalizedPath, clone(file));
      }
    }
  }

  async removeFiles(repoRoot: string, normalizedPaths: readonly string[]): Promise<void> {
    const repoFiles = this.filesByRepoRoot.get(repoRoot);
    if (repoFiles === undefined) return;
    for (const normalizedPath of normalizedPaths) {
      repoFiles.delete(normalizedPath);
    }
  }

  async createSnapshot(input: CreateSnapshotInput): Promise<RepoSnapshot> {
    const createdAt = input.createdAt ?? this.now().toISOString();
    const files = input.files.map(clone);
    const ignoredFiles = input.ignoredFiles.map(clone);
    const deletedFiles = [...(input.deletedFiles ?? [])];
    const changedFiles = (input.changedFiles ?? files).map(clone);
    const id = input.id ?? hashString(JSON.stringify({ files: files.map((file) => [file.normalizedPath, file.hash]), createdAt }));
    const snapshot: RepoSnapshot = {
      id,
      repoRoot: input.repoRoot,
      createdAt,
      fileCount: files.length + ignoredFiles.length,
      indexedFileCount: files.length,
      ignoredFileCount: ignoredFiles.length,
      deletedFileCount: deletedFiles.length,
      changedFileCount: changedFiles.length,
    };
    const snapshots = this.repoSnapshots(input.repoRoot);
    snapshots.push(clone(snapshot));
    return clone(snapshot);
  }

  async recordErrors(snapshotId: string, errors: readonly ScanError[]): Promise<void> {
    const snapshotErrors = this.repoErrors(snapshotId);
    for (const error of errors) {
      snapshotErrors.push(clone(error));
    }
  }

  async listErrors(snapshotId: string): Promise<readonly ScanError[]> {
    return (this.errorsBySnapshotId.get(snapshotId) ?? []).map(clone);
  }

  async persistScanResult(input: { repoRoot: string; result: import("./types").ScanResult }): Promise<void> {
    await this.createSnapshot({
      repoRoot: input.repoRoot,
      files: input.result.files,
      ignoredFiles: input.result.ignoredFiles,
      deletedFiles: input.result.deletedFiles,
      changedFiles: input.result.changedFiles,
      id: input.result.snapshot.id,
      createdAt: input.result.snapshot.createdAt,
    });
    await this.recordErrors(input.result.snapshot.id, input.result.errors);
    await this.upsertFiles(input.repoRoot, input.result.files);
    await this.removeFiles(input.repoRoot, input.result.deletedFiles);
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private repoFiles(repoRoot: string): Map<string, FileNode> {
    const existing = this.filesByRepoRoot.get(repoRoot);
    if (existing !== undefined) return existing;
    const repoFiles = new Map<string, FileNode>();
    this.filesByRepoRoot.set(repoRoot, repoFiles);
    return repoFiles;
  }

  private repoSnapshots(repoRoot: string): RepoSnapshot[] {
    const existing = this.snapshotsByRepoRoot.get(repoRoot);
    if (existing !== undefined) return existing;
    const snapshots: RepoSnapshot[] = [];
    this.snapshotsByRepoRoot.set(repoRoot, snapshots);
    return snapshots;
  }

  private repoErrors(snapshotId: string): ScanError[] {
    const existing = this.errorsBySnapshotId.get(snapshotId);
    if (existing !== undefined) return existing;
    const errors: ScanError[] = [];
    this.errorsBySnapshotId.set(snapshotId, errors);
    return errors;
  }
}

function compareSnapshots(left: RepoSnapshot, right: RepoSnapshot): number {
  const createdAtOrder = compareUtf16(right.createdAt, left.createdAt);
  return createdAtOrder === 0 ? compareUtf16(left.id, right.id) : createdAtOrder;
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
