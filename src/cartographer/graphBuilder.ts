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

  const dirSet = collectAncestorDirectories(files);
  const sortedFiles = [...files].sort((a, b) => compareUtf16(a.normalizedPath, b.normalizedPath));
  const nodes = emitBaselineInventoryNodes({
    repoRoot,
    snapshotId,
    projectId,
    packageId,
    projectLabel,
    packageLabel,
    dirSet,
    sortedFiles,
  });

  const indexedNormalized = sortedFiles.map((f) => normalizePath(f.normalizedPath));

  const edges = emitBaselineContainsEdges({
    repoRoot,
    snapshotId,
    projectId,
    packageId,
    dirSet,
    sortedFiles,
  });

  // Collect structural nodes/edges deterministically
  const structuralNodes: CartographerGraphNode[] = [];
  const structuralEdges: CartographerGraphEdge[] = [];

  const barePackages = new Map<string, string>();
  emitStructuralExtractionForFiles({
    sortedFiles,
    getSourceText,
    indexedNormalized,
    structuralNodes,
    structuralEdges,
    snapshotId,
    repoRoot,
    barePackages,
  });

  // Emit TESTS edges from findTests evidence (import-first, basename fallback)
  // C3: compute links once per source file (findTests result is independent of the test file).
  emitTestEdges({
    structuralEdges,
    snapshotId,
    repoRoot,
    sortedFiles,
    indexedNormalized,
    getSourceText,
  });

  // Merge structural nodes/edges into main collections (dedup by id for nodes, by id for edges)
  const { nodes: sortedNodes, edges: sortedEdges } = mergeStructuralGraph({
    baseNodes: nodes,
    baseEdges: edges,
    structuralNodes,
    structuralEdges,
  });

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


function collectAncestorDirectories(files: readonly FileNode[]): Set<string> {
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
  return dirSet;
}

function emitBaselineInventoryNodes(args: {
  repoRoot: string;
  snapshotId: string;
  projectId: string;
  packageId: string;
  projectLabel: string;
  packageLabel: string;
  dirSet: Set<string>;
  sortedFiles: readonly FileNode[];
}): CartographerGraphNode[] {
  const nodes: CartographerGraphNode[] = [];
  const {
    repoRoot,
    snapshotId,
    projectId,
    packageId,
    projectLabel,
    packageLabel,
    dirSet,
    sortedFiles,
  } = args;

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
      properties: fileNodeStableProperties(f),
    });
  }

  return nodes;
}

function emitStructuralExtractionForFiles(args: {
  sortedFiles: readonly FileNode[];
  getSourceText?: (normalizedPath: string) => string | undefined;
  indexedNormalized: readonly string[];
  structuralNodes: CartographerGraphNode[];
  structuralEdges: CartographerGraphEdge[];
  snapshotId: string;
  repoRoot: string;
  barePackages: Map<string, string>;
}): void {
  if (!args.getSourceText) return;

  for (const f of args.sortedFiles) {
    const src = args.getSourceText(f.normalizedPath);
    if (src === undefined) continue;
    if (!isStructuralSourceFile(f)) continue;

    const fileId = makeFileId(args.repoRoot, f.normalizedPath);
    const symRes = extractTsSymbols({ filePath: f.normalizedPath, sourceText: src });
    emitSymbolNodesAndEdges({
      structuralNodes: args.structuralNodes,
      structuralEdges: args.structuralEdges,
      snapshotId: args.snapshotId,
      repoRoot: args.repoRoot,
      fileId,
      normalizedPath: f.normalizedPath,
      language: f.language,
      hash: f.hash,
      symbols: symRes.symbols,
    });

    const impRes = extractImports({
      filePath: f.normalizedPath,
      sourceText: src,
      indexedFiles: args.indexedNormalized,
    });
    emitImportAndExportEdges({
      structuralNodes: args.structuralNodes,
      structuralEdges: args.structuralEdges,
      snapshotId: args.snapshotId,
      repoRoot: args.repoRoot,
      fileId,
      normalizedPath: f.normalizedPath,
      imports: impRes.imports,
      barePackages: args.barePackages,
    });
  }
}

