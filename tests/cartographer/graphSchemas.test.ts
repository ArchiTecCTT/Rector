import { describe, expect, it } from "vitest";
import {
  CartographerGraphEdgeSchema,
  CartographerGraphNodeSchema,
  CartographerQueryStatusSchema,
  GetFileGraphQueryInputSchema,
  GetFileGraphQueryResultSchema,
  GraphEdgeKindSchema,
  GraphNodeKindSchema,
  GraphSnapshotSchema,
  MUST_EMIT_NOW_NODE_KINDS,
  SCHEMA_RESERVED_NODE_KINDS,
  type CartographerQueryStatus,
  type GetFileGraphQueryResult,
  type GraphNodeKind,
} from "../../src/cartographer";

const sampleNode = {
  id: "file:deadbeef:src/index.ts",
  snapshotId: "snap:deadbeef:2026-06-26T00:00:00.000Z",
  kind: "File" as const,
  label: "index.ts",
  path: "src/index.ts",
  normalizedPath: "src/index.ts",
  language: "typescript",
  fileHash: "abc123",
  startLine: 1,
  endLine: 10,
  properties: {},
} as const;

const sampleEdge = {
  id: "edge:CONTAINS:file:deadbeef:src/index.ts:dir:deadbeef:src",
  snapshotId: "snap:deadbeef:2026-06-26T00:00:00.000Z",
  kind: "CONTAINS" as const,
  fromNodeId: "dir:deadbeef:src",
  toNodeId: "file:deadbeef:src/index.ts",
  properties: {},
} as const;

