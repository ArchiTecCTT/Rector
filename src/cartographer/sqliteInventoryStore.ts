import { dirname } from "node:path";

import { ensureRestrictedDir, ensureRestrictedFile } from "../security/filePermissions";
import { DEFAULT_SQLITE_PATH } from "../store";
import { createSqliteDriver, type SqlDriver } from "../store/sqlRectorStore";
import { hashString } from "./fileHasher";
import type { CartographerInventoryStore, CreateSnapshotInput, FileNode, RepoSnapshot, ScanError } from "./types";

export type SqliteCartographerInventoryStoreOptions = {
  readonly driver?: SqlDriver;
  readonly path?: string;
  readonly now?: () => Date;
};

type SnapshotRow = {
  readonly id: string;
  readonly repo_root: string;
  readonly created_at: string;
  readonly file_count: number | bigint;
  readonly indexed_file_count: number | bigint;
  readonly ignored_file_count: number | bigint;
  readonly deleted_file_count: number | bigint | null;
  readonly changed_file_count: number | bigint | null;
};

type FileRow = {
  readonly id: string;
  readonly path: string;
  readonly normalized_path: string;
  readonly hash: string;
  readonly size_bytes: number | bigint;
  readonly mtime_ms: number | null;
  readonly language: FileNode["language"];
  readonly kind: FileNode["kind"];
  readonly ignored: number | bigint;
  readonly ignore_reason: string | null;
  readonly last_indexed_at: string;
};

type ErrorRow = {
  readonly path: string;
  readonly stage: ScanError["stage"];
  readonly message: string;
  readonly recoverable: number | bigint;
};

export class SqliteCartographerInventoryStore implements CartographerInventoryStore {
  private readonly driver: SqlDriver;
  private readonly nowFn: () => Date;

  constructor(options: SqliteCartographerInventoryStoreOptions = {}) {
    const path = options.path ?? DEFAULT_SQLITE_PATH;
    if (options.driver) {
      this.driver = options.driver;
    } else {
      if (path !== ":memory:") ensureRestrictedDir(dirname(path));
      this.driver = createSqliteDriver({ path });
      if (path !== ":memory:") ensureRestrictedFile(path);
    }
    this.nowFn = options.now ?? (() => new Date());
    this.migrate();
  }

  async getLatestSnapshot(repoRoot: string): Promise<RepoSnapshot | undefined> {
    const row = this.driver.get<SnapshotRow>(
      `SELECT id, repo_root, created_at, file_count, indexed_file_count, ignored_file_count, deleted_file_count, changed_file_count
       FROM cartographer_snapshots WHERE repo_root = ? ORDER BY created_at DESC, id ASC LIMIT 1`,
      [repoRoot],
    );
    return row === undefined ? undefined : snapshotFromRow(row);
  }

  async listSnapshots(repoRoot: string): Promise<readonly RepoSnapshot[]> {
    return this.driver
      .all<SnapshotRow>(
        `SELECT id, repo_root, created_at, file_count, indexed_file_count, ignored_file_count, deleted_file_count, changed_file_count
         FROM cartographer_snapshots WHERE repo_root = ? ORDER BY created_at DESC, id ASC`,
        [repoRoot],
      )
      .map(snapshotFromRow);
  }

  async listFiles(repoRoot: string): Promise<readonly FileNode[]> {
    return this.driver
      .all<FileRow>(
        `SELECT id, path, normalized_path, hash, size_bytes, mtime_ms, language, kind, ignored, ignore_reason, last_indexed_at
         FROM cartographer_files WHERE repo_root = ? ORDER BY normalized_path ASC`,
        [repoRoot],
      )
      .map(fileFromRow);
  }

  async upsertFiles(repoRoot: string, files: readonly FileNode[]): Promise<void> {
    for (const file of files) {
      if (file.ignored) {
        this.driver.run("DELETE FROM cartographer_files WHERE repo_root = ? AND normalized_path = ?", [repoRoot, file.normalizedPath]);
      } else {
        this.upsertFile(repoRoot, file);
      }
    }
  }

  async removeFiles(repoRoot: string, normalizedPaths: readonly string[]): Promise<void> {
    if (normalizedPaths.length === 0) return;
    const placeholders = normalizedPaths.map(() => "?").join(", ");
    this.driver.run(`DELETE FROM cartographer_files WHERE repo_root = ? AND normalized_path IN (${placeholders})`, [repoRoot, ...normalizedPaths]);
  }

