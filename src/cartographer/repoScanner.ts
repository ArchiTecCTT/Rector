import path from "node:path";
import { defaultFileReader, normalizeRepositoryPath } from "./fileReader";
import { hashViaReader } from "./fileHasher";
import { loadIgnoreMatchers, shouldIgnoreFile } from "./ignorePolicy";
import { assembleScanResult, buildFileNode, buildScanSummary } from "./scanResult";
import type { CartographerScanEmitter, CartographerScanEvent, FileNode, FileReader, IgnoredFileRef, ScanError, ScanOptions, ScanRepositoryInput, ScanResult } from "./types";
import { DEFAULT_HEAD_SNIFF_BYTES, DEFAULT_MAX_FILE_SIZE_BYTES } from "./types";

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

class RepositoryScanRootError extends Error { readonly name = "RepositoryScanRootError"; }

type MutableWalkState = {
  readonly repoRoot: string;
  readonly fileReader: FileReader;
  readonly gitignore: Awaited<ReturnType<typeof loadIgnoreMatchers>>["gitignore"];
  readonly rectorignore: Awaited<ReturnType<typeof loadIgnoreMatchers>>["rectorignore"];
  readonly maxFileSizeBytes: number;
  readonly headSniffBytes: number;
  readonly now: () => Date;
  readonly emitter?: CartographerScanEmitter;
  readonly included: WalkEntry[];
  readonly ignoredFiles: IgnoredFileRef[];
  readonly errors: ScanError[];
};

type ScanOutputEvent =
  | { readonly orderPath: string; readonly event: CartographerScanEvent }
  | { readonly orderPath: string; readonly file: FileNode };

type WalkEntryInput = {
  readonly parentDir: string;
  readonly basename: string;
  readonly direntSymlink: boolean;
};

export { defaultFileReader, normalizeRepositoryPath } from "./fileReader";

export async function emitSafely(emitter: CartographerScanEmitter | undefined, event: CartographerScanEvent): Promise<ScanError | undefined> {
  if (emitter === undefined) {
    return undefined;
  }
  try {
    await emitter(event);
    return undefined;
  } catch (error) {
    return { path: eventPath(event), stage: "store", message: `emitter failed: ${messageFromUnknown(error)}`, recoverable: true };
  }
}

export async function walkRepository(input: { readonly repoRoot: string } & ScanOptions): Promise<WalkResult> {
  const repoRoot = path.resolve(input.repoRoot);
  const now = input.now ?? (() => new Date());
  const fileReader = input.fileReader ?? defaultFileReader;
  await assertRootDirectory({ repoRoot, fileReader, emitter: input.emitter, now });
  const matchers = await loadIgnoreMatchers(repoRoot);
  const state: MutableWalkState = {
    repoRoot,
    fileReader,
    gitignore: matchers.gitignore,
    rectorignore: matchers.rectorignore,
    maxFileSizeBytes: input.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES,
    headSniffBytes: Math.min(input.headSniffBytes ?? DEFAULT_HEAD_SNIFF_BYTES, DEFAULT_HEAD_SNIFF_BYTES),
    now,
    emitter: input.emitter,
    included: [],
    ignoredFiles: [],
    errors: [...matchers.errors],
  };
  const rootEntries = await readDirectoryEntries(state, repoRoot, undefined);
  for (const entry of rootEntries) {
    await walkEntry(state, { parentDir: repoRoot, basename: entry.name, direntSymlink: entry.isSymbolicLink() });
  }
  return { included: state.included, ignoredFiles: state.ignoredFiles, errors: state.errors };
}

