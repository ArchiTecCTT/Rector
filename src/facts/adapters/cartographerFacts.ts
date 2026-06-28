import type {
  CartographerGraphEdge,
  CartographerGraphNode,
  CartographerQueryStatus,
  FindTestsQueryResult,
  GetCapabilityQueryResult,
  GetFileQueryResult,
  GetImpactQueryResult,
  GetRelevantContextResult,
  GetSymbolGraphQueryResult,
  GraphSnapshot,
} from "../../cartographer/graphSchemas";
import { createFactId, createFactScope, createFactTrust, graphProvenance, graphRef, isSafeFactPath } from "..";
import { FACT_SCHEMA_VERSION, RectorFactSchema } from "../schemas";
import type {
  CapabilityGraphContextFact,
  CartographerSnapshotFact,
  ContextSliceFact,
  FactProvenance,
  FileContextFact,
  GraphEdgeFactRef,
  GraphNodeFactRef,
  GraphRef,
  ImpactContextFact,
  RectorFact,
  SymbolContextFact,
  TestLinkContextFact,
} from "../types";

export interface CartographerFactAdapterOptions {
  readonly runId: string;
  readonly taskId?: string;
  readonly createdAt?: string;
}

function createdAt(options: CartographerFactAdapterOptions): string {
  return options.createdAt ?? new Date().toISOString();
}

function graphScope(refs: readonly GraphRef[], paths: readonly string[] = []) {
  return createFactScope({
    scopeType: "repository",
    graphRefs: refs,
    workspacePaths: paths.filter(isSafeFactPath),
  });
}

function parseFact<T extends RectorFact>(draft: Record<string, unknown>): T {
  const withId = { ...draft, factId: createFactId(draft) };
  return RectorFactSchema.parse(withId) as T;
}

function snapshotGraphRef(snapshotId: string, queryStatus?: GraphRef["queryStatus"]): GraphRef {
  return graphRef({ snapshotId, ...(queryStatus ? { queryStatus } : {}) });
}

function nodeGraphRef(node: CartographerGraphNode, queryStatus?: GraphRef["queryStatus"]): GraphRef {
  return graphRef({ snapshotId: node.snapshotId, nodeId: node.id, ...(queryStatus ? { queryStatus } : {}) });
}

function edgeGraphRef(edge: CartographerGraphEdge, queryStatus?: GraphRef["queryStatus"]): GraphRef {
  return graphRef({ snapshotId: edge.snapshotId, edgeId: edge.id, ...(queryStatus ? { queryStatus } : {}) });
}

function graphRefsForQuery(snapshotId: string, status: CartographerQueryStatus, refs: readonly GraphRef[] = []): GraphRef[] {
  if (refs.length > 0) return [...refs];
  return [snapshotGraphRef(snapshotId, status)];
}

function graphProvenanceFor(refs: readonly GraphRef[]): FactProvenance[] {
  return refs.map((ref) => graphProvenance(ref));
}

export function cartographerSnapshotToFact(
  snapshot: GraphSnapshot,
  options: CartographerFactAdapterOptions,
): CartographerSnapshotFact {
  const ref = snapshotGraphRef(snapshot.id);
  return parseFact<CartographerSnapshotFact>({
    schemaVersion: FACT_SCHEMA_VERSION,
    kind: "cartographer_snapshot",
    runId: options.runId,
    ...(options.taskId ? { taskId: options.taskId } : {}),
    createdAt: createdAt(options),
    producer: "cartographer",
    provenance: [graphProvenance(ref)],
    trust: createFactTrust("graph_grounded", "Cartographer snapshot metadata is backed by the graph snapshot id"),
    scope: graphScope([ref]),
    redactionState: "none",
    snapshotId: snapshot.id,
    nodeCount: snapshot.nodeCount,
    edgeCount: snapshot.edgeCount,
  });
}

