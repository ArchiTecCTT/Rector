import path from "node:path";
import { classifyFile } from "./fileClassifier";
import { hashString, hashViaReader } from "./fileHasher";
import { defaultFileReader, emitSafely, walkRepository, type WalkEntry } from "./repoScanner";
import { assembleScanResult, buildScanSummary } from "./scanResult";
import type { CartographerScanEmitter, CartographerScanEvent, FileNode, IgnoredFileRef, ScanChangedFilesInput, ScanError, ScanResult } from "./types";
import { isCurrentlyIgnored } from "./types";

type DiffResult = {
  readonly files: readonly FileNode[];
  readonly changedFiles: readonly FileNode[];
};

type OutputEvent =
  | { readonly orderPath: string; readonly event: CartographerScanEvent }
  | { readonly orderPath: string; readonly file: FileNode };

export async function scanChangedFiles(input: ScanChangedFilesInput): Promise<ScanResult> {
  const repoRoot = path.resolve(input.repoRoot);
  const now = input.now ?? (() => new Date());
  const errors: ScanError[] = [];
  await collectEmitterError(errors, input.emitter, { type: "CARTOGRAPHER_SCAN_STARTED", repoRoot, timestamp: now().toISOString() });
  try {
    const prior = mapFilesByPath(await input.store.listFiles(repoRoot));
    const walk = await walkRepository({ ...input, repoRoot, emitter: undefined });
    errors.push(...walk.errors);
    const diff = await diffCurrentFiles({ input, repoRoot, now, prior, included: walk.included, errors });
    const deletedFiles = removedInventoryPaths({ prior, currentNonIgnoredPaths: new Set(walk.included.map((entry) => entry.normalizedPath)), ignoredFiles: walk.ignoredFiles });
    const result = assembleScanResult({ repoRoot, files: diff.files, ignoredFiles: walk.ignoredFiles, errors, now, changedFiles: diff.changedFiles, deletedFiles });
    await emitOutputEvents({ emitter: input.emitter, errors, events: outputEvents(walk.ignoredFiles, diff.files), deletedFiles: result.deletedFiles, result, now });
    const finalResult = { ...result, errors } satisfies ScanResult;
    await persistResult({ store: input.store, repoRoot, result: finalResult });
    return finalResult;
  } catch (error) {
    const scanError = { path: repoRoot, stage: "walk", message: messageFromUnknown(error), recoverable: false } satisfies ScanError;
    await collectEmitterError(errors, input.emitter, { type: "CARTOGRAPHER_SCAN_FAILED", error: scanError, timestamp: now().toISOString() });
    throw error;
  }
}

async function diffCurrentFiles(input: {
  readonly input: ScanChangedFilesInput;
  readonly repoRoot: string;
  readonly now: () => Date;
  readonly prior: ReadonlyMap<string, FileNode>;
  readonly included: readonly WalkEntry[];
  readonly errors: ScanError[];
}): Promise<DiffResult> {
  const fileReader = input.input.fileReader ?? defaultFileReader;
  const files: FileNode[] = [];
  const changedFiles: FileNode[] = [];
  for (const entry of input.included) {
    const priorFile = input.prior.get(entry.normalizedPath);
    const fastUnchanged = input.input.fastPrecheck === true && priorFile !== undefined && priorFile.sizeBytes === entry.sizeBytes && priorFile.mtimeMs === entry.mtimeMs;
    const file = fastUnchanged ? priorFile : await buildHashedFile({ repoRoot: input.repoRoot, entry, fileReader, now: input.now, errors: input.errors });
    if (file === undefined) {
      continue;
    }
    files.push(file);
    if (priorFile === undefined || file.hash !== priorFile.hash) {
      changedFiles.push(file);
    }
  }
  return { files, changedFiles };
}

async function buildHashedFile(input: { readonly repoRoot: string; readonly entry: WalkEntry; readonly fileReader: ScanChangedFilesInput["fileReader"]; readonly now: () => Date; readonly errors: ScanError[] }): Promise<FileNode | undefined> {
  const absolutePath = path.join(input.repoRoot, ...input.entry.normalizedPath.split("/"));
  const hashResult = await hashViaReader(input.fileReader ?? defaultFileReader, absolutePath);
  if ("error" in hashResult) {
    input.errors.push(hashResult.error);
    return undefined;
  }
  return buildFileNode({ repoRoot: input.repoRoot, entry: input.entry, hash: hashResult.hash, lastIndexedAt: input.now().toISOString() });
}

