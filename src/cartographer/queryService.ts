import path from "node:path";

import type { CartographerGraphStore } from "./graphStore";
import {
  normalizePath,
} from "./graphIds";
import {
  type CartographerGraphEdge,
  type CartographerGraphNode,
  type CheckArchitectureQueryInput,
  type CheckArchitectureQueryResult,
  type FindTestsQueryInput,
  type FindTestsQueryResult,
  type GetCapabilityQueryInput,
  type GetCapabilityQueryResult,
  type GetDependenciesQueryInput,
  type GetDependenciesQueryResult,
  type GetDependentsQueryInput,
  type GetDependentsQueryResult,
  type GetFileQueryInput,
  type GetFileQueryResult,
  type GetImpactQueryInput,
  type GetImpactQueryResult,
  type GetRelevantContextInput,
  type GetRelevantContextResult,
  type GetSymbolGraphQueryInput,
  type GetSymbolGraphQueryResult,
  type ListCapabilitiesQueryResult,
  type QueryTarget,
} from "./graphSchemas";
import { findTests as findTestsLinker } from "./testLinker";

function clone<T>(v: T): T {
  return structuredClone(v);
}

function sortById<T extends { id: string }>(arr: readonly T[]): T[] {
  return [...arr].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function sortByPath(arr: readonly string[]): string[] {
  return [...arr].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function validateQueryPath(p: string): { valid: true; normalized: string } | { valid: false; reason: string } {
  if (typeof p !== "string" || p.length === 0) {
    return { valid: false, reason: "path must be a non-empty string" };
  }
  if (path.isAbsolute(p)) {
    return { valid: false, reason: "absolute paths are not allowed" };
  }
  const norm = normalizePath(p);
  if (path.isAbsolute(norm) || norm.startsWith("/") || /^[a-zA-Z]:\//.test(norm) || norm.startsWith("\\\\")) {
    return { valid: false, reason: "absolute paths are not allowed" };
  }
  if (p.includes("..") || norm.includes("..")) {
    return { valid: false, reason: "path traversal is not allowed" };
  }
  // reject segments that are ".."
  const parts = norm.split("/");
  if (parts.some((seg) => seg === "..")) {
    return { valid: false, reason: "path traversal is not allowed" };
  }
  return { valid: true, normalized: norm };
}

function isFileLikeKind(kind: CartographerGraphNode["kind"]): boolean {
  return kind === "File" || kind === "Test" || kind === "Doc" || kind === "Config";
}

function isSymbolKind(kind: CartographerGraphNode["kind"]): boolean {
  return (
    kind === "Symbol" ||
    kind === "Function" ||
    kind === "Class" ||
    kind === "Interface" ||
    kind === "TypeAlias" ||
    kind === "Enum"
  );
}

function readRelation(props: CartographerGraphEdge["properties"]): "import" | "basename" {
  const v = props["relation"];
  return v === "basename" ? "basename" : "import";
}

function findFileLikeNodesByNormalizedPath(
  nodes: readonly CartographerGraphNode[],
  norm: string
): readonly CartographerGraphNode[] {
  return nodes.filter((n) => n.normalizedPath === norm && isFileLikeKind(n.kind));
}

function findSymbolNodesByNormalizedPath(
  nodes: readonly CartographerGraphNode[],
  norm: string
): readonly CartographerGraphNode[] {
  return nodes.filter((s) => s.normalizedPath === norm && isSymbolKind(s.kind));
}

function findSymbolNodesByName(
  nodes: readonly CartographerGraphNode[],
  name: string
): readonly CartographerGraphNode[] {
  return nodes.filter((s) => s.symbolName === name && isSymbolKind(s.kind));
}

function findContainingFileForSymbol(
  nodes: readonly CartographerGraphNode[],
  sym: CartographerGraphNode
): CartographerGraphNode | undefined {
  if (!sym.normalizedPath) return undefined;
  return nodes.find(
    (f) => f.normalizedPath === sym.normalizedPath && isFileLikeKind(f.kind)
  );
}

type Collectors = {
  readonly nodeMap: Map<string, CartographerGraphNode>;
  readonly edgeMap: Map<string, CartographerGraphEdge>;
  addNode(n?: CartographerGraphNode): void;
  addEdge(e?: CartographerGraphEdge): void;
};

function makeNodeAndEdgeCollectors(): Collectors {
  const nodeMap = new Map<string, CartographerGraphNode>();
  const edgeMap = new Map<string, CartographerGraphEdge>();
  const addNode = (n?: CartographerGraphNode) => {
    if (n) nodeMap.set(n.id, n);
  };
  const addEdge = (e?: CartographerGraphEdge) => {
    if (e) edgeMap.set(e.id, e);
  };
  return { nodeMap, edgeMap, addNode, addEdge };
}

function addContextForPathHint(
  nodes: readonly CartographerGraphNode[],
  edges: readonly CartographerGraphEdge[],
  norm: string,
  addNode: (n?: CartographerGraphNode) => void,
  addEdge: (e?: CartographerGraphEdge) => void
): void {
  const files = findFileLikeNodesByNormalizedPath(nodes, norm);
  for (const f of files) {
    addNode(f);
    const syms = findSymbolNodesByNormalizedPath(nodes, norm);
    for (const s of syms) addNode(s);
    const outs = edges.filter((e) => e.fromNodeId === f.id);
    for (const o of outs) {
      addEdge(o);
      const to = nodes.find((nn) => nn.id === o.toNodeId);
      addNode(to);
    }
  }
}

function addContextForSymbolHint(
  nodes: readonly CartographerGraphNode[],
  name: string,
  addNode: (n?: CartographerGraphNode) => void
): void {
  const syms = findSymbolNodesByName(nodes, name);
  for (const s of syms) {
    addNode(s);
    const file = findContainingFileForSymbol(nodes, s);
    addNode(file);
  }
}

type ResolveTargetResult =
  | { kind: "ok"; nodes: readonly CartographerGraphNode[] }
  | { kind: "not_found" }
  | { kind: "invalid_input"; reason: string };

function resolveTargetToNodes(target: QueryTarget, nodes: readonly CartographerGraphNode[]): ResolveTargetResult {
  if (target.kind === "file") {
    const v = validateQueryPath(target.normalizedPath);
    if (!v.valid) {
      return { kind: "invalid_input", reason: v.reason };
    }
    const norm = v.normalized;
    const matches = nodes.filter((n) => n.normalizedPath === norm && isFileLikeKind(n.kind));
    if (matches.length === 0) {
      return { kind: "not_found" };
    }
    return { kind: "ok", nodes: matches };
  }
  // symbol
  if (target.id) {
    const n = nodes.find((nn) => nn.id === target.id && isSymbolKind(nn.kind));
    if (n) {
      return { kind: "ok", nodes: [n] };
    }
    return { kind: "not_found" };
  }
  if (target.name) {
    const matches = nodes.filter((nn) => nn.symbolName === target.name && isSymbolKind(nn.kind));
    if (matches.length === 0) {
      return { kind: "not_found" };
    }
    return { kind: "ok", nodes: matches };
  }
  return { kind: "invalid_input", reason: "must provide id or name for symbol target" };
}

export type QueryServiceGraph = {
  readonly nodes: readonly CartographerGraphNode[];
  readonly edges: readonly CartographerGraphEdge[];
};

export class CartographerQueryService {
  private readonly nodes: readonly CartographerGraphNode[];
  private readonly edges: readonly CartographerGraphEdge[];

  private constructor(nodes: readonly CartographerGraphNode[], edges: readonly CartographerGraphEdge[]) {
    this.nodes = sortById(nodes);
    this.edges = sortById(edges);
  }

  static fromGraph(graph: QueryServiceGraph): CartographerQueryService {
    return new CartographerQueryService(graph.nodes, graph.edges);
  }

  static async fromStore(store: CartographerGraphStore, snapshotId: string): Promise<CartographerQueryService> {
    const nodes = await store.listNodes(snapshotId);
    const edges = await store.listEdges(snapshotId);
    return new CartographerQueryService(nodes, edges);
  }

  async getFile(input: GetFileQueryInput): Promise<GetFileQueryResult> {
    const v = validateQueryPath(input.normalizedPath);
    if (!v.valid) {
      return { status: "invalid_input", reason: v.reason };
    }
    const norm = v.normalized;
    const fileNode = this.nodes.find((n) => isFileLikeKind(n.kind) && n.normalizedPath === norm);
    if (!fileNode) {
      return { status: "not_found", path: norm };
    }
    const symbols = this.nodes.filter((n) => n.normalizedPath === norm && isSymbolKind(n.kind));
    const imports = this.edges.filter(
      (e) => e.fromNodeId === fileNode.id && (e.kind === "IMPORTS" || e.kind === "DEPENDS_ON")
    );
    return {
      status: "ok",
      file: clone(fileNode),
      symbols: sortById(symbols).map(clone),
      imports: sortById(imports).map(clone),
    };
  }

  async getSymbol(input: GetSymbolGraphQueryInput): Promise<GetSymbolGraphQueryResult> {
    if (input.id) {
      const found = this.nodes.find((n) => n.id === input.id && isSymbolKind(n.kind));
      if (found) {
        return { status: "ok", symbols: [clone(found)] };
      }
      return { status: "not_found" };
    }
    if (input.name) {
      const matches = this.nodes.filter((n) => n.symbolName === input.name && isSymbolKind(n.kind));
      if (matches.length === 0) {
        return { status: "not_found" };
      }
      return { status: "ok", symbols: sortById(matches).map(clone) };
    }
    return { status: "invalid_input", reason: "must provide id or name" };
  }

  async getDependencies(input: GetDependenciesQueryInput): Promise<GetDependenciesQueryResult> {
    const res = resolveTargetToNodes(input.target, this.nodes);
    if (res.kind === "invalid_input") {
      return { status: "invalid_input", reason: res.reason };
    }
    if (res.kind === "not_found") {
      return { status: "not_found" };
    }
    const targets = res.nodes;
    const depEdges: CartographerGraphEdge[] = [];
    for (const t of targets) {
      const outs = this.edges.filter(
        (e) => e.fromNodeId === t.id && (e.kind === "IMPORTS" || e.kind === "DEPENDS_ON")
      );
      depEdges.push(...outs);
    }
    // For symbols, include containing file deps first
    for (const t of targets) {
      if (isSymbolKind(t.kind) && t.normalizedPath) {
        const file = this.nodes.find(
          (n) => n.normalizedPath === t.normalizedPath && isFileLikeKind(n.kind)
        );
        if (file) {
          const fileDeps = this.edges.filter(
            (e) => e.fromNodeId === file.id && (e.kind === "IMPORTS" || e.kind === "DEPENDS_ON")
          );
          depEdges.push(...fileDeps);
        }
      }
    }
    const unique = new Map<string, CartographerGraphEdge>();
    for (const e of depEdges) unique.set(e.id, e);
    return {
      status: "ok",
      edges: sortById([...unique.values()]).map(clone),
      targetNodes: sortById(targets).map(clone),
    };
  }

  async getDependents(input: GetDependentsQueryInput): Promise<GetDependentsQueryResult> {
    const res = resolveTargetToNodes(input.target, this.nodes);
    if (res.kind === "invalid_input") {
      return { status: "invalid_input", reason: res.reason };
    }
    if (res.kind === "not_found") {
      return { status: "not_found" };
    }
    const targets = res.nodes;
    const depEdges: CartographerGraphEdge[] = [];
    const targetIds = new Set(targets.map((t) => t.id));
    for (const e of this.edges) {
      if (targetIds.has(e.toNodeId) && (e.kind === "IMPORTS" || e.kind === "DEPENDS_ON")) {
        depEdges.push(e);
      }
    }
    // For symbols, include containing file dependents as well
    for (const t of targets) {
      if (isSymbolKind(t.kind) && t.normalizedPath) {
        const file = this.nodes.find(
          (n) => n.normalizedPath === t.normalizedPath && isFileLikeKind(n.kind)
        );
        if (file) {
          const fileRev = this.edges.filter(
            (e) => e.toNodeId === file.id && (e.kind === "IMPORTS" || e.kind === "DEPENDS_ON")
          );
          depEdges.push(...fileRev);
        }
      }
    }
    const unique = new Map<string, CartographerGraphEdge>();
    for (const e of depEdges) unique.set(e.id, e);
    return {
      status: "ok",
      edges: sortById([...unique.values()]).map(clone),
      targetNodes: sortById(targets).map(clone),
    };
  }

  async getRelevantContext(input: GetRelevantContextInput): Promise<GetRelevantContextResult> {
    const hints = input.hints ?? {};
    const { nodeMap, edgeMap, addNode, addEdge } = makeNodeAndEdgeCollectors();

    if (hints.paths) {
      for (const p of hints.paths) {
        const v = validateQueryPath(p);
        if (!v.valid) {
          return { status: "invalid_input", reason: v.reason };
        }
        const norm = v.normalized;
        addContextForPathHint(this.nodes, this.edges, norm, addNode, addEdge);
      }
    }

    if (hints.symbolNames) {
      for (const nm of hints.symbolNames) {
        addContextForSymbolHint(this.nodes, nm, addNode);
      }
    }

    return {
      status: "ok",
      nodes: sortById([...nodeMap.values()]).map(clone),
      edges: sortById([...edgeMap.values()]).map(clone),
    };
  }

  async getImpact(input: GetImpactQueryInput): Promise<GetImpactQueryResult> {
    const changed: string[] = [];
    for (const p of input.changedNormalizedPaths) {
      const v = validateQueryPath(p);
      if (!v.valid) {
        return { status: "invalid_input", reason: v.reason };
      }
      changed.push(v.normalized);
    }

    const impacted = new Set<string>();
    const probableTests = new Set<string>();

    for (const cp of changed) {
      const fileNodes = this.nodes.filter((n) => n.normalizedPath === cp && isFileLikeKind(n.kind));
      for (const fn of fileNodes) {
        // reverse dependents via DEPENDS_ON / IMPORTS
        const rev = this.edges.filter(
          (e) => e.toNodeId === fn.id && (e.kind === "DEPENDS_ON" || e.kind === "IMPORTS")
        );
        for (const r of rev) {
          const from = this.nodes.find((nn) => nn.id === r.fromNodeId);
          if (from?.normalizedPath) {
            impacted.add(from.normalizedPath);
            const impactedTestEdges = this.edges.filter((e) => e.toNodeId === from.id && e.kind === "TESTS");
            for (const te of impactedTestEdges) {
              const tn = this.nodes.find((nn) => nn.id === te.fromNodeId);
              if (tn?.normalizedPath) probableTests.add(tn.normalizedPath);
            }
          }
        }
        // TESTS edges point from test -> target
        const testEdges = this.edges.filter((e) => e.toNodeId === fn.id && e.kind === "TESTS");
        for (const te of testEdges) {
          const tn = this.nodes.find((nn) => nn.id === te.fromNodeId);
          if (tn?.normalizedPath) probableTests.add(tn.normalizedPath);
        }
      }
      impacted.add(cp);
    }

    return {
      status: "ok",
      impactedFiles: sortByPath([...impacted]),
      probableTests: sortByPath([...probableTests]),
      confidence: "structural",
    };
  }

  async findTests(input: FindTestsQueryInput): Promise<FindTestsQueryResult> {
    const v = validateQueryPath(input.targetNormalizedPath);
    if (!v.valid) {
      return { status: "invalid_input", reason: v.reason };
    }
    const norm = v.normalized;

    // Prefer graph TESTS edges
    const targetFiles = this.nodes.filter((n) => n.normalizedPath === norm && isFileLikeKind(n.kind));
    const linked: Array<{ normalizedPath: string; relation: "import" | "basename"; evidence: string }> = [];
    for (const tf of targetFiles) {
      const testEdges = this.edges.filter((e) => e.toNodeId === tf.id && e.kind === "TESTS");
      for (const te of testEdges) {
        const tn = this.nodes.find((nn) => nn.id === te.fromNodeId);
        if (tn?.normalizedPath) {
          const relation = readRelation(te.properties);
          const evidence = te.evidence?.text ?? "";
          linked.push({ normalizedPath: tn.normalizedPath, relation, evidence });
        }
      }
    }
    if (linked.length > 0) {
      const dedup = new Map<string, (typeof linked)[number]>();
      for (const l of linked) dedup.set(l.normalizedPath, l);
      return {
        status: "ok",
        targetNormalizedPath: norm,
        linkedTests: [...dedup.values()].sort((a, b) =>
          a.normalizedPath < b.normalizedPath ? -1 : a.normalizedPath > b.normalizedPath ? 1 : 0
        ),
      };
    }

    // Fallback to linker when source provided
    if (input.getSourceText && input.indexedFiles) {
      const res = findTestsLinker({
        targetNormalizedPath: norm,
        indexedFiles: input.indexedFiles,
        getSourceText: input.getSourceText,
      });
      return {
        status: "ok",
        targetNormalizedPath: norm,
        linkedTests: [...res.linkedTests],
      };
    }

    return {
      status: "ok",
      targetNormalizedPath: norm,
      linkedTests: [],
    };
  }

  async checkArchitecture(input: CheckArchitectureQueryInput): Promise<CheckArchitectureQueryResult> {
    if (input.changeSet) {
      for (const p of input.changeSet) {
        const v = validateQueryPath(p);
        if (!v.valid) {
          return { status: "invalid_input", reason: v.reason };
        }
      }
    }
    const ruleNodes = this.nodes.filter((n) => n.kind === "Rule");
    if (ruleNodes.length === 0) {
      return { status: "not_configured" };
    }
    const findings = sortByPath(ruleNodes.map((r) => r.label));
    return { status: "ok", findings };
  }

  async listCapabilities(): Promise<ListCapabilitiesQueryResult> {
    const caps = this.nodes.filter((n) => n.kind === "Capability");
    if (caps.length === 0) {
      return { status: "not_configured" };
    }
    return { status: "ok", capabilities: sortById(caps).map(clone) };
  }

  async getCapability(input: GetCapabilityQueryInput): Promise<GetCapabilityQueryResult> {
    const cap = this.nodes.find((n) => n.kind === "Capability" && n.id === input.id);
    if (!cap) {
      const anyCaps = this.nodes.some((n) => n.kind === "Capability");
      return { status: anyCaps ? "not_found" : "not_configured" };
    }
    return { status: "ok", capability: clone(cap) };
  }
}