export function graphNodeToFact(node: CartographerGraphNode, options: CartographerFactAdapterOptions): GraphNodeFactRef {
  const ref = nodeGraphRef(node);
  return parseFact<GraphNodeFactRef>({
    schemaVersion: FACT_SCHEMA_VERSION,
    kind: "graph_node_ref",
    runId: options.runId,
    ...(options.taskId ? { taskId: options.taskId } : {}),
    createdAt: createdAt(options),
    producer: "cartographer",
    provenance: [graphProvenance(ref)],
    trust: createFactTrust("graph_grounded", "Cartographer node fact preserves the source graph node id"),
    scope: graphScope([ref], node.normalizedPath ? [node.normalizedPath] : []),
    redactionState: "none",
    graph: ref,
  });
}

export function graphEdgeToFact(edge: CartographerGraphEdge, options: CartographerFactAdapterOptions): GraphEdgeFactRef {
  const ref = edgeGraphRef(edge);
  return parseFact<GraphEdgeFactRef>({
    schemaVersion: FACT_SCHEMA_VERSION,
    kind: "graph_edge_ref",
    runId: options.runId,
    ...(options.taskId ? { taskId: options.taskId } : {}),
    createdAt: createdAt(options),
    producer: "cartographer",
    provenance: [graphProvenance(ref)],
    trust: createFactTrust("graph_grounded", "Cartographer edge fact preserves the source graph edge id"),
    scope: graphScope([ref], edge.path ? [edge.path] : []),
    redactionState: "none",
    graph: ref,
  });
}

export function fileQueryResultToFacts(input: {
  readonly snapshotId: string;
  readonly query: string;
  readonly result: GetFileQueryResult;
  readonly options: CartographerFactAdapterOptions;
}): Array<ContextSliceFact | FileContextFact | SymbolContextFact | GraphNodeFactRef | GraphEdgeFactRef> {
  const { snapshotId, query, result, options } = input;
  if (result.status !== "ok") {
    return [contextSliceFact({ snapshotId, query, status: result.status, summary: querySummary(result), options })];
  }

  const fileRef = nodeGraphRef(result.file, "ok");
  const facts: Array<ContextSliceFact | FileContextFact | SymbolContextFact | GraphNodeFactRef | GraphEdgeFactRef> = [
    contextSliceFact({ snapshotId, query, status: "ok", refs: [fileRef], summary: `file query matched ${result.file.id}`, options }),
    parseFact<FileContextFact>({
      schemaVersion: FACT_SCHEMA_VERSION,
      kind: "file_context",
      runId: options.runId,
      ...(options.taskId ? { taskId: options.taskId } : {}),
      createdAt: createdAt(options),
      producer: "cartographer",
      provenance: [graphProvenance(fileRef)],
      trust: createFactTrust("graph_grounded", "File context is backed by a Cartographer file node"),
      scope: graphScope([fileRef], result.file.normalizedPath ? [result.file.normalizedPath] : []),
      redactionState: "none",
      path: result.file.normalizedPath ?? result.file.path ?? query,
      graph: fileRef,
      summary: `Cartographer file node ${result.file.id}`,
    }),
    graphNodeToFact(result.file, options),
  ];

  for (const symbol of result.symbols) {
    const ref = nodeGraphRef(symbol, "ok");
    facts.push(parseFact<SymbolContextFact>({
      schemaVersion: FACT_SCHEMA_VERSION,
      kind: "symbol_context",
      runId: options.runId,
      ...(options.taskId ? { taskId: options.taskId } : {}),
      createdAt: createdAt(options),
      producer: "cartographer",
      provenance: [graphProvenance(ref)],
      trust: createFactTrust("graph_grounded", "Symbol context is backed by a Cartographer symbol node"),
      scope: graphScope([ref], symbol.normalizedPath ? [symbol.normalizedPath] : []),
      redactionState: "none",
      symbolName: symbol.symbolName ?? symbol.label,
      graph: ref,
      summary: `Cartographer symbol node ${symbol.id}`,
    }));
    facts.push(graphNodeToFact(symbol, options));
  }
  for (const edge of result.imports) facts.push(graphEdgeToFact(edge, options));
  return facts;
}

