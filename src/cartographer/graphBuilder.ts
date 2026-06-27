import { readFile } from "node:fs/promises";
import path from "node:path";

import type { FileNode } from "./types";
import {
  makeDefinesEdgeId,
  makeDirectoryId,
  makeEdgeId,
  makeFileId,
  makeGraphSnapshotId,
  makeImportEdgeId,
  makePackageId,
  makeProjectId,
  makeSymbolId,
  normalizePath,
} from "./graphIds";
import {
  extractImports,
} from "./importExtractor";
import {
  extractTsSymbols,
  type SymbolKind,
} from "./tsSymbolExtractor";
import {
  findTests,
} from "./testLinker";
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
  /**
   * Optional provider for file source text (normalized path -> source).
   * When supplied, the builder runs deterministic symbol/import/test extraction
   * and emits structural nodes (Symbol/Function/Class/Interface/TypeAlias/Enum/Package/Test)
   * and edges (DEFINES/IMPORTS/EXPORTS/DEPENDS_ON/TESTS) in addition to baseline.
   */
  readonly getSourceText?: (normalizedPath: string) => string | undefined;
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
  const { repoRoot, inventorySnapshotId, createdAt, files, getSourceText } = input;

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

  // Structural extraction (only when getSourceText provided)
  const indexedNormalized = sortedFiles.map((f) => normalizePath(f.normalizedPath));

  const edges: CartographerGraphEdge[] = [];

  // Baseline CONTAINS edges (Project, dirs, files) — must be emitted even without structural extraction
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

  // Collect structural nodes/edges deterministically
  const structuralNodes: CartographerGraphNode[] = [];
  const structuralEdges: CartographerGraphEdge[] = [];

  // Bare package nodes discovered from imports (deduped by specifier)
  const barePackages = new Map<string, string>(); // specifier -> packageId

  // For each file, run extractors if source available
  for (const f of sortedFiles) {
    const src = getSourceText ? getSourceText(f.normalizedPath) : undefined;
    if (src === undefined) continue;
    // C2: structural extraction is for TS/JS files only; skip docs/config/JSON/etc.
    if (f.language !== "typescript" && f.language !== "javascript") continue;

    const fileId = makeFileId(repoRoot, f.normalizedPath);

    // Symbols -> Symbol + kinded nodes + DEFINES + EXPORTS
    const symRes = extractTsSymbols({ filePath: f.normalizedPath, sourceText: src });
    for (const s of symRes.symbols) {
      const symId = makeSymbolId(repoRoot, f.normalizedPath, s.isExported, s.name, s.startLine);
      const kinded = symbolKindToNodeKind(s.kind);
      structuralNodes.push({
        id: symId,
        snapshotId,
        kind: kinded,
        label: s.name,
        path: f.normalizedPath,
        normalizedPath: f.normalizedPath,
        symbolName: s.name,
        symbolKind: s.kind,
        language: f.language,
        fileHash: f.hash,
        startLine: s.startLine,
        endLine: s.endLine,
        properties: { isExported: s.isExported },
      });
      // DEFINES from file to symbol
      structuralEdges.push({
        id: makeDefinesEdgeId(fileId, symId),
        snapshotId,
        kind: "DEFINES",
        fromNodeId: fileId,
        toNodeId: symId,
        evidence: { path: f.normalizedPath, startLine: s.startLine, endLine: s.endLine, text: s.evidence },
        properties: {},
      });
      // EXPORTS for exported symbols
      if (s.isExported) {
        structuralEdges.push({
          id: makeEdgeId("EXPORTS", fileId, symId),
          snapshotId,
          kind: "EXPORTS",
          fromNodeId: fileId,
          toNodeId: symId,
          evidence: { path: f.normalizedPath, startLine: s.startLine, endLine: s.endLine, text: s.evidence },
          properties: {},
        });
      }
    }

    // Imports/exports -> IMPORTS / DEPENDS_ON / EXPORTS (for export-from) + bare Package nodes
    const impRes = extractImports({ filePath: f.normalizedPath, sourceText: src, indexedFiles: indexedNormalized });
    for (const rec of impRes.imports) {
      const edgeId = makeImportEdgeId(fileId, rec.specifier);
      if (rec.target.kind === "file") {
        const toFileId = makeFileId(repoRoot, rec.target.normalizedPath);
        structuralEdges.push({
          id: edgeId,
          snapshotId,
          kind: "IMPORTS",
          fromNodeId: fileId,
          toNodeId: toFileId,
          evidence: { path: f.normalizedPath, startLine: rec.startLine, endLine: rec.endLine, text: rec.evidence },
          properties: { specifier: rec.specifier },
        });
        // DEPENDS_ON for resolved local imports
        structuralEdges.push({
          id: makeEdgeId("DEPENDS_ON", fileId, toFileId),
          snapshotId,
          kind: "DEPENDS_ON",
          fromNodeId: fileId,
          toNodeId: toFileId,
          evidence: { path: f.normalizedPath, startLine: rec.startLine, endLine: rec.endLine, text: rec.evidence },
          properties: { specifier: rec.specifier },
        });
      } else if (rec.target.kind === "package") {
        // Bare package node (synthetic, only for bare specifiers from imports)
        let pkgNodeId = barePackages.get(rec.target.specifier);
        if (!pkgNodeId) {
          pkgNodeId = makePackageId(repoRoot, rec.target.specifier);
          barePackages.set(rec.target.specifier, pkgNodeId);
          structuralNodes.push({
            id: pkgNodeId,
            snapshotId,
            kind: "Package",
            label: rec.target.specifier,
            path: rec.target.specifier,
            normalizedPath: rec.target.specifier,
            properties: { bare: true },
          });
        }
        structuralEdges.push({
          id: edgeId,
          snapshotId,
          kind: "IMPORTS",
          fromNodeId: fileId,
          toNodeId: pkgNodeId,
          evidence: { path: f.normalizedPath, startLine: rec.startLine, endLine: rec.endLine, text: rec.evidence },
          properties: { specifier: rec.specifier },
        });
        structuralEdges.push({
          id: makeEdgeId("DEPENDS_ON", fileId, pkgNodeId),
          snapshotId,
          kind: "DEPENDS_ON",
          fromNodeId: fileId,
          toNodeId: pkgNodeId,
          evidence: { path: f.normalizedPath, startLine: rec.startLine, endLine: rec.endLine, text: rec.evidence },
          properties: { specifier: rec.specifier },
        });
      }

      // EXPORTS for export-from
      if (rec.kind === "exportFrom") {
        if (rec.target.kind === "file") {
          const toFileId = makeFileId(repoRoot, rec.target.normalizedPath);
          structuralEdges.push({
            id: makeEdgeId("EXPORTS", fileId, toFileId),
            snapshotId,
            kind: "EXPORTS",
            fromNodeId: fileId,
            toNodeId: toFileId,
            evidence: { path: f.normalizedPath, startLine: rec.startLine, endLine: rec.endLine, text: rec.evidence },
            properties: { specifier: rec.specifier },
          });
        } else if (rec.target.kind === "package") {
          let pkgNodeId = barePackages.get(rec.target.specifier);
          if (!pkgNodeId) {
            pkgNodeId = makePackageId(repoRoot, rec.target.specifier);
            barePackages.set(rec.target.specifier, pkgNodeId);
            structuralNodes.push({
              id: pkgNodeId,
              snapshotId,
              kind: "Package",
              label: rec.target.specifier,
              path: rec.target.specifier,
              normalizedPath: rec.target.specifier,
              properties: { bare: true },
            });
          }
          structuralEdges.push({
            id: makeEdgeId("EXPORTS", fileId, pkgNodeId),
            snapshotId,
            kind: "EXPORTS",
            fromNodeId: fileId,
            toNodeId: pkgNodeId,
            evidence: { path: f.normalizedPath, startLine: rec.startLine, endLine: rec.endLine, text: rec.evidence },
            properties: { specifier: rec.specifier },
          });
        }
      }
    }
  }

  // Emit TESTS edges from findTests evidence (import-first, basename fallback)
  // C3: compute links once per source file (findTests result is independent of the test file).
  if (getSourceText) {
    const testFileSet = new Set(sortedFiles.filter((f) => f.kind === "test").map((f) => f.normalizedPath));
    for (const srcFile of sortedFiles) {
      if (srcFile.kind === "test") continue;
      const srcText = getSourceText(srcFile.normalizedPath);
      if (srcText === undefined) continue;
      const linkRes = findTests({
        targetNormalizedPath: srcFile.normalizedPath,
        indexedFiles: indexedNormalized,
        getSourceText: (p) => getSourceText(p),
      });
      for (const lt of linkRes.linkedTests) {
        if (!testFileSet.has(lt.normalizedPath)) continue;
        const testFileId = makeFileId(repoRoot, lt.normalizedPath);
        const targetFileId = makeFileId(repoRoot, srcFile.normalizedPath);
        structuralEdges.push({
          id: makeEdgeId("TESTS", testFileId, targetFileId),
          snapshotId,
          kind: "TESTS",
          fromNodeId: testFileId,
          toNodeId: targetFileId,
          evidence: { path: lt.normalizedPath, text: lt.evidence },
          properties: { relation: lt.relation },
        });
      }
    }
  }

  // Merge structural nodes/edges into main collections (dedup by id for nodes, by id for edges)
  const nodeById = new Map<string, CartographerGraphNode>();
  for (const n of nodes) nodeById.set(n.id, n);
  for (const n of structuralNodes) {
    if (!nodeById.has(n.id)) nodeById.set(n.id, n);
  }
  const mergedNodes = [...nodeById.values()];

  const edgeById = new Map<string, CartographerGraphEdge>();
  for (const e of edges) edgeById.set(e.id, e);
  for (const e of structuralEdges) {
    if (!edgeById.has(e.id)) edgeById.set(e.id, e);
  }
  const mergedEdges = [...edgeById.values()];

  const sortedNodes = [...mergedNodes].sort((a, b) => compareUtf16(a.id, b.id));
  const sortedEdges = [...mergedEdges].sort((a, b) => compareUtf16(a.id, b.id));

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

function symbolKindToNodeKind(k: SymbolKind): CartographerGraphNode["kind"] {
  if (k === "function") return "Function";
  if (k === "class") return "Class";
  if (k === "interface") return "Interface";
  if (k === "typeAlias") return "TypeAlias";
  if (k === "enum") return "Enum";
  return "Symbol";
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
