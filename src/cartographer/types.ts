import type { Dirent, Stats } from "node:fs";
import { z } from "zod";

export const DEFAULT_MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_HEAD_SNIFF_BYTES = 8 * 1024;

export const FileKindSchema = z.enum([
  "source",
  "test",
  "config",
  "doc",
  "generated",
  "fixture",
  "asset",
  "binary",
  "lockfile",
  "vendor",
  "unknown",
]);
export type FileKind = z.infer<typeof FileKindSchema>;

export const LanguageIdSchema = z.enum([
  "typescript",
  "javascript",
  "json",
  "markdown",
  "yaml",
  "css",
  "html",
  "shell",
  "text",
  "unknown",
]);
export type LanguageId = z.infer<typeof LanguageIdSchema>;

export const IgnoreSourceSchema = z.enum([
  "gitignore",
  "rectorignore",
  "built_in",
  "size_limit",
  "binary",
  "generated",
  "symlink",
  "env",
  "none",
]);
export type IgnoreSource = z.infer<typeof IgnoreSourceSchema>;

export const ScanStageSchema = z.enum(["walk", "read", "hash", "classify", "store"]);
export type ScanStage = z.infer<typeof ScanStageSchema>;

export const IgnoreDecisionSchema = z
  .object({
    ignored: z.boolean(),
    reason: z.string().optional(),
    source: IgnoreSourceSchema,
  })
  .strict();
export type IgnoreDecision = Readonly<z.infer<typeof IgnoreDecisionSchema>>;

// All Cartographer path fields are repo-relative POSIX normalizedPath values:
// no leading "/", "./", Windows drive letter, or absolute OS path.
export const FileNodeSchema = z
  .object({
    id: z.string().min(1),
    path: z.string().min(1),
    normalizedPath: z.string().min(1),
    hash: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    mtimeMs: z.number().nonnegative().optional(),
    language: LanguageIdSchema,
    kind: FileKindSchema,
    ignored: z.boolean(),
    ignoreReason: z.string().optional(),
    lastIndexedAt: z.string().datetime(),
  })
  .strict()
  .refine((node) => node.path === node.normalizedPath, {
    message: "path must equal normalizedPath",
    path: ["path"],
  });
export type FileNode = Readonly<z.infer<typeof FileNodeSchema>>;

export const RepoSnapshotSchema = z
  .object({
    id: z.string().min(1),
    repoRoot: z.string().min(1),
    createdAt: z.string().datetime(),
    fileCount: z.number().int().nonnegative(),
    indexedFileCount: z.number().int().nonnegative(),
    ignoredFileCount: z.number().int().nonnegative(),
    deletedFileCount: z.number().int().nonnegative().optional(),
    changedFileCount: z.number().int().nonnegative().optional(),
  })
  .strict();
export type RepoSnapshot = Readonly<z.infer<typeof RepoSnapshotSchema>>;

export const ScanErrorSchema = z
  .object({
    path: z.string(),
    stage: ScanStageSchema,
    message: z.string().min(1),
    recoverable: z.boolean(),
  })
  .strict();
export type ScanError = Readonly<z.infer<typeof ScanErrorSchema>>;

export const IgnoredFileRefSchema = z
  .object({
    path: z.string().min(1),
    reason: z.string().min(1),
    source: IgnoreSourceSchema,
    isDirectory: z.boolean(),
  })
  .strict();
export type IgnoredFileRef = Readonly<z.infer<typeof IgnoredFileRefSchema>>;

export const ScanResultSchema = z
  .object({
    snapshot: RepoSnapshotSchema,
    files: z.array(FileNodeSchema),
    changedFiles: z.array(FileNodeSchema),
    deletedFiles: z.array(z.string()),
    ignoredFiles: z.array(IgnoredFileRefSchema),
    errors: z.array(ScanErrorSchema),
  })
  .strict();
export type ScanResult = {
  readonly snapshot: RepoSnapshot;
  readonly files: readonly FileNode[];
  readonly changedFiles: readonly FileNode[];
  readonly deletedFiles: readonly string[];
  readonly ignoredFiles: readonly IgnoredFileRef[];
  readonly errors: readonly ScanError[];
};

export const ScanSummarySchema = z
  .object({
    fileCount: z.number().int().nonnegative(),
    indexedFileCount: z.number().int().nonnegative(),
    ignoredFileCount: z.number().int().nonnegative(),
    deletedFileCount: z.number().int().nonnegative(),
    changedFileCount: z.number().int().nonnegative(),
  })
  .strict();
export type ScanSummary = Readonly<z.infer<typeof ScanSummarySchema>>;

const EventAtSchema = z.object({ at: z.string().datetime() });
export const CartographerScanEventSchema = z.discriminatedUnion("type", [
  EventAtSchema.extend({ type: z.literal("CARTOGRAPHER_SCAN_STARTED"), repoRoot: z.string().min(1) }).strict(),
  EventAtSchema.extend({ type: z.literal("CARTOGRAPHER_FILE_INDEXED"), path: z.string().min(1), file: FileNodeSchema }).strict(),
  EventAtSchema.extend({
    type: z.literal("CARTOGRAPHER_FILE_IGNORED"),
    path: z.string().min(1),
    ignoredFile: IgnoredFileRefSchema,
  }).strict(),
  EventAtSchema.extend({ type: z.literal("CARTOGRAPHER_FILE_DELETED"), path: z.string().min(1) }).strict(),
  EventAtSchema.extend({ type: z.literal("CARTOGRAPHER_SCAN_COMPLETED"), summary: ScanSummarySchema }).strict(),
  EventAtSchema.extend({ type: z.literal("CARTOGRAPHER_SCAN_FAILED"), error: ScanErrorSchema }).strict(),
]);
export type CartographerScanEvent =
  | { readonly type: "CARTOGRAPHER_SCAN_STARTED"; readonly repoRoot: string; readonly at: string }
  | { readonly type: "CARTOGRAPHER_FILE_INDEXED"; readonly path: string; readonly file: FileNode; readonly at: string }
  | { readonly type: "CARTOGRAPHER_FILE_IGNORED"; readonly path: string; readonly ignoredFile: IgnoredFileRef; readonly at: string }
  | { readonly type: "CARTOGRAPHER_FILE_DELETED"; readonly path: string; readonly at: string }
  | { readonly type: "CARTOGRAPHER_SCAN_COMPLETED"; readonly summary: ScanSummary; readonly at: string }
  | { readonly type: "CARTOGRAPHER_SCAN_FAILED"; readonly error: ScanError; readonly at: string };

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
} & ScanOptions;

export type ClassifyFileInput = {
  readonly normalizedPath: string;
  readonly basename: string;
  readonly extension?: string;
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