export async function scanRepository(input: ScanRepositoryInput): Promise<ScanResult> {
  const repoRoot = path.resolve(input.repoRoot);
  const now = input.now ?? (() => new Date());
  const errors: ScanError[] = [];
  await collectEmitterError(errors, input.emitter, { type: "CARTOGRAPHER_SCAN_STARTED", repoRoot, timestamp: now().toISOString() });
  try {
    const walk = await walkRepository({ ...input, repoRoot, emitter: undefined });
    errors.push(...walk.errors);
    const files: FileNode[] = [];
    const outputEvents: ScanOutputEvent[] = walk.ignoredFiles.map((ignoredFile) => ({
      orderPath: ignoredFile.path,
      event: { type: "CARTOGRAPHER_FILE_IGNORED", path: ignoredFile.path, ignoredFile, timestamp: now().toISOString() },
    }));
    for (const entry of walk.included) {
      const hashResult = await hashViaReader(input.fileReader ?? defaultFileReader, path.join(repoRoot, ...entry.normalizedPath.split("/")));
      if ("error" in hashResult) {
        errors.push(hashResult.error);
        continue;
      }
      const file = buildFileNode({ repoRoot, entry, hash: hashResult.hash, lastIndexedAt: now().toISOString() });
      files.push(file);
      outputEvents.push({ orderPath: file.normalizedPath, file });
    }
    const result = assembleScanResult({ repoRoot, files, ignoredFiles: walk.ignoredFiles, errors, now, changedFiles: files, deletedFiles: [] });
    await emitScanOutputEvents({ events: outputEvents, result, emitter: input.emitter, errors, now });
    return { ...result, errors };
  } catch (error) {
    const scanError = { path: repoRoot, stage: "walk", message: messageFromUnknown(error), recoverable: false } satisfies ScanError;
    await collectEmitterError(errors, input.emitter, { type: "CARTOGRAPHER_SCAN_FAILED", error: scanError, timestamp: now().toISOString() });
    throw error;
  }
}

async function assertRootDirectory(input: { readonly repoRoot: string; readonly fileReader: FileReader; readonly emitter?: CartographerScanEmitter; readonly now: () => Date }): Promise<void> {
  let stat: Awaited<ReturnType<FileReader["lstat"]>>;
  try {
    stat = await input.fileReader.lstat(input.repoRoot);
  } catch (error) {
    const scanError = { path: input.repoRoot, stage: "walk", message: messageFromUnknown(error), recoverable: false } satisfies ScanError;
    await emitSafely(input.emitter, { type: "CARTOGRAPHER_SCAN_FAILED", error: scanError, timestamp: input.now().toISOString() });
    throw error;
  }
  if (!stat.isDirectory()) {
    const err = new RepositoryScanRootError(`${input.repoRoot} is not a directory`);
    const scanError = { path: input.repoRoot, stage: "walk", message: err.message, recoverable: false } satisfies ScanError;
    await emitSafely(input.emitter, { type: "CARTOGRAPHER_SCAN_FAILED", error: scanError, timestamp: input.now().toISOString() });
    throw err;
  }
}

async function readDirectoryEntries(state: MutableWalkState, absoluteDir: string, normalizedDir: string | undefined): Promise<readonly { readonly name: string; readonly isSymbolicLink: () => boolean }[]> {
  try {
    const entries = await state.fileReader.readdir(absoluteDir);
    return [...entries].sort((left, right) => compareUtf16(left.name, right.name));
  } catch (error) {
    if (normalizedDir === undefined) {
      const scanError = { path: state.repoRoot, stage: "walk", message: messageFromUnknown(error), recoverable: false } satisfies ScanError;
      await emitSafely(state.emitter, { type: "CARTOGRAPHER_SCAN_FAILED", error: scanError, timestamp: state.now().toISOString() });
      throw error;
    }
    state.errors.push({ path: normalizedDir, stage: "walk", message: messageFromUnknown(error), recoverable: true });
    return [];
  }
}

async function walkEntry(state: MutableWalkState, input: WalkEntryInput): Promise<void> {
  const absolutePath = path.join(input.parentDir, input.basename);
  const normalizedPath = normalizeRepositoryPath(state.repoRoot, absolutePath);
  const stat = await lstatEntry(state, absolutePath, normalizedPath);
  if (stat === undefined) {
    return;
  }
  const pathIgnored = await applyIgnoreDecision(state, { normalizedPath, basename: input.basename, isDirectory: stat.isDirectory(), isSymlink: input.direntSymlink || stat.isSymbolicLink(), sizeBytes: stat.size });
  if (pathIgnored) {
    return;
  }
  if (stat.isDirectory()) {
    const entries = await readDirectoryEntries(state, absolutePath, normalizedPath);
    for (const entry of entries) {
      await walkEntry(state, { parentDir: absolutePath, basename: entry.name, direntSymlink: entry.isSymbolicLink() });
    }
    return;
  }
  const headBuffer = await readHeadSafely(state, absolutePath, normalizedPath);
  if (headBuffer === undefined) {
    return;
  }
  const headIgnored = await applyIgnoreDecision(state, { normalizedPath, basename: input.basename, isDirectory: false, isSymlink: false, sizeBytes: stat.size, headBuffer });
  if (!headIgnored) {
    state.included.push({ normalizedPath, basename: input.basename, sizeBytes: stat.size, mtimeMs: stat.mtimeMs });
  }
}

