import { afterEach, describe, expect, it } from "vitest";

import {
  SqliteCartographerGraphStore,
  InMemoryCartographerGraphStore,
  type CartographerGraphNode,
  type CartographerGraphEdge,
  makeGraphSnapshotId,
  type CartographerGraphStore,
} from "../../src/cartographer";
import { createSqliteDriver, type SqlDriver } from "../../src/store";

const repoRoot = "/repo/root";
const otherRepoRoot = "/other/repo";
const inventoryA = "inv-snap-a";
const inventoryB = "inv-snap-b";
const fixedCreatedAt = "2026-06-20T01:02:03.000Z";
const laterCreatedAt = "2026-06-20T01:02:04.000Z";

function makeNode(id: string, snapshotId: string, label: string, kind: CartographerGraphNode["kind"] = "File"): CartographerGraphNode {
  return {
    id,
    snapshotId,
    kind,
    label,
    properties: {},
  };
}

function makeEdge(id: string, snapshotId: string, fromNodeId: string, toNodeId: string, kind: CartographerGraphEdge["kind"] = "CONTAINS"): CartographerGraphEdge {
  return {
    id,
    snapshotId,
    kind,
    fromNodeId,
    toNodeId,
    properties: {},
  };
}

describe("SqliteCartographerGraphStore", () => {
  const openDrivers = new Set<SqlDriver>();

  afterEach(() => {
    for (const driver of openDrivers) driver.close();
    openDrivers.clear();
  });

  function sqliteStore(): SqliteCartographerGraphStore {
    const driver = createSqliteDriver({ path: ":memory:" });
    openDrivers.add(driver);
    return new SqliteCartographerGraphStore({ driver });
  }

  it("creates graph tables and indexes idempotently and does not touch inventory tables", () => {
    const driver = createSqliteDriver({ path: ":memory:" });
    openDrivers.add(driver);

    expect(() => {
      new SqliteCartographerGraphStore({ driver });
      new SqliteCartographerGraphStore({ driver });
    }).not.toThrow();

    const tables = driver
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .map((r) => r.name);
    expect(tables).toContain("cartographer_graph_snapshots");
    expect(tables).toContain("cartographer_graph_nodes");
    expect(tables).toContain("cartographer_graph_edges");
    expect(tables).not.toContain("cartographer_snapshots");
    expect(tables).not.toContain("cartographer_files");

    const nodeIndexes = driver.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'cartographer_graph_nodes'").map((r) => r.name);
    const edgeIndexes = driver.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'cartographer_graph_edges'").map((r) => r.name);
    expect(nodeIndexes.some((n) => n.includes("repo_kind"))).toBe(true);
    expect(nodeIndexes.some((n) => n.includes("repo_path"))).toBe(true);
    expect(edgeIndexes.some((n) => n.includes("repo_kind_from"))).toBe(true);
    expect(edgeIndexes.some((n) => n.includes("repo_kind_to"))).toBe(true);
  });

  it("returns undefined for latest and empty arrays for lists on empty store", async () => {
    const store = sqliteStore();

    const latest = await store.getLatestGraphSnapshot(repoRoot);
    const snapshots = await store.listGraphSnapshots(repoRoot);
    const nodes = await store.listNodes("nonexistent");
    const edges = await store.listEdges("nonexistent");

    expect(latest).toBeUndefined();
    expect(snapshots).toEqual([]);
    expect(nodes).toEqual([]);
    expect(edges).toEqual([]);
  });

  it("puts a graph snapshot and returns it as latest; lookup by repoRoot + inventorySnapshotId works", async () => {
    const store = sqliteStore();
    const snapshotId = makeGraphSnapshotId(repoRoot, inventoryA);
    const nodes: readonly CartographerGraphNode[] = [makeNode("n1", snapshotId, "FileA")];
    const edges: readonly CartographerGraphEdge[] = [];

    const header = await store.putGraphSnapshot({
      repoRoot,
      inventorySnapshotId: inventoryA,
      createdAt: fixedCreatedAt,
      nodes,
      edges,
    });

    const latest = await store.getLatestGraphSnapshot(repoRoot);
    const byInv = await store.getGraphSnapshot(repoRoot, inventoryA);
    const listed = await store.listGraphSnapshots(repoRoot);

    expect(header).toEqual({
      id: snapshotId,
      repoRoot,
      inventorySnapshotId: inventoryA,
      createdAt: fixedCreatedAt,
      nodeCount: 1,
      edgeCount: 0,
    });
    expect(latest).toEqual(header);
    expect(byInv).toEqual(header);
    expect(listed).toEqual([header]);
  });

  it("lists snapshots by createdAt descending, id ascending for ties", async () => {
    const store = sqliteStore();
    const snapAId = makeGraphSnapshotId(repoRoot, inventoryA);
    const snapBId = makeGraphSnapshotId(repoRoot, inventoryB);

    await store.putGraphSnapshot({ repoRoot, inventorySnapshotId: inventoryB, createdAt: laterCreatedAt, nodes: [], edges: [] });
    await store.putGraphSnapshot({ repoRoot, inventorySnapshotId: inventoryA, createdAt: fixedCreatedAt, nodes: [], edges: [] });

    const listed = await store.listGraphSnapshots(repoRoot);

    expect(listed.map((s) => s.id)).toEqual([snapBId, snapAId]);
  });

  it("stores and returns nodes and edges sorted by id; different repos are isolated", async () => {
    const store = sqliteStore();
    const snapA = makeGraphSnapshotId(repoRoot, inventoryA);
    const snapOther = makeGraphSnapshotId(otherRepoRoot, inventoryA);

    const nodesA: readonly CartographerGraphNode[] = [
      makeNode("n-b", snapA, "B"),
      makeNode("n-a", snapA, "A"),
    ];
    const edgesA: readonly CartographerGraphEdge[] = [
      makeEdge("e-b", snapA, "n-a", "n-b"),
      makeEdge("e-a", snapA, "n-a", "n-a"),
    ];

    await store.putGraphSnapshot({ repoRoot, inventorySnapshotId: inventoryA, createdAt: fixedCreatedAt, nodes: nodesA, edges: edgesA });
    await store.putGraphSnapshot({ repoRoot: otherRepoRoot, inventorySnapshotId: inventoryA, createdAt: fixedCreatedAt, nodes: [makeNode("n-x", snapOther, "X")], edges: [] });

    const nodes = await store.listNodes(snapA);
    const edges = await store.listEdges(snapA);
    const otherNodes = await store.listNodes(snapOther);

    expect(nodes.map((n) => n.id)).toEqual(["n-a", "n-b"]);
    expect(edges.map((e) => e.id)).toEqual(["e-a", "e-b"]);
    expect(otherNodes.map((n) => n.id)).toEqual(["n-x"]);
  });

  it("returns sorted clones and never mutates caller-owned arrays or returned objects", async () => {
    const store = sqliteStore();
    const snapId = makeGraphSnapshotId(repoRoot, inventoryA);
    const inputNodes: CartographerGraphNode[] = [makeNode("n1", snapId, "Original")];
    const inputEdges: CartographerGraphEdge[] = [];

    await store.putGraphSnapshot({ repoRoot, inventorySnapshotId: inventoryA, createdAt: fixedCreatedAt, nodes: inputNodes, edges: inputEdges });

    const [firstInput] = inputNodes;
    if (firstInput !== undefined) {
      firstInput.label = "MutatedInput";
    }

    const firstRead = await store.listNodes(snapId);
    const [returned] = firstRead;
    if (returned !== undefined) {
      returned.label = "MutatedReturned";
    }

    const secondRead = await store.listNodes(snapId);

    expect(secondRead).toEqual([makeNode("n1", snapId, "Original")]);
    const [secondFirst] = secondRead;
    expect(secondFirst?.label).toBe("Original");
  });

  it("replaces nodes/edges on duplicate (repoRoot, inventorySnapshotId) primary key deterministically", async () => {
    const store = sqliteStore();
    const snapId = makeGraphSnapshotId(repoRoot, inventoryA);

    const firstNodes = [makeNode("n-first", snapId, "First")];
    const firstEdges = [makeEdge("e-first", snapId, "n-first", "n-first")];
    await store.putGraphSnapshot({ repoRoot, inventorySnapshotId: inventoryA, createdAt: fixedCreatedAt, nodes: firstNodes, edges: firstEdges });

    const secondNodes = [makeNode("n-second", snapId, "Second")];
    const secondEdges: CartographerGraphEdge[] = [];
    const replaced = await store.putGraphSnapshot({ repoRoot, inventorySnapshotId: inventoryA, createdAt: laterCreatedAt, nodes: secondNodes, edges: secondEdges });

    const listed = await store.listGraphSnapshots(repoRoot);
    const nodes = await store.listNodes(snapId);
    const edges = await store.listEdges(snapId);

    expect(replaced.nodeCount).toBe(1);
    expect(replaced.edgeCount).toBe(0);
    expect(replaced.createdAt).toBe(laterCreatedAt);
    expect(listed).toHaveLength(1);
    const [firstListed] = listed;
    expect(firstListed?.createdAt).toBe(laterCreatedAt);
    expect(nodes).toEqual([makeNode("n-second", snapId, "Second")]);
    expect(edges).toEqual([]);
  });

  it("getGraphSnapshot by repo+inv returns undefined for unknown inventory snapshot", async () => {
    const store = sqliteStore();
    await store.putGraphSnapshot({ repoRoot, inventorySnapshotId: inventoryA, createdAt: fixedCreatedAt, nodes: [], edges: [] });

    const missing = await store.getGraphSnapshot(repoRoot, inventoryB);
    expect(missing).toBeUndefined();
  });

  it("round-trips JSON properties without loss or type escape", async () => {
    const store = sqliteStore();
    const snapId = makeGraphSnapshotId(repoRoot, inventoryA);
    const node: CartographerGraphNode = {
      id: "n-json",
      snapshotId: snapId,
      kind: "File",
      label: "json",
      properties: { a: 1, b: "x", c: true, d: null, e: [1, { f: "g" }], h: { i: false } },
    };
    const edge: CartographerGraphEdge = {
      id: "e-json",
      snapshotId: snapId,
      kind: "CONTAINS",
      fromNodeId: "n-json",
      toNodeId: "n-json",
      properties: { arr: [{ x: 1 }], obj: { y: "z" } },
    };

    await store.putGraphSnapshot({ repoRoot, inventorySnapshotId: inventoryA, createdAt: fixedCreatedAt, nodes: [node], edges: [edge] });

    const nodes = await store.listNodes(snapId);
    const edges = await store.listEdges(snapId);

    expect(nodes[0]?.properties).toEqual(node.properties);
    expect(edges[0]?.properties).toEqual(edge.properties);
  });

  it("rolls back entire snapshot write on injected failure after snapshot header (no partial nodes/edges)", async () => {
    const innerDriver = createSqliteDriver({ path: ":memory:" });
    openDrivers.add(innerDriver);

    const failingDriver = new (class implements SqlDriver {
      private headerWritten = false;
      constructor(private readonly inner: SqlDriver) {}
      get dialect() {
        return this.inner.dialect;
      }
      exec(sql: string): void {
        this.inner.exec(sql);
      }
      run(sql: string, params?: unknown[]): void {
        if (/INSERT INTO cartographer_graph_snapshots/i.test(sql)) {
          this.inner.run(sql, params);
          this.headerWritten = true;
          return;
        }
        if (this.headerWritten && /cartographer_graph_nodes/i.test(sql)) {
          throw new Error("graph-atomic-test: injected failure after header");
        }
        this.inner.run(sql, params);
      }
      get<T = unknown>(sql: string, params?: unknown[]): T | undefined {
        return this.inner.get<T>(sql, params);
      }
      all<T = unknown>(sql: string, params?: unknown[]): T[] {
        return this.inner.all<T>(sql, params);
      }
      close(): void {
        this.inner.close();
      }
    })(innerDriver);

    const store = new SqliteCartographerGraphStore({ driver: failingDriver });

    const snapId = makeGraphSnapshotId(repoRoot, inventoryA);
    await expect(
      store.putGraphSnapshot({
        repoRoot,
        inventorySnapshotId: inventoryA,
        createdAt: fixedCreatedAt,
        nodes: [makeNode("n1", snapId, "N")],
        edges: [],
      }),
    ).rejects.toThrow(/injected failure after header/i);

    // No partial snapshot visible
    expect(await store.getLatestGraphSnapshot(repoRoot)).toBeUndefined();
    expect(await store.listGraphSnapshots(repoRoot)).toEqual([]);
    expect(await store.listNodes(snapId)).toEqual([]);
    expect(await store.listEdges(snapId)).toEqual([]);
  });

  it("matches in-memory observable behavior for a shared sequence of operations", async () => {
    const memory = new InMemoryCartographerGraphStore();
    const sqlite = sqliteStore();
    const stores: readonly CartographerGraphStore[] = [memory, sqlite];
    const snapA = makeGraphSnapshotId(repoRoot, inventoryA);
    const snapB = makeGraphSnapshotId(repoRoot, inventoryB);

    await expectGraphSurfacesEqual(memory, sqlite, [snapA, snapB]);

    await applyToAll(stores, (s) =>
      s.putGraphSnapshot({
        repoRoot,
        inventorySnapshotId: inventoryA,
        createdAt: fixedCreatedAt,
        nodes: [makeNode("n-b", snapA, "B"), makeNode("n-a", snapA, "A")],
        edges: [makeEdge("e-b", snapA, "n-a", "n-b"), makeEdge("e-a", snapA, "n-a", "n-a")],
      }),
    );
    await expectGraphSurfacesEqual(memory, sqlite, [snapA, snapB]);

    await applyToAll(stores, (s) =>
      s.putGraphSnapshot({
        repoRoot,
        inventorySnapshotId: inventoryB,
        createdAt: laterCreatedAt,
        nodes: [makeNode("n-x", snapB, "X")],
        edges: [],
      }),
    );
    await expectGraphSurfacesEqual(memory, sqlite, [snapA, snapB]);

    // Replacement on same key
    await applyToAll(stores, (s) =>
      s.putGraphSnapshot({
        repoRoot,
        inventorySnapshotId: inventoryA,
        createdAt: laterCreatedAt,
        nodes: [makeNode("n-replaced", snapA, "R")],
        edges: [],
      }),
    );
    await expectGraphSurfacesEqual(memory, sqlite, [snapA, snapB]);
  });
});

async function applyToAll(stores: readonly CartographerGraphStore[], action: (store: CartographerGraphStore) => Promise<unknown>): Promise<void> {
  for (const store of stores) await action(store);
}

async function expectGraphSurfacesEqual(memory: CartographerGraphStore, sqlite: CartographerGraphStore, snapshotIds: readonly string[]): Promise<void> {
  expect(await readGraphSurface(sqlite, snapshotIds)).toEqual(await readGraphSurface(memory, snapshotIds));
}

async function readGraphSurface(store: CartographerGraphStore, snapshotIds: readonly string[]): Promise<unknown> {
  const nodes: Record<string, readonly CartographerGraphNode[]> = {};
  const edges: Record<string, readonly CartographerGraphEdge[]> = {};
  for (const id of snapshotIds) {
    nodes[id] = await store.listNodes(id);
    edges[id] = await store.listEdges(id);
  }
  return {
    latest: await store.getLatestGraphSnapshot(repoRoot),
    unknownLatest: await store.getLatestGraphSnapshot("/unknown/root"),
    snapshots: await store.listGraphSnapshots(repoRoot),
    nodes,
    edges,
  };
}
