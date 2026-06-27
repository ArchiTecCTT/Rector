import type { CartographerGraphEdge, CartographerGraphNode, GraphSnapshot } from "./graphTypes";

/**
 * Input for storing a graph snapshot.
 * One inventory snapshot maps to exactly one graph snapshot (by repoRoot + inventorySnapshotId).
 */
export type PutGraphSnapshotInput = {
  readonly repoRoot: string;
  readonly inventorySnapshotId: string;
  readonly createdAt: string;
  readonly nodes: readonly CartographerGraphNode[];
  readonly edges: readonly CartographerGraphEdge[];
};

/**
 * CartographerGraphStore contract.
 * - Latest lookup by repoRoot (most recent createdAt).
 * - Exact lookup by (repoRoot, inventorySnapshotId).
 * - History retained; no automatic cleanup.
 * - All list/return methods return sorted clones; never mutate caller data.
 */
export interface CartographerGraphStore {
  /**
   * Store (or replace) the graph for a given (repoRoot, inventorySnapshotId).
   * Returns the snapshot header with counts.
   * Replacement on duplicate key is deterministic (last write wins for that key).
   */
  putGraphSnapshot(input: PutGraphSnapshotInput): Promise<GraphSnapshot>;

  /** Latest graph snapshot header for the repo, or undefined if none. */
  getLatestGraphSnapshot(repoRoot: string): Promise<GraphSnapshot | undefined>;

  /** Exact graph snapshot header by repo + inventory snapshot id, or undefined. */
  getGraphSnapshot(repoRoot: string, inventorySnapshotId: string): Promise<GraphSnapshot | undefined>;

  /** All graph snapshot headers for repo, sorted by createdAt desc, id asc for ties. */
  listGraphSnapshots(repoRoot: string): Promise<readonly GraphSnapshot[]>;

  /** Nodes for a snapshot id, sorted by node id ascending. Cloned. */
  listNodes(graphSnapshotId: string): Promise<readonly CartographerGraphNode[]>;

  /** Edges for a snapshot id, sorted by edge id ascending. Cloned. */
  listEdges(graphSnapshotId: string): Promise<readonly CartographerGraphEdge[]>;
}
