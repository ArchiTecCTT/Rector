import type { Dirent, Stats } from "node:fs";
import type { z } from "zod";
import type {
  FileKindSchema,
  IgnoreDecisionSchema,
  IgnoredFileRefSchema,
  IgnoreSourceSchema,
  LanguageIdSchema,
  RepoSnapshotSchema,
  ScanErrorSchema,
  ScanStageSchema,
  ScanSummarySchema,
} from "./schemas";

export const DEFAULT_MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_HEAD_SNIFF_BYTES = 8 * 1024;

export type FileKind = z.infer<typeof FileKindSchema>;
export type LanguageId = z.infer<typeof LanguageIdSchema>;
export type IgnoreSource = z.infer<typeof IgnoreSourceSchema>;
export type ScanStage = z.infer<typeof ScanStageSchema>;
export type IgnoreDecision = Readonly<z.infer<typeof IgnoreDecisionSchema>>;
export type FileNode = {
  readonly id: string;
  readonly path: string;
  readonly normalizedPath: string;
  readonly hash: string;
  readonly sizeBytes: number;
  readonly mtimeMs?: number;
  readonly language: LanguageId;
  readonly kind: FileKind;
  readonly ignored: boolean;
  readonly ignoreReason?: string;
  readonly lastIndexedAt: string;
};
export type RepoSnapshot = Readonly<z.infer<typeof RepoSnapshotSchema>>;
export type ScanError = Readonly<z.infer<typeof ScanErrorSchema>>;
export type IgnoredFileRef = Readonly<z.infer<typeof IgnoredFileRefSchema>>;
export type ScanResult = {
  readonly snapshot: RepoSnapshot;
  readonly files: readonly FileNode[];
  readonly changedFiles: readonly FileNode[];
  readonly deletedFiles: readonly string[];
  readonly ignoredFiles: readonly IgnoredFileRef[];
  readonly errors: readonly ScanError[];
};
export type ScanSummary = Readonly<z.infer<typeof ScanSummarySchema>>;

export type CartographerScanEvent =
  | { readonly type: "CARTOGRAPHER_SCAN_STARTED"; readonly repoRoot: string; readonly timestamp: string }
  | { readonly type: "CARTOGRAPHER_FILE_INDEXED"; readonly path: string; readonly file: FileNode; readonly timestamp: string }
  | {
      readonly type: "CARTOGRAPHER_FILE_IGNORED";
      readonly path: string;
      readonly ignoredFile: IgnoredFileRef;
      readonly timestamp: string;
    }
  | { readonly type: "CARTOGRAPHER_FILE_DELETED"; readonly path: string; readonly timestamp: string }
  | { readonly type: "CARTOGRAPHER_SCAN_COMPLETED"; readonly summary: ScanSummary; readonly timestamp: string }
  | { readonly type: "CARTOGRAPHER_SCAN_FAILED"; readonly error: ScanError; readonly timestamp: string };

export type CartographerScanEmitter = (event: CartographerScanEvent) => void | Promise<void>;

export type ScanOptions = {
  readonly maxFileSizeBytes?: number;
  /** Requested read-head bytes are hard-clamped to DEFAULT_HEAD_SNIFF_BYTES by scanners. */
  readonly headSniffBytes?: number;
  /** Optional weaker incremental mode: size+mtime matches may skip hashing. Default mode always hashes. */
  readonly fastPrecheck?: boolean;
  readonly fileReader?: FileReader;
  readonly emitter?: CartographerScanEmitter;
  readonly now?: () => Date;
};

export type ScanRepositoryInput = {
  readonly repoRoot: string;
} & ScanOptions;

export type ScanChangedFilesInput = {
  readonly repoRoot: string;
  readonly store: CartographerInventoryStore;
} & ScanOptions;

export type ClassifyFileInput = {
  readonly normalizedPath: string;
  readonly basename: string;
  readonly extension: string;
  readonly headBuffer?: Uint8Array;
};

export interface IgnoreMatcher {
  ignores(path: string): boolean;
}

export type IgnoreFileInput = {
  readonly normalizedPath: string;
  readonly basename: string;
  readonly isSymlink: boolean;
  readonly isDirectory: boolean;
  readonly sizeBytes: number;
  readonly headBuffer?: Uint8Array;
  readonly gitignore: IgnoreMatcher;
  readonly rectorignore: IgnoreMatcher;
  readonly maxFileSizeBytes: number;
};

export interface FileReader {
  lstat(path: string): Promise<Stats>;
  readdir(path: string): Promise<readonly Dirent[]>;
  readHead(path: string, maxBytes: number): Promise<Uint8Array>;
  readAll(path: string): Promise<Uint8Array>;
}

export type CreateSnapshotInput = {
  readonly repoRoot: string;
  readonly files: readonly FileNode[];
  readonly ignoredFiles: readonly IgnoredFileRef[];
  readonly deletedFiles?: readonly string[];
  readonly changedFiles?: readonly FileNode[];
  readonly id?: string;
  readonly createdAt?: string;
};

export interface CartographerInventoryStore {
  getLatestSnapshot(repoRoot: string): Promise<RepoSnapshot | undefined>;
  listSnapshots(repoRoot: string): Promise<readonly RepoSnapshot[]>;
  listFiles(repoRoot: string): Promise<readonly FileNode[]>;
  upsertFiles(repoRoot: string, files: readonly FileNode[]): Promise<void>;
  removeFiles(repoRoot: string, normalizedPaths: readonly string[]): Promise<void>;
  createSnapshot(input: CreateSnapshotInput): Promise<RepoSnapshot>;
  recordErrors(snapshotId: string, errors: readonly ScanError[]): Promise<void>;
  listErrors(snapshotId: string): Promise<readonly ScanError[]>;
  persistScanResult?(input: { repoRoot: string; result: ScanResult }): Promise<void>;
}

export type LoadIgnoreMatchersResult = {
  readonly gitignore: IgnoreMatcher;
  readonly rectorignore: IgnoreMatcher;
  readonly errors: readonly ScanError[];
};

export type EmitSafely = (
  emitter: CartographerScanEmitter | undefined,
  event: CartographerScanEvent,
) => Promise<ScanError | undefined>;

export type WalkEntry = {
  readonly normalizedPath: string;
  readonly basename: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
};

export type WalkResult = {
  readonly included: readonly WalkEntry[];
  readonly ignoredFiles: readonly IgnoredFileRef[];
  readonly errors: readonly ScanError[];
};

export function isCurrentlyIgnored(path: string, ignoredFiles: readonly IgnoredFileRef[]): boolean {
  return ignoredFiles.some((ref) => path === ref.path || (ref.isDirectory && path.startsWith(`${ref.path}/`)));
}