function emitBaselineContainsEdges(args: {
  repoRoot: string;
  snapshotId: string;
  projectId: string;
  packageId: string;
  dirSet: Set<string>;
  sortedFiles: readonly FileNode[];
}): CartographerGraphEdge[] {
  const edges: CartographerGraphEdge[] = [];
  const { repoRoot, snapshotId, projectId, packageId, dirSet, sortedFiles } = args;

  edges.push({
    id: makeEdgeId("CONTAINS", projectId, packageId),
    snapshotId,
    kind: "CONTAINS",
    fromNodeId: projectId,
    toNodeId: packageId,
    properties: {},
  });

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

  return edges;
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

// --- extracted helpers (behavior-preserving refactor to reduce complexity of buildGraphSnapshot) ---

function isTsOrJsLanguage(language: FileNode["language"]): boolean {
  return language === "typescript" || language === "javascript";
}

function isStructuralSourceFile(f: FileNode): boolean {
  return f.kind === "source" && isTsOrJsLanguage(f.language);
}

function fileNodeStableProperties(f: FileNode): Record<string, string | number | boolean | null> {
  const { lastIndexedAt: _lastIndexedAt, mtimeMs: _mtimeMs, ...stableInventory } = f;
  const props: Record<string, string | number | boolean | null> = {
    kind: f.kind,
    sizeBytes: f.sizeBytes,
    ignored: f.ignored,
    inventoryFileNode: JSON.stringify(stableInventory),
  };
  if (f.ignoreReason !== undefined) {
    props.ignoreReason = f.ignoreReason;
  }
  return props;
}

function emitSymbolNodesAndEdges(args: {
  structuralNodes: CartographerGraphNode[];
  structuralEdges: CartographerGraphEdge[];
  snapshotId: string;
  repoRoot: string;
  fileId: string;
  normalizedPath: string;
  language: FileNode["language"];
  hash: string;
  symbols: ReturnType<typeof extractTsSymbols>["symbols"];
}) {
  const { structuralNodes, structuralEdges, snapshotId, repoRoot, fileId, normalizedPath, language, hash, symbols } = args;
  for (const s of symbols) {
    const symId = makeSymbolId(repoRoot, normalizedPath, s.isExported, s.name, s.startLine);
    const kinded = symbolKindToNodeKind(s.kind);
    structuralNodes.push({
      id: symId,
      snapshotId,
      kind: kinded,
      label: s.name,
      path: normalizedPath,
      normalizedPath,
      symbolName: s.name,
      symbolKind: s.kind,
      language,
      fileHash: hash,
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
      evidence: { path: normalizedPath, startLine: s.startLine, endLine: s.endLine, text: s.evidence },
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
        evidence: { path: normalizedPath, startLine: s.startLine, endLine: s.endLine, text: s.evidence },
        properties: {},
      });
    }
  }
}

function ensureBarePackageNode(args: {
  structuralNodes: CartographerGraphNode[];
  snapshotId: string;
  repoRoot: string;
  barePackages: Map<string, string>;
  specifier: string;
}): string {
  let pkgNodeId = args.barePackages.get(args.specifier);
  if (!pkgNodeId) {
    pkgNodeId = makePackageId(args.repoRoot, args.specifier);
    args.barePackages.set(args.specifier, pkgNodeId);
    args.structuralNodes.push({
      id: pkgNodeId,
      snapshotId: args.snapshotId,
      kind: "Package",
      label: args.specifier,
      path: args.specifier,
      normalizedPath: args.specifier,
      properties: { bare: true },
    });
  }
  return pkgNodeId;
}

type ImportEdgeEmitCtx = {
  structuralNodes: CartographerGraphNode[];
  structuralEdges: CartographerGraphEdge[];
  snapshotId: string;
  repoRoot: string;
  fileId: string;
  normalizedPath: string;
  barePackages: Map<string, string>;
};

function importRecordEvidence(
  normalizedPath: string,
  rec: ReturnType<typeof extractImports>["imports"][number]
): CartographerGraphEdge["evidence"] {
  return { path: normalizedPath, startLine: rec.startLine, endLine: rec.endLine, text: rec.evidence };
}

function pushImportDependsPair(
  ctx: ImportEdgeEmitCtx,
  importEdgeId: string,
  toNodeId: string,
  rec: ReturnType<typeof extractImports>["imports"][number]
): void {
  const evidence = importRecordEvidence(ctx.normalizedPath, rec);
  const props = { specifier: rec.specifier };
  ctx.structuralEdges.push({
    id: importEdgeId,
    snapshotId: ctx.snapshotId,
    kind: "IMPORTS",
    fromNodeId: ctx.fileId,
    toNodeId,
    evidence,
    properties: props,
  });
  ctx.structuralEdges.push({
    id: makeEdgeId("DEPENDS_ON", ctx.fileId, toNodeId),
    snapshotId: ctx.snapshotId,
    kind: "DEPENDS_ON",
    fromNodeId: ctx.fileId,
    toNodeId,
    evidence,
    properties: props,
  });
}

function pushExportFromEdge(
  ctx: ImportEdgeEmitCtx,
  toNodeId: string,
  rec: ReturnType<typeof extractImports>["imports"][number]
): void {
  ctx.structuralEdges.push({
    id: makeEdgeId("EXPORTS", ctx.fileId, toNodeId),
    snapshotId: ctx.snapshotId,
    kind: "EXPORTS",
    fromNodeId: ctx.fileId,
    toNodeId,
    evidence: importRecordEvidence(ctx.normalizedPath, rec),
    properties: { specifier: rec.specifier },
  });
}