describe("Cartographer graph contract schemas (Todo 11)", () => {
  it("defines CartographerQueryStatus exactly as the six variants", () => {
    const expected = ["ok", "not_found", "ambiguous", "not_configured", "unsupported", "invalid_input"] as const;
    const parsed = expected.map((s) => CartographerQueryStatusSchema.safeParse(s));
    expect(parsed.every((p) => p.success)).toBe(true);
    // unknown rejected
    expect(CartographerQueryStatusSchema.safeParse("ok_but_fake").success).toBe(false);
    // type level: exhaustive check via assignment
    const allStatuses: CartographerQueryStatus[] = [...expected];
    expect(allStatuses).toHaveLength(6);
  });

  it("accepts every Phase 1 node kind and rejects unknown", () => {
    const allPhase1: GraphNodeKind[] = [
      "Project",
      "Package",
      "Directory",
      "File",
      "Symbol",
      "Function",
      "Class",
      "Interface",
      "TypeAlias",
      "Enum",
      "Route",
      "Test",
      "Config",
      "EnvironmentVariable",
      "Doc",
      "Tool",
      "Capability",
      "Skill",
      "Rule",
      "RunTrace",
    ];
    allPhase1.forEach((k: GraphNodeKind) => {
      expect(GraphNodeKindSchema.safeParse(k).success).toBe(true);
    });
    expect(GraphNodeKindSchema.safeParse("BananaNode").success).toBe(false);
  });

  it("accepts every Phase 1 edge kind and rejects unknown", () => {
    const allEdges = [
      "CONTAINS",
      "DEFINES",
      "IMPORTS",
      "EXPORTS",
      "CALLS",
      "REFERENCES",
      "TESTS",
      "HANDLES",
      "CONFIGURES",
      "READS",
      "WRITES",
      "OWNS",
      "VIOLATES",
      "FIXED_BY",
      "VALIDATED_BY",
      "DEPENDS_ON",
      "PROVIDED_BY",
      "WRAPPED_BY",
    ];
    allEdges.forEach((k) => {
      expect(GraphEdgeKindSchema.safeParse(k).success).toBe(true);
    });
    expect(GraphEdgeKindSchema.safeParse("CALLS_LLM").success).toBe(false);
  });

  it("distinguishes mustEmitNow vs schemaReserved node kinds", () => {
    // mustEmitNow are the baseline inventory-derived kinds
    expect(MUST_EMIT_NOW_NODE_KINDS).toContain("Project");
    expect(MUST_EMIT_NOW_NODE_KINDS).toContain("Package");
    expect(MUST_EMIT_NOW_NODE_KINDS).toContain("Directory");
    expect(MUST_EMIT_NOW_NODE_KINDS).toContain("File");
    expect(MUST_EMIT_NOW_NODE_KINDS).toContain("Doc");
    expect(MUST_EMIT_NOW_NODE_KINDS).toContain("Config");
    expect(MUST_EMIT_NOW_NODE_KINDS).toContain("Test");

    // schemaReserved are for later extraction/adapters
    expect(SCHEMA_RESERVED_NODE_KINDS).toContain("Symbol");
    expect(SCHEMA_RESERVED_NODE_KINDS).toContain("Function");
    expect(SCHEMA_RESERVED_NODE_KINDS).toContain("Class");
    expect(SCHEMA_RESERVED_NODE_KINDS).toContain("Route");
    expect(SCHEMA_RESERVED_NODE_KINDS).toContain("Tool");
    expect(SCHEMA_RESERVED_NODE_KINDS).toContain("Capability");
    expect(SCHEMA_RESERVED_NODE_KINDS).toContain("Skill");
    expect(SCHEMA_RESERVED_NODE_KINDS).toContain("Rule");
    expect(SCHEMA_RESERVED_NODE_KINDS).toContain("RunTrace");

    // no overlap
    const overlap = MUST_EMIT_NOW_NODE_KINDS.filter((k) => (SCHEMA_RESERVED_NODE_KINDS as readonly string[]).includes(k));
    expect(overlap).toEqual([]);
  });

  it("parses valid node and edge with strict objects", () => {
    const node = CartographerGraphNodeSchema.parse(sampleNode);
    expect(node.id).toBe("file:deadbeef:src/index.ts");
    expect(node.properties).toEqual({});

    const edge = CartographerGraphEdgeSchema.parse(sampleEdge);
    expect(edge.fromNodeId).toBe("dir:deadbeef:src");
    expect(edge.toNodeId).toBe("file:deadbeef:src/index.ts");
  });

  it("rejects strict extra properties on node and edge", () => {
    const badNode = { ...sampleNode, extra: "nope" };
    expect(CartographerGraphNodeSchema.safeParse(badNode).success).toBe(false);

    const badEdge = { ...sampleEdge, foo: 42 };
    expect(CartographerGraphEdgeSchema.safeParse(badEdge).success).toBe(false);
  });

  it("rejects edge missing toNodeId (required for all edges)", () => {
    const missingTo = {
      id: "e-missing",
      snapshotId: "snap:1",
      kind: "CONTAINS",
      fromNodeId: "from-1",
      properties: {},
      // no toNodeId
    };
    const result = CartographerGraphEdgeSchema.safeParse(missingTo);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i: { path: (string | number)[] }) => i.path.includes("toNodeId"))).toBe(true);
    }
  });

  it("requires deterministic-style IDs (string, non-empty); does not accept or require random UUIDs", () => {
    // Contracts accept any stable string id; tests must not use or assert randomUUID
    const nodeWithStableId = { ...sampleNode, id: "project:cafebabe" };
    expect(CartographerGraphNodeSchema.parse(nodeWithStableId).id).toBe("project:cafebabe");

    // random-looking but we do not generate; just ensure schema does not force uuid format
    const edgeWithStable = { ...sampleEdge, id: "edge:DEFINES:f:s" };
    expect(CartographerGraphEdgeSchema.parse(edgeWithStable).id).toBe("edge:DEFINES:f:s");
  });

  it("validates GraphSnapshot contract", () => {
    const snap = {
      id: "graph-snap:deadbeef:2026-06-26T00:00:00.000Z",
      repoRoot: "/repo",
      inventorySnapshotId: "snap:deadbeef:2026-06-26T00:00:00.000Z",
      createdAt: "2026-06-26T00:00:00.000Z",
      nodeCount: 42,
      edgeCount: 17,
    };
    expect(GraphSnapshotSchema.safeParse(snap).success).toBe(true);
    expect(GraphSnapshotSchema.safeParse({ ...snap, nodeCount: -1 }).success).toBe(false);
  });

  it("supports explicit typed query result variants including not_configured", () => {
    const okResult: GetFileGraphQueryResult = {
      status: "ok",
      graphNode: CartographerGraphNodeSchema.parse(sampleNode),
    };
    const parsedOk = GetFileGraphQueryResultSchema.safeParse(okResult);
    expect(parsedOk.success).toBe(true);

    const notFound = { status: "not_found", path: "src/missing.ts" };
    expect(GetFileGraphQueryResultSchema.safeParse(notFound).success).toBe(true);

    const notConfigured: GetFileGraphQueryResult = { status: "not_configured" };
    const parsedNc = GetFileGraphQueryResultSchema.safeParse(notConfigured);
    expect(parsedNc.success).toBe(true);
    if (parsedNc.success) {
      expect(parsedNc.data.status).toBe("not_configured");
    }

    const invalid = { status: "invalid_input", reason: "absolute path not allowed" };
    expect(GetFileGraphQueryResultSchema.safeParse(invalid).success).toBe(true);

    // ambiguous and unsupported also covered by the union
    expect(GetFileGraphQueryResultSchema.safeParse({ status: "ambiguous" }).success).toBe(true);
    expect(GetFileGraphQueryResultSchema.safeParse({ status: "unsupported" }).success).toBe(true);
  });

  it("rejects invalid query input (path must be present and non-empty)", () => {
    expect(GetFileGraphQueryInputSchema.safeParse({ path: "" }).success).toBe(false);
    expect(GetFileGraphQueryInputSchema.safeParse({ path: "src/ok.ts" }).success).toBe(true);
    expect(GetFileGraphQueryInputSchema.safeParse({}).success).toBe(false);
  });

  it("properties must be JSON-compatible (no functions, no undefined values, no symbols)", () => {
    const badPropsUnknown: unknown = { bad: undefined };
    const withBadProp = { ...sampleNode, properties: badPropsUnknown };
    expect(CartographerGraphNodeSchema.safeParse(withBadProp).success).toBe(false);

    const fnPropsUnknown: unknown = { fn: () => 1 };
    const withFn = { ...sampleNode, properties: fnPropsUnknown };
    expect(CartographerGraphNodeSchema.safeParse(withFn).success).toBe(false);
  });
});
