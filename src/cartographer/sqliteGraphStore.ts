import { dirname } from "node:path";

import { ensureRestrictedDir, ensureRestrictedFile } from "../security/filePermissions";
import { DEFAULT_SQLITE_PATH } from "../store";
import { createSqliteDriver, type SqlDriver } from "../store/sqlRectorStore";
import { makeGraphSnapshotId } from "./graphIds";
import {
  CartographerGraphEdgeSchema,
  CartographerGraphNodeSchema,
} from "./graphSchemas";
import type { CartographerGraphEdge, CartographerGraphNode, GraphSnapshot } from "./graphTypes";
import type { CartographerGraphStore, PutGraphSnapshotInput } from "./graphStore";

export type SqliteCartographerGraphStoreOptions = {
  readonly driver?: SqlDriver;
  readonly path?: string;
};

type GraphSnapshotRow = {
  readonly id: string;
  readonly repo_root: string;
  readonly inventory_snapshot_id: string;
  readonly created_at: string;
  readonly node_count: number | bigint;
  readonly edge_count: number | bigint;
};

type GraphNodeRow = {
  readonly id: string;
  readonly snapshot_id: string;
  readonly repo_root: string;
  readonly kind: string;
  readonly label: string;
  readonly path: string | null;
  readonly normalized_path: string | null;
  readonly symbol_name: string | null;
  readonly symbol_kind: string | null;
  readonly language: string | null;
  readonly file_hash: string | null;
  readonly start_line: number | null;
  readonly end_line: number | null;
  readonly properties_json: string;
};

type GraphEdgeRow = {
  readonly id: string;
  readonly snapshot_id: string;
  readonly repo_root: string;
  readonly kind: string;
  readonly from_node_id: string;
  readonly to_node_id: string;
  readonly path: string | null;
  readonly evidence_json: string | null;
  readonly properties_json: string;
};

export class SqliteCartographerGraphStore implements CartographerGraphStore {
  private readonly driver: SqlDriver;

  constructor(options: SqliteCartographerGraphStoreOptions = {}) {
    const path = options.path ?? DEFAULT_SQLITE_PATH;
    if (options.driver) {
      this.driver = options.driver;
    } else {
      if (path !== ":memory:") ensureRestrictedDir(dirname(path));
      this.driver = createSqliteDriver({ path });
      if (path !== ":memory:") ensureRestrictedFile(path);
    }
    this.migrate();
  }

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

    this.driver.exec("BEGIN");
    try {
      // Deterministic replacement for (repoRoot, inventorySnapshotId) key
      this.driver.run("DELETE FROM cartographer_graph_snapshots WHERE id = ?", [id]);
      this.driver.run(
        `INSERT INTO cartographer_graph_snapshots (id, repo_root, inventory_snapshot_id, created_at, node_count, edge_count)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [header.id, header.repoRoot, header.inventorySnapshotId, header.createdAt, header.nodeCount, header.edgeCount],
      );

      this.driver.run("DELETE FROM cartographer_graph_nodes WHERE snapshot_id = ?", [id]);
      this.driver.run("DELETE FROM cartographer_graph_edges WHERE snapshot_id = ?", [id]);

      for (const node of input.nodes) {
        this.driver.run(
          `INSERT INTO cartographer_graph_nodes (id, snapshot_id, repo_root, kind, label, path, normalized_path, symbol_name, symbol_kind, language, file_hash, start_line, end_line, properties_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            node.id,
            node.snapshotId,
            header.repoRoot,
            node.kind,
            node.label,
            node.path ?? null,
            node.normalizedPath ?? null,
            node.symbolName ?? null,
            node.symbolKind ?? null,
            node.language ?? null,
            node.fileHash ?? null,
            node.startLine ?? null,
            node.endLine ?? null,
            JSON.stringify(node.properties),
          ],
        );
      }

