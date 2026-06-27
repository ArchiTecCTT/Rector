import { hashString } from "./fileHasher";

/**
 * Deterministic graph ID policy (Todo 12).
 * All IDs are content-addressable using normalized inputs + sha256 via existing hashString.
 * No random UUIDs, no timestamps, no Math.random, no OS-specific separators in IDs.
 */

export function normalizePath(p: string): string {
  if (typeof p !== "string") {
    return ".";
  }
  if (p.length === 0) {
    return ".";
  }
  // Normalize separators to POSIX, collapse multiples
  let s = p.replace(/\\/g, "/").replace(/\/+/g, "/");
  // Strip leading ./
  if (s.startsWith("./")) {
    s = s.slice(2);
  }
  // Trim trailing slash (but keep drive root semantics as "C:" would be unusual; treat "C:/" -> "C:")
  if (s.length > 1 && s.endsWith("/")) {
    s = s.slice(0, -1);
  }
  if (s === "" || s === "/") {
    return ".";
  }
  return s;
}

function repoRootHash(repoRoot: string): string {
  const norm = normalizePath(repoRoot);
  return hashString(norm);
}

export function computeRepoRootHash(repoRoot: string): string {
  return repoRootHash(repoRoot);
}

export function makeProjectId(repoRoot: string): string {
  return `project:${repoRootHash(repoRoot)}`;
}

export function makePackageId(repoRoot: string, packageDir: string): string {
  const dir = normalizePath(packageDir);
  return `package:${repoRootHash(repoRoot)}:${dir}`;
}

export function makeDirectoryId(repoRoot: string, normalizedPath: string): string {
  const p = normalizePath(normalizedPath);
  return `dir:${repoRootHash(repoRoot)}:${p}`;
}

export function makeFileId(repoRoot: string, normalizedPath: string): string {
  const p = normalizePath(normalizedPath);
  return `file:${repoRootHash(repoRoot)}:${p}`;
}

function buildSymbolIdParts(
  repoRoot: string,
  normalizedPath: string,
  isExported: boolean,
  name: string,
  startLine: number
): string {
  const p = normalizePath(normalizedPath);
  const marker = isExported ? "export" : "local";
  return `symbol:${repoRootHash(repoRoot)}:${p}:${marker}:${name}:${startLine}`;
}

export function makeSymbolId(
  repoRoot: string,
  normalizedPath: string,
  isExported: boolean,
  name: string,
  startLine: number
): string {
  return buildSymbolIdParts(repoRoot, normalizedPath, isExported, name, startLine);
}

export function makeToolId(name: string): string {
  return `tool:${name}`;
}

export function makeCapabilityId(name: string): string {
  return `capability:${name}`;
}

export function makeGraphSnapshotId(repoRoot: string, inventorySnapshotId: string): string {
  // Deterministic composite: hash the (normRoot + '|' + inventoryId) but keep inventoryId verbatim after for readability
  const key = `${normalizePath(repoRoot)}|${inventorySnapshotId}`;
  const h = hashString(key);
  return `snapshot:${h}:${inventorySnapshotId}`;
}

export function makeEdgeId(kind: string, fromNodeId: string, toNodeId: string): string {
  return `edge:${kind}:${fromNodeId}:${toNodeId}`;
}

export function makeImportEdgeId(fromFileId: string, targetSpecifier: string): string {
  return `edge:IMPORTS:${fromFileId}:${targetSpecifier}`;
}

export function makeDefinesEdgeId(fileId: string, symbolId: string): string {
  return `edge:DEFINES:${fileId}:${symbolId}`;
}