async function lstatEntry(state: MutableWalkState, absolutePath: string, normalizedPath: string): Promise<Awaited<ReturnType<FileReader["lstat"]>> | undefined> {
  try {
    return await state.fileReader.lstat(absolutePath);
  } catch (error) {
    state.errors.push({ path: normalizedPath, stage: "walk", message: messageFromUnknown(error), recoverable: true });
    return undefined;
  }
}

async function readHeadSafely(state: MutableWalkState, absolutePath: string, normalizedPath: string): Promise<Uint8Array | undefined> {
  try {
    return await state.fileReader.readHead(absolutePath, state.headSniffBytes);
  } catch (error) {
    state.errors.push({ path: normalizedPath, stage: "read", message: messageFromUnknown(error), recoverable: true });
    return undefined;
  }
}

async function applyIgnoreDecision(
  state: MutableWalkState,
  input: { readonly normalizedPath: string; readonly basename: string; readonly isDirectory: boolean; readonly isSymlink: boolean; readonly sizeBytes: number; readonly headBuffer?: Uint8Array },
): Promise<boolean> {
  const decision = shouldIgnoreFile({ ...input, gitignore: state.gitignore, rectorignore: state.rectorignore, maxFileSizeBytes: state.maxFileSizeBytes });
  if (!decision.ignored) {
    return false;
  }
  const ignoredFile = { path: input.normalizedPath, reason: decision.reason ?? decision.source, source: decision.source, isDirectory: input.isDirectory } satisfies IgnoredFileRef;
  state.ignoredFiles.push(ignoredFile);
  await collectEmitterError(state.errors, state.emitter, { type: "CARTOGRAPHER_FILE_IGNORED", path: ignoredFile.path, ignoredFile, timestamp: state.now().toISOString() });
  return true;
}

async function emitScanOutputEvents(input: { readonly events: readonly ScanOutputEvent[]; readonly result: ScanResult; readonly emitter?: CartographerScanEmitter; readonly errors: ScanError[]; readonly now: () => Date }): Promise<void> {
  const events = [...input.events].sort((left, right) => compareUtf16(left.orderPath, right.orderPath));
  for (const item of events) {
    const event = "event" in item ? item.event : { type: "CARTOGRAPHER_FILE_INDEXED", path: item.file.normalizedPath, file: item.file, timestamp: input.now().toISOString() } satisfies CartographerScanEvent;
    await collectEmitterError(input.errors, input.emitter, event);
  }
  await collectEmitterError(input.errors, input.emitter, { type: "CARTOGRAPHER_SCAN_COMPLETED", summary: buildScanSummary(input.result.snapshot), timestamp: input.now().toISOString() });
}

async function collectEmitterError(errors: ScanError[], emitter: CartographerScanEmitter | undefined, event: CartographerScanEvent): Promise<void> {
  const error = await emitSafely(emitter, event);
  if (error !== undefined) {
    errors.push(error);
  }
}

function eventPath(event: CartographerScanEvent): string {
  switch (event.type) {
    case "CARTOGRAPHER_SCAN_STARTED":
      return event.repoRoot;
    case "CARTOGRAPHER_FILE_INDEXED":
    case "CARTOGRAPHER_FILE_DELETED":
      return event.path;
    case "CARTOGRAPHER_FILE_IGNORED":
      return event.ignoredFile.path;
    case "CARTOGRAPHER_SCAN_COMPLETED":
      return event.summary.repoRoot;
    case "CARTOGRAPHER_SCAN_FAILED":
      return event.error.path;
    default: {
      return event satisfies never;
    }
  }
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : "unknown scan failure";
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
