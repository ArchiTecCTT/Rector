import { z } from "zod";

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

export const ScanStageSchema = z.enum(["walk", "read", "hash", "classify", "store"]);
export const IgnoreDecisionSchema = z.object({ ignored: z.boolean(), reason: z.string().optional(), source: IgnoreSourceSchema }).strict();
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
  .refine((node) => node.path === node.normalizedPath, { message: "path must equal normalizedPath", path: ["path"] });

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

export const ScanErrorSchema = z
  .object({ path: z.string(), stage: ScanStageSchema, message: z.string().min(1), recoverable: z.boolean() })
  .strict();
export const IgnoredFileRefSchema = z
  .object({ path: z.string().min(1), reason: z.string().min(1), source: IgnoreSourceSchema, isDirectory: z.boolean() })
  .strict();

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

export const ScanSummarySchema = z
  .object({
    repoRoot: z.string().min(1),
    fileCount: z.number().int().nonnegative(),
    indexedFileCount: z.number().int().nonnegative(),
    ignoredFileCount: z.number().int().nonnegative(),
    deletedFileCount: z.number().int().nonnegative(),
    changedFileCount: z.number().int().nonnegative(),
  })
  .strict();

const EventTimestampSchema = z.object({ timestamp: z.string().datetime() });
export const CartographerScanEventSchema = z.discriminatedUnion("type", [
  EventTimestampSchema.extend({ type: z.literal("CARTOGRAPHER_SCAN_STARTED"), repoRoot: z.string().min(1) }).strict(),
  EventTimestampSchema.extend({ type: z.literal("CARTOGRAPHER_FILE_INDEXED"), path: z.string().min(1), file: FileNodeSchema }).strict(),
  EventTimestampSchema.extend({
    type: z.literal("CARTOGRAPHER_FILE_IGNORED"),
    path: z.string().min(1),
    ignoredFile: IgnoredFileRefSchema,
  }).strict(),
  EventTimestampSchema.extend({ type: z.literal("CARTOGRAPHER_FILE_DELETED"), path: z.string().min(1) }).strict(),
  EventTimestampSchema.extend({ type: z.literal("CARTOGRAPHER_SCAN_COMPLETED"), summary: ScanSummarySchema }).strict(),
  EventTimestampSchema.extend({ type: z.literal("CARTOGRAPHER_SCAN_FAILED"), error: ScanErrorSchema }).strict(),
]);