function resolveImportTargetNodeId(
  ctx: ImportEdgeEmitCtx,
  target: ReturnType<typeof extractImports>["imports"][number]["target"]
): string | undefined {
  if (target.kind === "file") {
    return makeFileId(ctx.repoRoot, target.normalizedPath);
  }
  if (target.kind !== "package") return undefined;
  return ensureBarePackageNode({
    structuralNodes: ctx.structuralNodes,
    snapshotId: ctx.snapshotId,
    repoRoot: ctx.repoRoot,
    barePackages: ctx.barePackages,
    specifier: target.specifier,
  });
}

function emitImportAndExportEdges(args: {
  structuralNodes: CartographerGraphNode[];
  structuralEdges: CartographerGraphEdge[];
  snapshotId: string;
  repoRoot: string;
  fileId: string;
  normalizedPath: string;
  imports: ReturnType<typeof extractImports>["imports"];
  barePackages: Map<string, string>;
}) {
  const ctx: ImportEdgeEmitCtx = {
    structuralNodes: args.structuralNodes,
    structuralEdges: args.structuralEdges,
    snapshotId: args.snapshotId,
    repoRoot: args.repoRoot,
    fileId: args.fileId,
    normalizedPath: args.normalizedPath,
    barePackages: args.barePackages,
  };

  for (const rec of args.imports) {
    const importEdgeId = makeImportEdgeId(ctx.fileId, rec.specifier);
    const importTargetId = resolveImportTargetNodeId(ctx, rec.target);
    if (importTargetId) {
      pushImportDependsPair(ctx, importEdgeId, importTargetId, rec);
    }

    if (rec.kind !== "exportFrom") continue;
    const exportTargetId = resolveImportTargetNodeId(ctx, rec.target);
    if (exportTargetId) {
      pushExportFromEdge(ctx, exportTargetId, rec);
    }
  }
}

function emitTestEdges(args: {
  structuralEdges: CartographerGraphEdge[];
  snapshotId: string;
  repoRoot: string;
  sortedFiles: readonly FileNode[];
  indexedNormalized: string[];
  getSourceText?: (normalizedPath: string) => string | undefined;
}) {
  // Emit TESTS edges from findTests evidence (import-first, basename fallback)
  // C3: compute links once per source file (findTests result is independent of the test file).
  if (args.getSourceText) {
    const testFileSet = new Set(args.sortedFiles.filter((f) => f.kind === "test").map((f) => f.normalizedPath));
    for (const srcFile of args.sortedFiles) {
      if (!isStructuralSourceFile(srcFile)) continue;
      const srcText = args.getSourceText(srcFile.normalizedPath);
      if (srcText === undefined) continue;
      const linkRes = findTests({
        targetNormalizedPath: srcFile.normalizedPath,
        indexedFiles: args.indexedNormalized,
        getSourceText: (p) => args.getSourceText!(p),
      });
      for (const lt of linkRes.linkedTests) {
        if (!testFileSet.has(lt.normalizedPath)) continue;
        const testFileId = makeFileId(args.repoRoot, lt.normalizedPath);
        const targetFileId = makeFileId(args.repoRoot, srcFile.normalizedPath);
        args.structuralEdges.push({
          id: makeEdgeId("TESTS", testFileId, targetFileId),
          snapshotId: args.snapshotId,
          kind: "TESTS",
          fromNodeId: testFileId,
          toNodeId: targetFileId,
          evidence: { path: lt.normalizedPath, text: lt.evidence },
          properties: { relation: lt.relation },
        });
      }
    }
  }
}

function mergeStructuralGraph(args: {
  baseNodes: CartographerGraphNode[];
  baseEdges: CartographerGraphEdge[];
  structuralNodes: CartographerGraphNode[];
  structuralEdges: CartographerGraphEdge[];
}): { nodes: CartographerGraphNode[]; edges: CartographerGraphEdge[] } {
  // Merge structural nodes/edges into main collections (dedup by id for nodes, by id for edges)
  const nodeById = new Map<string, CartographerGraphNode>();
  for (const n of args.baseNodes) nodeById.set(n.id, n);
  for (const n of args.structuralNodes) {
    if (!nodeById.has(n.id)) nodeById.set(n.id, n);
  }
  const mergedNodes = [...nodeById.values()];

  const edgeById = new Map<string, CartographerGraphEdge>();
  for (const e of args.baseEdges) edgeById.set(e.id, e);
  for (const e of args.structuralEdges) {
    if (!edgeById.has(e.id)) edgeById.set(e.id, e);
  }
  const mergedEdges = [...edgeById.values()];

  const sortedNodes = [...mergedNodes].sort((a, b) => compareUtf16(a.id, b.id));
  const sortedEdges = [...mergedEdges].sort((a, b) => compareUtf16(a.id, b.id));

  return {
    nodes: sortedNodes,
    edges: sortedEdges,
  };
}
