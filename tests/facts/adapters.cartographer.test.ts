import { describe, expect, it } from "vitest";

import type { CartographerGraphEdge, CartographerGraphNode, GraphSnapshot } from "../../src/cartographer/graphSchemas";
import {
  RectorFactSchema,
  cartographerSnapshotToFact,
  capabilityQueryResultToFact,
  fileQueryResultToFacts,
  graphEdgeToFact,
  graphNodeToFact,
  symbolQueryResultToFacts,
} from "../../src/facts";

const OPTIONS = { runId: "run-cartographer", createdAt: "2026-06-28T00:00:00.000Z" };

function node(overrides: Partial<CartographerGraphNode> = {}): CartographerGraphNode {
  return {
    id: "node:file:src/index.ts",
    snapshotId: "graph-snap-1",
    kind: "File",
    label: "src/index.ts",
    normalizedPath: "src/index.ts",
    properties: {},
    ...overrides,
  };
}

function edge(overrides: Partial<CartographerGraphEdge> = {}): CartographerGraphEdge {
  return {
    id: "edge:src-index-imports-tool",
    snapshotId: "graph-snap-1",
    kind: "IMPORTS",
    fromNodeId: "node:file:src/index.ts",
    toNodeId: "node:file:src/tools.ts",
    path: "src/index.ts",
    properties: {},
    ...overrides,
  };
}

function expectValidFacts(facts: readonly unknown[]) {
  for (const fact of facts) expect(RectorFactSchema.safeParse(fact).success).toBe(true);
}

describe("cartographer fact adapter", () => {
  it("preserves snapshot, node, and edge ids in graph-grounded facts", () => {
    const snapshot: GraphSnapshot = {
      id: "graph-snap-1",
      repoRoot: "/repo",
      inventorySnapshotId: "inventory-snap-1",
      createdAt: OPTIONS.createdAt,
      nodeCount: 2,
      edgeCount: 1,
    };
    const snapshotFact = cartographerSnapshotToFact(snapshot, OPTIONS);
    const nodeFact = graphNodeToFact(node(), OPTIONS);
    const edgeFact = graphEdgeToFact(edge(), OPTIONS);

    expectValidFacts([snapshotFact, nodeFact, edgeFact]);
    expect(snapshotFact.snapshotId).toBe("graph-snap-1");
    expect(nodeFact.graph.nodeId).toBe("node:file:src/index.ts");
    expect(edgeFact.graph.edgeId).toBe("edge:src-index-imports-tool");
    expect([snapshotFact, nodeFact, edgeFact].every((fact) => fact.trust.level === "graph_grounded")).toBe(true);
  });

  it("represents not_found query results honestly instead of empty success", () => {
    const facts = fileQueryResultToFacts({
      snapshotId: "graph-snap-1",
      query: "missing.ts",
      result: { status: "not_found", path: "missing.ts" },
      options: OPTIONS,
    });

    expectValidFacts(facts);
    expect(facts).toHaveLength(1);
    expect(facts[0]?.kind).toBe("context_slice");
    if (facts[0]?.kind === "context_slice") {
      expect(facts[0].status).toBe("not_found");
      expect(facts[0].trust.level).toBe("insufficient_evidence");
      expect(facts[0].evidence[0]).toMatchObject({ refType: "graph", snapshotId: "graph-snap-1", queryStatus: "not_found" });
    }
  });

  it("marks multiple symbol matches as ambiguous with source graph ids preserved", () => {
    const first = node({ id: "node:symbol:one", kind: "Function", symbolName: "run" });
    const second = node({ id: "node:symbol:two", kind: "Function", symbolName: "run" });
    const facts = symbolQueryResultToFacts({
      snapshotId: "graph-snap-1",
      query: "symbol:run",
      result: { status: "ok", symbols: [first, second] },
      options: OPTIONS,
    });

    expectValidFacts(facts);
    const context = facts.find((fact) => fact.kind === "context_slice");
    expect(context?.kind).toBe("context_slice");
    if (context?.kind === "context_slice") expect(context.status).toBe("ambiguous");
    expect(facts.filter((fact) => fact.kind === "graph_node_ref").map((fact) => fact.graph.nodeId)).toEqual(["node:symbol:one", "node:symbol:two"]);
  });

  it("preserves capability query negative statuses", () => {
    const fact = capabilityQueryResultToFact({
      snapshotId: "graph-snap-1",
      capabilityId: "capability.search",
      result: { status: "not_configured" },
      options: OPTIONS,
    });

    expectValidFacts([fact]);
    expect(fact.status).toBe("not_configured");
    expect(fact.trust.level).toBe("insufficient_evidence");
    expect(fact.graphRefs[0]).toMatchObject({ snapshotId: "graph-snap-1", queryStatus: "not_configured" });
  });
});