function buildFileNode(input: { readonly repoRoot: string; readonly entry: WalkEntry; readonly hash: string; readonly lastIndexedAt: string }): FileNode {
  const extensionStart = input.entry.basename.lastIndexOf(".");
  const extension = extensionStart >= 0 ? input.entry.basename.slice(extensionStart + 1) : "";
  const classification = classifyFile({ normalizedPath: input.entry.normalizedPath, basename: input.entry.basename, extension });
  return {
    id: hashString(`${input.repoRoot}\u0000${input.entry.normalizedPath}`).slice(0, 16),
    path: input.entry.normalizedPath,
    normalizedPath: input.entry.normalizedPath,
    hash: input.hash,
    sizeBytes: input.entry.sizeBytes,
    mtimeMs: input.entry.mtimeMs,
    language: classification.language,
    kind: classification.kind,
    ignored: false,
    lastIndexedAt: input.lastIndexedAt,
  };
}

function removedInventoryPaths(input: { readonly prior: ReadonlyMap<string, FileNode>; readonly currentNonIgnoredPaths: ReadonlySet<string>; readonly ignoredFiles: readonly IgnoredFileRef[] }): string[] {
  const removed = new Set<string>();
  for (const priorPath of input.prior.keys()) {
    if (isCurrentlyIgnored(priorPath, input.ignoredFiles) || !input.currentNonIgnoredPaths.has(priorPath)) {
      removed.add(priorPath);
    }
  }
  return [...removed].sort(compareUtf16);
}

function outputEvents(ignoredFiles: readonly IgnoredFileRef[], files: readonly FileNode[]): readonly OutputEvent[] {
  return [
    ...ignoredFiles.map((ignoredFile) => ({ orderPath: ignoredFile.path, event: { type: "CARTOGRAPHER_FILE_IGNORED", path: ignoredFile.path, ignoredFile, timestamp: "" } satisfies CartographerScanEvent })),
    ...files.map((file) => ({ orderPath: file.normalizedPath, file })),
  ];
}

async function emitOutputEvents(input: { readonly emitter?: CartographerScanEmitter; readonly errors: ScanError[]; readonly events: readonly OutputEvent[]; readonly deletedFiles: readonly string[]; readonly result: ScanResult; readonly now: () => Date }): Promise<void> {
  for (const item of [...input.events].sort((left, right) => compareUtf16(left.orderPath, right.orderPath))) {
    const event = "event" in item ? { ...item.event, timestamp: input.now().toISOString() } : { type: "CARTOGRAPHER_FILE_INDEXED", path: item.file.normalizedPath, file: item.file, timestamp: input.now().toISOString() } satisfies CartographerScanEvent;
    await collectEmitterError(input.errors, input.emitter, event);
  }
  for (const deletedPath of input.deletedFiles) {
    await collectEmitterError(input.errors, input.emitter, { type: "CARTOGRAPHER_FILE_DELETED", path: deletedPath, timestamp: input.now().toISOString() });
  }
  await collectEmitterError(input.errors, input.emitter, { type: "CARTOGRAPHER_SCAN_COMPLETED", summary: buildScanSummary(input.result.snapshot), timestamp: input.now().toISOString() });
}

async function persistResult(input: { readonly store: ScanChangedFilesInput["store"]; readonly repoRoot: string; readonly result: ScanResult }): Promise<void> {
  await input.store.createSnapshot({ repoRoot: input.repoRoot, files: input.result.files, ignoredFiles: input.result.ignoredFiles, deletedFiles: input.result.deletedFiles, changedFiles: input.result.changedFiles, id: input.result.snapshot.id, createdAt: input.result.snapshot.createdAt });
  await input.store.recordErrors(input.result.snapshot.id, input.result.errors);
  await input.store.upsertFiles(input.repoRoot, input.result.files);
  await input.store.removeFiles(input.repoRoot, input.result.deletedFiles);
}

async function collectEmitterError(errors: ScanError[], emitter: CartographerScanEmitter | undefined, event: CartographerScanEvent): Promise<void> {
  const error = await emitSafely(emitter, event);
  if (error !== undefined) {
    errors.push(error);
  }
}

function mapFilesByPath(files: readonly FileNode[]): ReadonlyMap<string, FileNode> {
  return new Map(files.map((file) => [file.normalizedPath, file]));
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : "unknown scan failure";
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
