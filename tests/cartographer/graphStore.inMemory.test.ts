import { describe, expect, it } from "vitest";
import {
  InMemoryCartographerGraphStore,
  type CartographerGraphNode,
  type CartographerGraphEdge,
  makeGraphSnapshotId,
} from "../../src/cartographer";

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

describe("InMemoryCartographerGraphStore", () => {
  it("returns undefined for latest and empty arrays for lists on empty store", async () => {
    const store = new InMemoryCartographerGraphStore();

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
    const store = new InMemoryCartographerGraphStore();
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
    const store = new InMemoryCartographerGraphStore();
    const snapAId = makeGraphSnapshotId(repoRoot, inventoryA);
    const snapBId = makeGraphSnapshotId(repoRoot, inventoryB);

    await store.putGraphSnapshot({ repoRoot, inventorySnapshotId: inventoryB, createdAt: laterCreatedAt, nodes: [], edges: [] });
    await store.putGraphSnapshot({ repoRoot, inventorySnapshotId: inventoryA, createdAt: fixedCreatedAt, nodes: [], edges: [] });

    const listed = await store.listGraphSnapshots(repoRoot);

    expect(listed.map((snapshotItem: { id: string }) => snapshotItem.id)).toEqual([snapBId, snapAId]);
  });

  it("selects latest by createdAt across insertion orders", async () => {
    const first = new InMemoryCartographerGraphStore();
    const second = new InMemoryCartographerGraphStore();

    await first.putGraphSnapshot({ repoRoot, inventorySnapshotId: inventoryA, createdAt: fixedCreatedAt, nodes: [], edges: [] });
    const firstLater = await first.putGraphSnapshot({ repoRoot, inventorySnapshotId: inventoryB, createdAt: laterCreatedAt, nodes: [], edges: [] });

    const secondLater = await second.putGraphSnapshot({ repoRoot, inventorySnapshotId: inventoryB, createdAt: laterCreatedAt, nodes: [], edges: [] });
    await second.putGraphSnapshot({ repoRoot, inventorySnapshotId: inventoryA, createdAt: fixedCreatedAt, nodes: [], edges: [] });

    expect(await first.getLatestGraphSnapshot(repoRoot)).toEqual(firstLater);
    expect(await second.getLatestGraphSnapshot(repoRoot)).toEqual(secondLater);
  });

  it("stores and returns nodes and edges sorted by id; different repos are isolated", async () => {
    const store = new InMemoryCartographerGraphStore();
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

    expect(nodes.map((nodeItem: { id: string }) => nodeItem.id)).toEqual(["n-a", "n-b"]);
    expect(edges.map((edgeItem: { id: string }) => edgeItem.id)).toEqual(["e-a", "e-b"]);
    expect(otherNodes.map((nodeItem: { id: string }) => nodeItem.id)).toEqual(["n-x"]);
  });

  it("returns sorted clones and never mutates caller-owned arrays or returned objects", async () => {
    const store = new InMemoryCartographerGraphStore();
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
    const store = new InMemoryCartographerGraphStore();
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
    const store = new InMemoryCartographerGraphStore();
    await store.putGraphSnapshot({ repoRoot, inventorySnapshotId: inventoryA, createdAt: fixedCreatedAt, nodes: [], edges: [] });

    const missing = await store.getGraphSnapshot(repoRoot, inventoryB);
    expect(missing).toBeUndefined();
  });
});