      for (const edge of input.edges) {
        this.driver.run(
          `INSERT INTO cartographer_graph_edges (id, snapshot_id, repo_root, kind, from_node_id, to_node_id, path, evidence_json, properties_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            edge.id,
            edge.snapshotId,
            header.repoRoot,
            edge.kind,
            edge.fromNodeId,
            edge.toNodeId,
            edge.path ?? null,
            edge.evidence ? JSON.stringify(edge.evidence) : null,
            JSON.stringify(edge.properties),
          ],
        );
      }

      this.driver.exec("COMMIT");
      return clone(header);
    } catch (error) {
      this.driver.exec("ROLLBACK");
      throw error;
    }
  }

  async getLatestGraphSnapshot(repoRoot: string): Promise<GraphSnapshot | undefined> {
    const row = this.driver.get<GraphSnapshotRow>(
      `SELECT id, repo_root, inventory_snapshot_id, created_at, node_count, edge_count
       FROM cartographer_graph_snapshots WHERE repo_root = ? ORDER BY created_at DESC, id ASC LIMIT 1`,
      [repoRoot],
    );
    return row === undefined ? undefined : snapshotFromRow(row);
  }

  async getGraphSnapshot(repoRoot: string, inventorySnapshotId: string): Promise<GraphSnapshot | undefined> {
    const id = makeGraphSnapshotId(repoRoot, inventorySnapshotId);
    const row = this.driver.get<GraphSnapshotRow>(
      `SELECT id, repo_root, inventory_snapshot_id, created_at, node_count, edge_count FROM cartographer_graph_snapshots WHERE id = ?`,
      [id],
    );
    return row === undefined ? undefined : snapshotFromRow(row);
  }

  async listGraphSnapshots(repoRoot: string): Promise<readonly GraphSnapshot[]> {
    return this.driver
      .all<GraphSnapshotRow>(
        `SELECT id, repo_root, inventory_snapshot_id, created_at, node_count, edge_count
         FROM cartographer_graph_snapshots WHERE repo_root = ? ORDER BY created_at DESC, id ASC`,
        [repoRoot],
      )
      .map(snapshotFromRow);
  }

  async listNodes(graphSnapshotId: string): Promise<readonly CartographerGraphNode[]> {
    const rows = this.driver.all<GraphNodeRow>(
      `SELECT id, snapshot_id, repo_root, kind, label, path, normalized_path, symbol_name, symbol_kind, language, file_hash, start_line, end_line, properties_json
       FROM cartographer_graph_nodes WHERE snapshot_id = ? ORDER BY id ASC`,
      [graphSnapshotId],
    );
    return rows.map(nodeFromRow);
  }

  async listEdges(graphSnapshotId: string): Promise<readonly CartographerGraphEdge[]> {
    const rows = this.driver.all<GraphEdgeRow>(
      `SELECT id, snapshot_id, repo_root, kind, from_node_id, to_node_id, path, evidence_json, properties_json
       FROM cartographer_graph_edges WHERE snapshot_id = ? ORDER BY id ASC`,
      [graphSnapshotId],
    );
    return rows.map(edgeFromRow);
  }

  private migrate(): void {
    this.driver.exec(
      "CREATE TABLE IF NOT EXISTS cartographer_graph_snapshots (id TEXT PRIMARY KEY, repo_root TEXT NOT NULL, inventory_snapshot_id TEXT NOT NULL, created_at TEXT NOT NULL, node_count INTEGER NOT NULL, edge_count INTEGER NOT NULL)",
    );
    this.driver.exec(
      "CREATE TABLE IF NOT EXISTS cartographer_graph_nodes (id TEXT NOT NULL, snapshot_id TEXT NOT NULL, repo_root TEXT NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL, path TEXT, normalized_path TEXT, symbol_name TEXT, symbol_kind TEXT, language TEXT, file_hash TEXT, start_line INTEGER, end_line INTEGER, properties_json TEXT NOT NULL, PRIMARY KEY(snapshot_id, id))",
    );
    this.driver.exec(
      "CREATE TABLE IF NOT EXISTS cartographer_graph_edges (id TEXT NOT NULL, snapshot_id TEXT NOT NULL, repo_root TEXT NOT NULL, kind TEXT NOT NULL, from_node_id TEXT NOT NULL, to_node_id TEXT NOT NULL, path TEXT, evidence_json TEXT, properties_json TEXT NOT NULL, PRIMARY KEY(snapshot_id, id))",
    );

    this.driver.exec("CREATE INDEX IF NOT EXISTS idx_cartographer_graph_nodes_repo_kind ON cartographer_graph_nodes(repo_root, kind)");
    this.driver.exec("CREATE INDEX IF NOT EXISTS idx_cartographer_graph_nodes_repo_path ON cartographer_graph_nodes(repo_root, normalized_path)");
    this.driver.exec("CREATE INDEX IF NOT EXISTS idx_cartographer_graph_edges_repo_kind_from ON cartographer_graph_edges(repo_root, kind, from_node_id)");
    this.driver.exec("CREATE INDEX IF NOT EXISTS idx_cartographer_graph_edges_repo_kind_to ON cartographer_graph_edges(repo_root, kind, to_node_id)");
  }
}

function snapshotFromRow(row: GraphSnapshotRow): GraphSnapshot {
  return {
    id: row.id,
    repoRoot: row.repo_root,
    inventorySnapshotId: row.inventory_snapshot_id,
    createdAt: row.created_at,
    nodeCount: Number(row.node_count),
    edgeCount: Number(row.edge_count),
  };
}

function nodeFromRow(row: GraphNodeRow): CartographerGraphNode {
  const properties = CartographerGraphNodeSchema.shape.properties.parse(
    JSON.parse(row.properties_json),
  );
  const candidate = {
    id: row.id,
    snapshotId: row.snapshot_id,
    kind: row.kind,
    label: row.label,
    ...(row.path !== null ? { path: row.path } : {}),
    ...(row.normalized_path !== null ? { normalizedPath: row.normalized_path } : {}),
    ...(row.symbol_name !== null ? { symbolName: row.symbol_name } : {}),
    ...(row.symbol_kind !== null ? { symbolKind: row.symbol_kind } : {}),
    ...(row.language !== null ? { language: row.language } : {}),
    ...(row.file_hash !== null ? { fileHash: row.file_hash } : {}),
    ...(row.start_line !== null ? { startLine: Number(row.start_line) } : {}),
    ...(row.end_line !== null ? { endLine: Number(row.end_line) } : {}),
    properties,
  };
  return CartographerGraphNodeSchema.parse(candidate);
}

function edgeFromRow(row: GraphEdgeRow): CartographerGraphEdge {
  const properties = CartographerGraphEdgeSchema.shape.properties.parse(
    JSON.parse(row.properties_json),
  );
  const candidate = {
    id: row.id,
    snapshotId: row.snapshot_id,
    kind: row.kind,
    fromNodeId: row.from_node_id,
    toNodeId: row.to_node_id,
    ...(row.path !== null ? { path: row.path } : {}),
    ...(row.evidence_json !== null
      ? { evidence: JSON.parse(row.evidence_json) }
      : {}),
    properties,
  };
  return CartographerGraphEdgeSchema.parse(candidate);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
