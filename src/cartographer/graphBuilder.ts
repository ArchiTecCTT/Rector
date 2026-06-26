import { readFile } from "node:fs/promises";
import path from "node:path";

import type { FileNode } from "./types";
import {
  makeDirectoryId,
  makeEdgeId,
  makeFileId,
  makeGraphSnapshotId,
  makePackageId,
  makeProjectId,
} from "./graphIds";
import type {
  CartographerGraphEdge,
  CartographerGraphNode,
  GraphSnapshot,
} from "./graphTypes";

export type BuildGraphInput = {
  readonly repoRoot: string;
  readonly inventorySnapshotId: string;
  readonly createdAt: string;
  readonly files: readonly FileNode[];
};

export type BuildGraphResult = {
  readonly snapshot: GraphSnapshot;
  readonly nodes: readonly CartographerGraphNode[];
  readonly edges: readonly CartographerGraphEdge[];
};

/**
 * Build the baseline file graph (Project, Package, Directory, File, Doc, Config, Test)
 * plus CONTAINS edges from a FileNode inventory.
 *
 * - Deterministic IDs via graphIds helpers.
 * - Output nodes and edges are sorted by id (UTF-16) independent of input order.
 * - Package label derives from package.json "name" when readable at repo root; falls back deterministically.
 * - File classification uses the pre-classified FileNode.kind (no symbol/import parsing).
 * - No random, no wall time, no mutation of inputs.
 */
export async function buildGraphSnapshot(input: BuildGraphInput): Promise<BuildGraphResult> {
  const { repoRoot, inventorySnapshotId, createdAt, files } = input;

  const pkgName = await readPackageNameSafe(repoRoot);
  const projectLabel = pkgName ?? deriveProjectLabel(repoRoot);
  const packageLabel = "package.json";

  const snapshotId = makeGraphSnapshotId(repoRoot, inventorySnapshotId);
  const projectId = makeProjectId(repoRoot);
  const packageId = makePackageId(repoRoot, ".");

  // Collect unique directory normalized paths (all ancestor dirs of files)
  const dirSet = new Set<string>();
  for (const f of files) {
    let p = f.normalizedPath;
    while (p.includes("/")) {
      p = p.slice(0, p.lastIndexOf("/"));
      if (p.length > 0 && p !== ".") {
        dirSet.add(p);
      }
    }
  }

  const nodes: CartographerGraphNode[] = [];

  nodes.push({
    id: projectId,
    snapshotId,
    kind: "Project",
    label: projectLabel,
    path: ".",
    normalizedPath: ".",
    properties: {},
  });

  nodes.push({
    id: packageId,
    snapshotId,
    kind: "Package",
    label: packageLabel,
    path: "package.json",
    normalizedPath: "package.json",
    properties: {},
  });

  for (const dir of [...dirSet].sort(compareUtf16)) {
    nodes.push({
      id: makeDirectoryId(repoRoot, dir),
      snapshotId,
      kind: "Directory",
      label: dir.split("/").pop() ?? dir,
      path: dir,
      normalizedPath: dir,
      properties: {},
    });
  }

  // Sort files for stable emission order before final id sort
  const sortedFiles = [...files].sort((a, b) => compareUtf16(a.normalizedPath, b.normalizedPath));

  for (const f of sortedFiles) {
    const gkind = fileKindToGraphKind(f.kind);
    nodes.push({
      id: makeFileId(repoRoot, f.normalizedPath),
      snapshotId,
      kind: gkind,
      label: f.normalizedPath.split("/").pop() ?? f.normalizedPath,
      path: f.normalizedPath,
      normalizedPath: f.normalizedPath,
      language: f.language,
      fileHash: f.hash,
      startLine: 1,
      properties: { kind: f.kind },
    });
  }

  const sortedNodes = [...nodes].sort((a, b) => compareUtf16(a.id, b.id));

  // Edges
  const edges: CartographerGraphEdge[] = [];

  // Project contains Package
  edges.push({
    id: makeEdgeId("CONTAINS", projectId, packageId),
    snapshotId,
    kind: "CONTAINS",
    fromNodeId: projectId,
    toNodeId: packageId,
    properties: {},
  });

  // Project contains each top-level dir; dir contains child dir
  for (const dir of [...dirSet].sort(compareUtf16)) {
    const dirId = makeDirectoryId(repoRoot, dir);
    const parent = parentOf(dir);
    const parentId = parent === "." ? projectId : makeDirectoryId(repoRoot, parent);
    edges.push({
      id: makeEdgeId("CONTAINS", parentId, dirId),
      snapshotId,
      kind: "CONTAINS",
      fromNodeId: parentId,
      toNodeId: dirId,
      properties: {},
    });
  }

  // Parent (dir or project) contains each file
  for (const f of sortedFiles) {
    const fileId = makeFileId(repoRoot, f.normalizedPath);
    const parent = parentOf(f.normalizedPath);
    const parentId = parent === "." ? projectId : makeDirectoryId(repoRoot, parent);
    edges.push({
      id: makeEdgeId("CONTAINS", parentId, fileId),
      snapshotId,
      kind: "CONTAINS",
      fromNodeId: parentId,
      toNodeId: fileId,
      properties: {},
    });
  }

  const sortedEdges = [...edges].sort((a, b) => compareUtf16(a.id, b.id));

  const snapshot: GraphSnapshot = {
    id: snapshotId,
    repoRoot,
    inventorySnapshotId,
    createdAt,
    nodeCount: sortedNodes.length,
    edgeCount: sortedEdges.length,
  };

  return {
    snapshot,
    nodes: sortedNodes,
    edges: sortedEdges,
  };
}

function hasOwnProp(o: unknown, k: string): o is Record<string, unknown> {
  return typeof o === "object" && o !== null && Object.prototype.hasOwnProperty.call(o, k);
}

async function readPackageNameSafe(repoRoot: string): Promise<string | undefined> {
  try {
    const pkgPath = path.join(repoRoot, "package.json");
    const txt = await readFile(pkgPath, "utf8");
    const parsed: unknown = JSON.parse(txt);
    let nameValue: unknown = undefined;
    if (hasOwnProp(parsed, "name")) {
      nameValue = parsed.name;
    }
    if (typeof nameValue === "string" && nameValue.trim().length > 0) {
      return nameValue.trim();
    }
  } catch {
    // missing, unreadable, or invalid JSON -> deterministic fallback (no error)
  }
  return undefined;
}

function deriveProjectLabel(repoRoot: string): string {
  const base = path.basename(repoRoot);
  if (base && base !== "." && base !== "/") {
    return base;
  }
  return "project";
}

function parentOf(normalizedPath: string): string {
  if (!normalizedPath.includes("/")) {
    return ".";
  }
  const p = normalizedPath.slice(0, normalizedPath.lastIndexOf("/"));
  return p.length > 0 ? p : ".";
}

function fileKindToGraphKind(k: FileNode["kind"]): CartographerGraphNode["kind"] {
  if (k === "test") return "Test";
  if (k === "doc") return "Doc";
  if (k === "config") return "Config";
  return "File";
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