  async createSnapshot(input: CreateSnapshotInput): Promise<RepoSnapshot> {
    const createdAt = input.createdAt ?? this.nowFn().toISOString();
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
    this.driver.run(
      `INSERT INTO cartographer_snapshots (id, repo_root, created_at, file_count, indexed_file_count, ignored_file_count, deleted_file_count, changed_file_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [snapshot.id, snapshot.repoRoot, snapshot.createdAt, snapshot.fileCount, snapshot.indexedFileCount, snapshot.ignoredFileCount, snapshot.deletedFileCount, snapshot.changedFileCount],
    );
    return clone(snapshot);
  }

  async recordErrors(snapshotId: string, errors: readonly ScanError[]): Promise<void> {
    if (errors.length === 0) return;
    const row = this.driver.get<{ next: number | bigint }>(
      "SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM cartographer_scan_errors WHERE snapshot_id = ?",
      [snapshotId],
    );
    let seq = Number(row?.next ?? 0);
    for (const error of errors) {
      this.driver.run(
        `INSERT INTO cartographer_scan_errors (snapshot_id, seq, path, stage, message, recoverable, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [snapshotId, seq, error.path, error.stage, error.message, error.recoverable ? 1 : 0, this.nowFn().toISOString()],
      );
      seq += 1;
    }
  }

  async listErrors(snapshotId: string): Promise<readonly ScanError[]> {
    return this.driver
      .all<ErrorRow>(
        "SELECT path, stage, message, recoverable FROM cartographer_scan_errors WHERE snapshot_id = ? ORDER BY seq ASC, id ASC",
        [snapshotId],
      )
      .map(errorFromRow);
  }

  private migrate(): void {
    this.driver.exec("CREATE TABLE IF NOT EXISTS cartographer_snapshots(id TEXT PRIMARY KEY, repo_root TEXT NOT NULL, created_at TEXT NOT NULL, file_count INTEGER NOT NULL, indexed_file_count INTEGER NOT NULL, ignored_file_count INTEGER NOT NULL, deleted_file_count INTEGER, changed_file_count INTEGER)");
    this.driver.exec("CREATE TABLE IF NOT EXISTS cartographer_files(id TEXT NOT NULL, repo_root TEXT NOT NULL, path TEXT NOT NULL, normalized_path TEXT NOT NULL, hash TEXT NOT NULL, size_bytes INTEGER NOT NULL, mtime_ms REAL, language TEXT NOT NULL, kind TEXT NOT NULL, ignored INTEGER NOT NULL DEFAULT 0, ignore_reason TEXT, last_indexed_at TEXT NOT NULL, PRIMARY KEY(repo_root, normalized_path))");
    this.driver.exec("CREATE TABLE IF NOT EXISTS cartographer_scan_errors(id INTEGER PRIMARY KEY, snapshot_id TEXT NOT NULL, seq INTEGER NOT NULL, path TEXT NOT NULL, stage TEXT NOT NULL, message TEXT NOT NULL, recoverable INTEGER NOT NULL, created_at TEXT NOT NULL)");
  }

  private upsertFile(repoRoot: string, file: FileNode): void {
    this.driver.run(
      `INSERT INTO cartographer_files (id, repo_root, path, normalized_path, hash, size_bytes, mtime_ms, language, kind, ignored, ignore_reason, last_indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
       ON CONFLICT(repo_root, normalized_path) DO UPDATE SET id = excluded.id, path = excluded.path, hash = excluded.hash, size_bytes = excluded.size_bytes, mtime_ms = excluded.mtime_ms, language = excluded.language, kind = excluded.kind, ignored = 0, ignore_reason = NULL, last_indexed_at = excluded.last_indexed_at`,
      [file.id, repoRoot, file.path, file.normalizedPath, file.hash, file.sizeBytes, file.mtimeMs ?? null, file.language, file.kind, file.lastIndexedAt],
    );
  }
}

function snapshotFromRow(row: SnapshotRow): RepoSnapshot {
  return { id: row.id, repoRoot: row.repo_root, createdAt: row.created_at, fileCount: Number(row.file_count), indexedFileCount: Number(row.indexed_file_count), ignoredFileCount: Number(row.ignored_file_count), deletedFileCount: numberOrUndefined(row.deleted_file_count), changedFileCount: numberOrUndefined(row.changed_file_count) };
}

function fileFromRow(row: FileRow): FileNode {
  return { id: row.id, path: row.path, normalizedPath: row.normalized_path, hash: row.hash, sizeBytes: Number(row.size_bytes), ...(row.mtime_ms === null ? {} : { mtimeMs: row.mtime_ms }), language: row.language, kind: row.kind, ignored: Number(row.ignored) === 1, ...(row.ignore_reason === null ? {} : { ignoreReason: row.ignore_reason }), lastIndexedAt: row.last_indexed_at };
}

function errorFromRow(row: ErrorRow): ScanError {
  return { path: row.path, stage: row.stage, message: row.message, recoverable: Number(row.recoverable) === 1 };
}

function numberOrUndefined(value: number | bigint | null): number | undefined {
  return value === null ? undefined : Number(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
