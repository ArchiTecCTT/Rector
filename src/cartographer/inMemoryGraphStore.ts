import type { CartographerGraphEdge, CartographerGraphNode, GraphSnapshot } from "./graphTypes";
import type { CartographerGraphStore, PutGraphSnapshotInput } from "./graphStore";
import { makeGraphSnapshotId } from "./graphIds";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareSnapshots(left: GraphSnapshot, right: GraphSnapshot): number {
  const createdAtOrder = compareUtf16(right.createdAt, left.createdAt);
  return createdAtOrder === 0 ? compareUtf16(left.id, right.id) : createdAtOrder;
}

export class InMemoryCartographerGraphStore implements CartographerGraphStore {
  private readonly snapshotsByRepoRoot = new Map<string, GraphSnapshot[]>();
  private readonly nodesBySnapshotId = new Map<string, CartographerGraphNode[]>();
  private readonly edgesBySnapshotId = new Map<string, CartographerGraphEdge[]>();

  async putGraphSnapshot(input: PutGraphSnapshotInput): Promise<GraphSnapshot> {
    const id = makeGraphSnapshotId(input.repoRoot, input.inventorySnapshotId);
    const header: GraphSnapshot = {
      id,
      repoRoot: input.repoRoot,
      inventorySnapshotId: input.inventorySnapshotId,
      createdAt: input.createdAt,
      nodeCount: input.nodes.length,
      edgeCount: input.edges.length,
    };

    // Replace existing for this (repoRoot, inventorySnapshotId) deterministically
    const repoSnapshots = this.repoSnapshots(input.repoRoot);
    const existingIndex = repoSnapshots.findIndex((s) => s.id === id);
    if (existingIndex >= 0) {
      repoSnapshots.splice(existingIndex, 1);
    }
    repoSnapshots.push(clone(header));

    // Replace nodes/edges for this snapshot id
    this.nodesBySnapshotId.set(id, input.nodes.map((n) => clone(n)));
    this.edgesBySnapshotId.set(id, input.edges.map((e) => clone(e)));

    return clone(header);
  }

  async getLatestGraphSnapshot(repoRoot: string): Promise<GraphSnapshot | undefined> {
    const snapshots = await this.listGraphSnapshots(repoRoot);
    return snapshots[0];
  }

  async getGraphSnapshot(repoRoot: string, inventorySnapshotId: string): Promise<GraphSnapshot | undefined> {
    const id = makeGraphSnapshotId(repoRoot, inventorySnapshotId);
    const snapshots = this.snapshotsByRepoRoot.get(repoRoot) ?? [];
    const found = snapshots.find((s) => s.id === id);
    return found ? clone(found) : undefined;
  }

  async listGraphSnapshots(repoRoot: string): Promise<readonly GraphSnapshot[]> {
    const list = this.snapshotsByRepoRoot.get(repoRoot) ?? [];
    return [...list].sort(compareSnapshots).map(clone);
  }

  async listNodes(graphSnapshotId: string): Promise<readonly CartographerGraphNode[]> {
    const nodes = this.nodesBySnapshotId.get(graphSnapshotId) ?? [];
    return [...nodes].sort((a, b) => compareUtf16(a.id, b.id)).map(clone);
  }

  async listEdges(graphSnapshotId: string): Promise<readonly CartographerGraphEdge[]> {
    const edges = this.edgesBySnapshotId.get(graphSnapshotId) ?? [];
    return [...edges].sort((a, b) => compareUtf16(a.id, b.id)).map(clone);
  }

  private repoSnapshots(repoRoot: string): GraphSnapshot[] {
    const existing = this.snapshotsByRepoRoot.get(repoRoot);
    if (existing !== undefined) return existing;
    const arr: GraphSnapshot[] = [];
    this.snapshotsByRepoRoot.set(repoRoot, arr);
    return arr;
  }
}
