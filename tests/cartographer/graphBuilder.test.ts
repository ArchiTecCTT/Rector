import { describe, expect, it } from "vitest";

import {
  buildGraphSnapshot,
  InMemoryCartographerGraphStore,
  SqliteCartographerGraphStore,
} from "../../src/cartographer";
import { createSqliteDriver, type SqlDriver } from "../../src/store";
import {
  makeStructuralMiniFixture,
  scanStructuralMiniFixture,
} from "./repoScannerTestHarness";

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

type SnapshotWithCreatedAt = { readonly createdAt: string; readonly [k: string]: unknown };

function stripSnapshotVolatile(s: SnapshotWithCreatedAt): Omit<SnapshotWithCreatedAt, "createdAt"> {
  const { createdAt: _c, ...rest } = s;
  return rest;
}

describe("graphBuilder", () => {
  it("builds Project, Package, Directory, File/Doc/Config/Test nodes and CONTAINS edges from structural mini fixture", async () => {
    const repoRoot = await makeStructuralMiniFixture();
    const scan = await scanStructuralMiniFixture();
    const invId = scan.snapshot.id;

    const result = await buildGraphSnapshot({
      repoRoot,
      inventorySnapshotId: invId,
      createdAt: "2026-06-20T00:00:00.000Z",
      files: scan.files,
    });

    // Snapshot header
    expect(result.snapshot.repoRoot).toBe(repoRoot);
    expect(result.snapshot.inventorySnapshotId).toBe(invId);
    expect(result.snapshot.nodeCount).toBe(result.nodes.length);
    expect(result.snapshot.edgeCount).toBe(result.edges.length);

    // Collect kinds present
    const kinds = new Set(result.nodes.map((n) => n.kind));
    expect(kinds.has("Project")).toBe(true);
    expect(kinds.has("Package")).toBe(true);
    expect(kinds.has("Directory")).toBe(true);
    // We must have at least one of each file-level kind exercised by the fixture
    expect(kinds.has("File")).toBe(true);
    expect(kinds.has("Doc")).toBe(true);
    expect(kinds.has("Config")).toBe(true);
    expect(kinds.has("Test")).toBe(true);

    // Specific nodes by path/kind
    const project = result.nodes.find((n) => n.kind === "Project");
    expect(project).toBeDefined();
    expect(project?.normalizedPath).toBe(".");

    const pkg = result.nodes.find((n) => n.kind === "Package");
    expect(pkg).toBeDefined();
    expect(pkg?.normalizedPath).toBe("package.json");

    const doc = result.nodes.find((n) => n.kind === "Doc" && n.normalizedPath === "docs/architecture.md");
    expect(doc).toBeDefined();

    const testNode = result.nodes.find((n) => n.kind === "Test" && n.normalizedPath === "src/app.test.ts");
    expect(testNode).toBeDefined();

    const configPkg = result.nodes.find((n) => n.kind === "Config" && n.normalizedPath === "package.json");
    expect(configPkg).toBeDefined();

    const configTs = result.nodes.find((n) => n.kind === "Config" && n.normalizedPath === "tsconfig.json");
    expect(configTs).toBeDefined();

    // All nodes sorted by id
    const nodeIds = result.nodes.map((n) => n.id);
    expect(nodeIds).toEqual([...nodeIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));

    // Edges are CONTAINS and sorted
    for (const e of result.edges) {
      expect(e.kind).toBe("CONTAINS");
    }
    const edgeIds = result.edges.map((e) => e.id);
    expect(edgeIds).toEqual([...edgeIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));

    // Project contains Package
    if (project === undefined || pkg === undefined) {
      throw new Error("expected project and package nodes");
    }
    const projectToPkg = result.edges.find(
      (e) => e.fromNodeId === project.id && e.toNodeId === pkg.id && e.kind === "CONTAINS",
    );
    expect(projectToPkg).toBeDefined();

    // There is a CONTAINS for the doc
    if (doc === undefined) {
      throw new Error("expected doc node");
    }
    const docId = doc.id;
    const containsDoc = result.edges.some((e) => e.toNodeId === docId && e.kind === "CONTAINS");
    expect(containsDoc).toBe(true);

    // There is a CONTAINS for the test file
    if (testNode === undefined) {
      throw new Error("expected test node");
    }
    const testId = testNode.id;
    const containsTest = result.edges.some((e) => e.toNodeId === testId && e.kind === "CONTAINS");
    expect(containsTest).toBe(true);
  });

  it("produces identical nodes and edges for two builds (timestamp stripping)", async () => {
    const repoRoot = await makeStructuralMiniFixture();
    const scan = await scanStructuralMiniFixture();
    const invId = scan.snapshot.id;

    const r1 = await buildGraphSnapshot({
      repoRoot,
      inventorySnapshotId: invId,
      createdAt: "2026-06-20T00:00:00.000Z",
      files: scan.files,
    });
    const r2 = await buildGraphSnapshot({
      repoRoot,
      inventorySnapshotId: invId,
      createdAt: "2026-06-21T12:34:56.000Z",
      files: scan.files,
    });

    const s1 = stripSnapshotVolatile(r1.snapshot);
    const s2 = stripSnapshotVolatile(r2.snapshot);
    expect(s1).toEqual(s2);

    expect(r1.nodes).toEqual(r2.nodes);
    expect(r1.edges).toEqual(r2.edges);
  });

  it("produces stable node/edge ids and sorted order regardless of input file order (shuffle stability)", async () => {
    const repoRoot = await makeStructuralMiniFixture();
    const scan = await scanStructuralMiniFixture();
    const invId = scan.snapshot.id;

    const base = await buildGraphSnapshot({
      repoRoot,
      inventorySnapshotId: invId,
      createdAt: "2026-06-20T00:00:00.000Z",
      files: scan.files,
    });

    // Shuffle a copy of files (deterministic shuffle via sort by hash of index or reverse+sort)
    const shuffled = [...scan.files].sort((a, b) => {
      // simple deterministic but non-sorted order: reverse then stable by length then name
      if (a.normalizedPath.length !== b.normalizedPath.length) {
        return b.normalizedPath.length - a.normalizedPath.length;
      }
      return a.normalizedPath < b.normalizedPath ? 1 : a.normalizedPath > b.normalizedPath ? -1 : 0;
    });

    const shuf = await buildGraphSnapshot({
      repoRoot,
      inventorySnapshotId: invId,
      createdAt: "2026-06-20T00:00:00.000Z",
      files: shuffled,
    });

    const baseNodeIds = base.nodes.map((n) => n.id);
    const shufNodeIds = shuf.nodes.map((n) => n.id);
    expect(shufNodeIds).toEqual(baseNodeIds);

    const baseEdgeIds = base.edges.map((e) => e.id);
    const shufEdgeIds = shuf.edges.map((e) => e.id);
    expect(shufEdgeIds).toEqual(baseEdgeIds);

    // Output is sorted
    expect(shuf.nodes).toEqual([...shuf.nodes].sort(byId));
    expect(shuf.edges).toEqual([...shuf.edges].sort(byId));
  });

  it("in-memory and SQLite stores produce identical sorted nodes/edges for builder output", async () => {
    const repoRoot = await makeStructuralMiniFixture();
    const scan = await scanStructuralMiniFixture();
    const invId = scan.snapshot.id;
    const createdAt = "2026-06-20T00:00:00.000Z";

    const built = await buildGraphSnapshot({
      repoRoot,
      inventorySnapshotId: invId,
      createdAt,
      files: scan.files,
    });

    const mem = new InMemoryCartographerGraphStore();
    const driver = createSqliteDriver({ path: ":memory:" });
    const sql = new SqliteCartographerGraphStore({ driver });

    await mem.putGraphSnapshot({
      repoRoot,
      inventorySnapshotId: invId,
      createdAt,
      nodes: built.nodes,
      edges: built.edges,
    });
    await sql.putGraphSnapshot({
      repoRoot,
      inventorySnapshotId: invId,
      createdAt,
      nodes: built.nodes,
      edges: built.edges,
    });

    const snapId = built.snapshot.id;
    const memNodes = await mem.listNodes(snapId);
    const memEdges = await mem.listEdges(snapId);
    const sqlNodes = await sql.listNodes(snapId);
    const sqlEdges = await sql.listEdges(snapId);

    expect(memNodes).toEqual(built.nodes);
    expect(memEdges).toEqual(built.edges);
    expect(sqlNodes).toEqual(built.nodes);
    expect(sqlEdges).toEqual(built.edges);
    expect(sqlNodes).toEqual(memNodes);
    expect(sqlEdges).toEqual(memEdges);

    driver.close();
  });
});