export function symbolQueryResultToFacts(input: {
  readonly snapshotId: string;
  readonly query: string;
  readonly result: GetSymbolGraphQueryResult;
  readonly options: CartographerFactAdapterOptions;
}): Array<ContextSliceFact | SymbolContextFact | GraphNodeFactRef> {
  const { snapshotId, query, result, options } = input;
  if (result.status !== "ok") {
    return [contextSliceFact({ snapshotId, query, status: result.status, summary: querySummary(result), options })];
  }
  const status: ContextSliceFact["status"] = result.symbols.length > 1 ? "ambiguous" : "ok";
  const refs = result.symbols.map((symbol) => nodeGraphRef(symbol, status));
  const facts: Array<ContextSliceFact | SymbolContextFact | GraphNodeFactRef> = [
    contextSliceFact({ snapshotId, query, status, refs, summary: `symbol query matched ${result.symbols.length} node(s)`, options }),
  ];
  for (const symbol of result.symbols) {
    const ref = nodeGraphRef(symbol, status);
    facts.push(parseFact<SymbolContextFact>({
      schemaVersion: FACT_SCHEMA_VERSION,
      kind: "symbol_context",
      runId: options.runId,
      ...(options.taskId ? { taskId: options.taskId } : {}),
      createdAt: createdAt(options),
      producer: "cartographer",
      provenance: [graphProvenance(ref)],
      trust: createFactTrust("graph_grounded", "Symbol context is backed by a Cartographer symbol node"),
      scope: graphScope([ref], symbol.normalizedPath ? [symbol.normalizedPath] : []),
      redactionState: "none",
      symbolName: symbol.symbolName ?? symbol.label,
      graph: ref,
      summary: `Cartographer symbol node ${symbol.id}`,
    }));
    facts.push(graphNodeToFact(symbol, options));
  }
  return facts;
}

export function relevantContextResultToFacts(input: {
  readonly snapshotId: string;
  readonly query: string;
  readonly result: GetRelevantContextResult;
  readonly options: CartographerFactAdapterOptions;
}): Array<ContextSliceFact | GraphNodeFactRef | GraphEdgeFactRef> {
  const { snapshotId, query, result, options } = input;
  if (result.status !== "ok") {
    return [contextSliceFact({ snapshotId, query, status: result.status, summary: querySummary(result), options })];
  }
  const refs = [
    ...result.nodes.map((node) => nodeGraphRef(node, "ok")),
    ...result.edges.map((edge) => edgeGraphRef(edge, "ok")),
  ];
  return [
    contextSliceFact({ snapshotId, query, status: "ok", refs, summary: `relevant context matched ${result.nodes.length} node(s) and ${result.edges.length} edge(s)`, options }),
    ...result.nodes.map((node) => graphNodeToFact(node, options)),
    ...result.edges.map((edge) => graphEdgeToFact(edge, options)),
  ];
}

export function impactResultToFact(input: {
  readonly snapshotId: string;
  readonly changedPaths: readonly string[];
  readonly result: GetImpactQueryResult;
  readonly options: CartographerFactAdapterOptions;
}): ImpactContextFact | ContextSliceFact {
  const { snapshotId, changedPaths, result, options } = input;
  if (result.status !== "ok") {
    return contextSliceFact({ snapshotId, query: `impact:${changedPaths.join(",") || "none"}`, status: result.status, summary: querySummary(result), options });
  }
  const ref = snapshotGraphRef(snapshotId, "ok");
  return parseFact<ImpactContextFact>({
    schemaVersion: FACT_SCHEMA_VERSION,
    kind: "impact_context",
    runId: options.runId,
    ...(options.taskId ? { taskId: options.taskId } : {}),
    createdAt: createdAt(options),
    producer: "cartographer",
    provenance: [graphProvenance(ref)],
    trust: createFactTrust("graph_grounded", "Impact result is backed by a Cartographer graph query"),
    scope: graphScope([ref], [...changedPaths, ...result.impactedFiles, ...result.probableTests]),
    redactionState: "none",
    changedPaths: [...changedPaths],
    impactedPaths: [...result.impactedFiles],
    probableTests: [...result.probableTests],
    confidence: result.confidence,
  });
}

export function findTestsResultToFact(input: {
  readonly snapshotId: string;
  readonly result: FindTestsQueryResult;
  readonly options: CartographerFactAdapterOptions;
}): TestLinkContextFact | ContextSliceFact {
  const { snapshotId, result, options } = input;
  if (result.status !== "ok") {
    return contextSliceFact({ snapshotId, query: "find_tests", status: result.status, summary: querySummary(result), options });
  }
  const ref = snapshotGraphRef(snapshotId, "ok");
  return parseFact<TestLinkContextFact>({
    schemaVersion: FACT_SCHEMA_VERSION,
    kind: "test_link_context",
    runId: options.runId,
    ...(options.taskId ? { taskId: options.taskId } : {}),
    createdAt: createdAt(options),
    producer: "cartographer",
    provenance: [graphProvenance(ref)],
    trust: createFactTrust("graph_grounded", "Test-link result is backed by a Cartographer graph query"),
    scope: graphScope(
      [ref],
      [result.targetNormalizedPath, ...result.linkedTests.map((test) => test.normalizedPath)].filter(isSafeFactPath),
    ),
    redactionState: "none",
    targetPath: result.targetNormalizedPath,
    testPaths: result.linkedTests.map((test) => test.normalizedPath),
    relation: result.linkedTests[0]?.relation ?? "insufficient_evidence",
  });
}

export function capabilityQueryResultToFact(input: {
  readonly snapshotId: string;
  readonly capabilityId: string;
  readonly result: GetCapabilityQueryResult;
  readonly options: CartographerFactAdapterOptions;
}): CapabilityGraphContextFact {
  const { snapshotId, capabilityId, result, options } = input;
  const refs = result.status === "ok" ? [nodeGraphRef(result.capability, "ok")] : [snapshotGraphRef(snapshotId, result.status)];
  return parseFact<CapabilityGraphContextFact>({
    schemaVersion: FACT_SCHEMA_VERSION,
    kind: "capability_graph_context",
    runId: options.runId,
    ...(options.taskId ? { taskId: options.taskId } : {}),
    createdAt: createdAt(options),
    producer: "cartographer",
    provenance: graphProvenanceFor(refs),
    trust: result.status === "ok" ? createFactTrust("graph_grounded", "Capability graph context is backed by a Capability node") : createFactTrust("insufficient_evidence", `Capability query returned ${result.status}`),
    scope: graphScope(refs),
    redactionState: "none",
    capabilityId,
    graphRefs: refs,
    status: result.status,
  });
}

function contextSliceFact(input: {
  readonly snapshotId: string;
  readonly query: string;
  readonly status: ContextSliceFact["status"];
  readonly summary?: string;
  readonly refs?: readonly GraphRef[];
  readonly options: CartographerFactAdapterOptions;
}): ContextSliceFact {
  const refs = graphRefsForQuery(input.snapshotId, input.status, input.refs);
  return parseFact<ContextSliceFact>({
    schemaVersion: FACT_SCHEMA_VERSION,
    kind: "context_slice",
    runId: input.options.runId,
    ...(input.options.taskId ? { taskId: input.options.taskId } : {}),
    createdAt: createdAt(input.options),
    producer: "cartographer",
    provenance: graphProvenanceFor(refs),
    trust: input.status === "ok" || input.status === "ambiguous" ? createFactTrust("graph_grounded", "Context query is backed by graph references") : createFactTrust("insufficient_evidence", `Cartographer query returned ${input.status}`),
    scope: graphScope(refs),
    redactionState: "none",
    query: input.query,
    status: input.status,
    ...(input.summary ? { summary: input.summary } : {}),
    evidence: refs,
  });
}

function querySummary(result: { readonly status: string; readonly reason?: string; readonly path?: string }): string {
  if (result.reason) return `${result.status}: ${result.reason}`;
  if (result.path) return `${result.status}: ${result.path}`;
  return result.status;
}
