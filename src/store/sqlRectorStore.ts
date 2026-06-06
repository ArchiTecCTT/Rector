import { DatabaseSync } from "node:sqlite";

/**
 * The minimal synchronous SQL surface that `SqlRectorStore` depends on.
 *
 * Both the local SQLite driver (the default, file or `:memory:`, no cloud
 * account and no network) and the optional hosted TiDB driver (MySQL wire)
 * implement this contract, and tests inject an in-memory double — so the test
 * suite never has to touch a real cloud database.
 */
export interface SqlDriver {
  /** Identifies the dialect so the store can pick dialect-specific JSON typing. */
  readonly dialect: "sqlite" | "mysql";
  /** Run DDL / migration statements that take no parameters. */
  exec(sql: string): void;
  /** Run a parameterized INSERT / UPDATE / DELETE statement. */
  run(sql: string, params?: unknown[]): void;
  /** Run a parameterized query returning at most one row. */
  get<T = unknown>(sql: string, params?: unknown[]): T | undefined;
  /** Run a parameterized query returning every matching row. */
  all<T = unknown>(sql: string, params?: unknown[]): T[];
  /** Release the underlying database handle. */
  close(): void;
}

/** Bind-value type accepted by the underlying `node:sqlite` statements. */
type SqliteBindValue = null | number | bigint | string | NodeJS.ArrayBufferView;

function toBindParams(params?: unknown[]): SqliteBindValue[] {
  return (params ?? []) as SqliteBindValue[];
}

/**
 * Create the local persistence `SqlDriver`, backed by a file-based or
 * `:memory:` SQLite database via Node's built-in `node:sqlite` module.
 *
 * Requires no cloud account and opens no network connection. Pass
 * `{ path: ":memory:" }` for an ephemeral database or a filesystem path for a
 * durable one that survives a restart.
 */
export function createSqliteDriver(input: { path: string }): SqlDriver {
  const db = new DatabaseSync(input.path);

  return {
    dialect: "sqlite",
    exec(sql: string): void {
      db.exec(sql);
    },
    run(sql: string, params?: unknown[]): void {
      db.prepare(sql).run(...toBindParams(params));
    },
    get<T = unknown>(sql: string, params?: unknown[]): T | undefined {
      return db.prepare(sql).get(...toBindParams(params)) as T | undefined;
    },
    all<T = unknown>(sql: string, params?: unknown[]): T[] {
      return db.prepare(sql).all(...toBindParams(params)) as T[];
    },
    close(): void {
      db.close();
    },
  };
}

import { z } from "zod";
import { redactString } from "../security/redaction";
import {
  ArtifactSchema,
  ConversationSchema,
  MessageSchema,
  RunEventSchema,
  RunSchema,
  type Artifact,
  type Conversation,
  type CreateArtifactInput,
  type CreateConversationInput,
  type CreateMessageInput,
  type CreateRunInput,
  type Message,
  type Run,
  type RunEvent,
  type UpdateArtifactInput,
  type UpdateConversationInput,
  type UpdateMessageInput,
  type UpdateRunInput,
} from "./schemas";
import type { RectorStore } from "./index";

export interface SqlRectorStoreOptions {
  driver: SqlDriver;
  now?: () => string;
}

/** Prefixes used for store-generated entity ids, mirroring `InMemoryRectorStore`. */
type IdPrefix = "conv" | "msg" | "run" | "art";

/** A persisted row: the indexable filter column plus the canonical JSON payload. */
interface EntityRow {
  id: string;
  filter: string | null;
  payload: unknown;
}

/**
 * A `RectorStore` that persists every entity over an injectable `SqlDriver`.
 *
 * Each entity maps to one table carrying its `id` primary key, an indexable
 * filter column, a monotonic `seq` insertion-order column, and a JSON `payload`
 * holding the canonical, schema-validated entity. Every write is validated with
 * its `Entity_Schema` before insert and every read is re-parsed through the same
 * schema, so a persisted-then-reloaded entity is deep-equal to the one written
 * and ids/counters are reconstructed solely from the persisted data. The store
 * preserves `InMemoryRectorStore` semantics: insertion-order list results,
 * duplicate-event-id rejection, and an atomic-and-rollback run transition.
 */
export class SqlRectorStore implements RectorStore {
  private readonly driver: SqlDriver;

  constructor(options: SqlRectorStoreOptions) {
    this.driver = options.driver;
    this.nowFn = options.now ?? (() => new Date().toISOString());
    this.migrate();
  }

  private readonly nowFn: () => string;

  // --- Conversations -------------------------------------------------------

  async createConversation(input: CreateConversationInput): Promise<Conversation> {
    const now = this.nowFn();
    const conversation = ConversationSchema.parse({
      ...structuredClone(input),
      id: this.nextId("conv", "conversations"),
      createdAt: now,
      updatedAt: now,
    });
    this.insertRow("conversations", conversation.id, conversation.workspaceId, conversation);
    return conversation;
  }

  async getConversation(id: string): Promise<Conversation | undefined> {
    return this.readRow("conversations", ConversationSchema, "conversation", id);
  }

  async listConversations(workspaceId?: string): Promise<Conversation[]> {
    return this.listRows("conversations", ConversationSchema, "conversation", workspaceId);
  }

  async updateConversation(
    id: string,
    patch: UpdateConversationInput
  ): Promise<Conversation | undefined> {
    const current = await this.getConversation(id);
    if (!current) return undefined;
    const updated = ConversationSchema.parse({
      ...current,
      ...structuredClone(patch),
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: this.nowFn(),
    });
    this.updateRow("conversations", updated.id, updated.workspaceId, updated);
    return updated;
  }

  async deleteConversation(id: string): Promise<boolean> {
    return this.deleteRow("conversations", id);
  }

  // --- Messages ------------------------------------------------------------

  async createMessage(input: CreateMessageInput): Promise<Message> {
    const message = MessageSchema.parse({
      ...structuredClone(input),
      id: this.nextId("msg", "messages"),
      createdAt: this.nowFn(),
    });
    this.insertRow("messages", message.id, message.conversationId, message);
    return message;
  }

  async getMessage(id: string): Promise<Message | undefined> {
    return this.readRow("messages", MessageSchema, "message", id);
  }

  async listMessages(conversationId?: string): Promise<Message[]> {
    return this.listRows("messages", MessageSchema, "message", conversationId);
  }

  async updateMessage(id: string, patch: UpdateMessageInput): Promise<Message | undefined> {
    const current = await this.getMessage(id);
    if (!current) return undefined;
    const updated = MessageSchema.parse({
      ...current,
      ...structuredClone(patch),
      id: current.id,
      createdAt: current.createdAt,
    });
    this.updateRow("messages", updated.id, updated.conversationId, updated);
    return updated;
  }

  async deleteMessage(id: string): Promise<boolean> {
    return this.deleteRow("messages", id);
  }

  // --- Runs ----------------------------------------------------------------

  async createRun(input: CreateRunInput): Promise<Run> {
    const now = this.nowFn();
    const run = RunSchema.parse({
      ...structuredClone(input),
      id: this.nextId("run", "runs"),
      createdAt: now,
      updatedAt: now,
    });
    this.insertRow("runs", run.id, run.conversationId, run);
    return run;
  }

  async getRun(id: string): Promise<Run | undefined> {
    return this.readRow("runs", RunSchema, "run", id);
  }

  async listRuns(conversationId?: string): Promise<Run[]> {
    return this.listRows("runs", RunSchema, "run", conversationId);
  }

  async updateRun(id: string, patch: UpdateRunInput): Promise<Run | undefined> {
    const current = await this.getRun(id);
    if (!current) return undefined;
    const updated = RunSchema.parse({
      ...current,
      ...structuredClone(patch),
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: this.nowFn(),
    });
    this.updateRow("runs", updated.id, updated.conversationId, updated);
    return updated;
  }

  async deleteRun(id: string): Promise<boolean> {
    return this.deleteRow("runs", id);
  }

  /**
   * Atomically commits a run update and appends a transition event. The update
   * and the event insert run inside a single transaction; if either fails the
   * transaction rolls back so the prior run state and event log are unchanged.
   */
  async commitRunTransition(
    runId: string,
    patch: UpdateRunInput,
    event: RunEvent
  ): Promise<{ run: Run; event: RunEvent }> {
    const current = await this.getRun(runId);
    if (!current) {
      throw new Error(`Run not found: ${runId}`);
    }

    const updated = RunSchema.parse({
      ...current,
      ...structuredClone(patch),
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: this.nowFn(),
    });
    const parsedEvent = RunEventSchema.parse(structuredClone(event));

    if (this.rowExists("run_events", parsedEvent.id)) {
      throw new Error(`Duplicate event ID: ${parsedEvent.id}`);
    }

    const eventSeq = this.nextSeq("run_events");
    this.driver.exec("BEGIN");
    try {
      this.driver.run("UPDATE runs SET conversation_id = ?, payload = ? WHERE id = ?", [
        updated.conversationId,
        this.serialize(updated),
        updated.id,
      ]);
      this.driver.run(
        "INSERT INTO run_events (id, run_id, seq, payload) VALUES (?, ?, ?, ?)",
        [parsedEvent.id, parsedEvent.runId, eventSeq, this.serialize(parsedEvent)]
      );
      this.driver.exec("COMMIT");
    } catch (error) {
      this.driver.exec("ROLLBACK");
      throw error;
    }

    return { run: updated, event: parsedEvent };
  }

  // --- Events --------------------------------------------------------------

  async appendEvent(event: RunEvent): Promise<RunEvent> {
    const parsed = RunEventSchema.parse(structuredClone(event));
    if (this.rowExists("run_events", parsed.id)) {
      throw new Error(`Duplicate event ID: ${parsed.id}`);
    }
    this.insertRow("run_events", parsed.id, parsed.runId, parsed);
    return parsed;
  }

  async getEvent(id: string): Promise<RunEvent | undefined> {
    return this.readRow("run_events", RunEventSchema, "event", id);
  }

  async listEvents(runId?: string): Promise<RunEvent[]> {
    return this.listRows("run_events", RunEventSchema, "event", runId);
  }

  async deleteEvent(id: string): Promise<boolean> {
    return this.deleteRow("run_events", id);
  }

  // --- Artifacts -----------------------------------------------------------

  async createArtifact(input: CreateArtifactInput): Promise<Artifact> {
    const artifact = ArtifactSchema.parse({
      ...structuredClone(input),
      id: this.nextId("art", "artifacts"),
      createdAt: this.nowFn(),
    });
    this.insertRow("artifacts", artifact.id, artifact.kind, artifact);
    return artifact;
  }

  async getArtifact(id: string): Promise<Artifact | undefined> {
    return this.readRow("artifacts", ArtifactSchema, "artifact", id);
  }

  async listArtifacts(kind?: string): Promise<Artifact[]> {
    return this.listRows("artifacts", ArtifactSchema, "artifact", kind);
  }

  async updateArtifact(id: string, patch: UpdateArtifactInput): Promise<Artifact | undefined> {
    const current = await this.getArtifact(id);
    if (!current) return undefined;
    const updated = ArtifactSchema.parse({
      ...current,
      ...structuredClone(patch),
      id: current.id,
      createdAt: current.createdAt,
    });
    this.updateRow("artifacts", updated.id, updated.kind, updated);
    return updated;
  }

  async deleteArtifact(id: string): Promise<boolean> {
    return this.deleteRow("artifacts", id);
  }

  // --- Internal helpers ----------------------------------------------------

  /** Run the idempotent table DDL, sharing statements across dialects. */
  private migrate(): void {
    const mysql = this.driver.dialect === "mysql";
    const idType = mysql ? "VARCHAR(255)" : "TEXT";
    const filterType = mysql ? "VARCHAR(255)" : "TEXT";
    const jsonType = mysql ? "JSON" : "TEXT";

    const table = (name: string, filterColumn: string): string =>
      `CREATE TABLE IF NOT EXISTS ${name} (` +
      `id ${idType} PRIMARY KEY, ` +
      `${filterColumn} ${filterType}, ` +
      `seq INTEGER NOT NULL, ` +
      `payload ${jsonType} NOT NULL)`;

    this.driver.exec(table("conversations", "workspace_id"));
    this.driver.exec(table("messages", "conversation_id"));
    this.driver.exec(table("runs", "conversation_id"));
    this.driver.exec(table("run_events", "run_id"));
    this.driver.exec(table("artifacts", "kind"));
  }

  /** Map a table name to its indexable filter column. */
  private filterColumn(table: string): string {
    switch (table) {
      case "conversations":
        return "workspace_id";
      case "messages":
      case "runs":
        return "conversation_id";
      case "run_events":
        return "run_id";
      case "artifacts":
        return "kind";
      default:
        throw new Error(`Unknown store table: ${table}`);
    }
  }

  private serialize(entity: unknown): string {
    return JSON.stringify(entity);
  }

  private nextSeq(table: string): number {
    const row = this.driver.get<{ next: number | bigint }>(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM ${table}`
    );
    return Number(row?.next ?? 1);
  }

  private rowExists(table: string, id: string): boolean {
    const row = this.driver.get<{ id: string }>(`SELECT id FROM ${table} WHERE id = ?`, [id]);
    return row !== undefined;
  }

  /**
   * Derive the next store-generated id solely from persisted rows so counters
   * survive a restart. Scans existing ids of the form `${prefix}-${n}` and
   * returns the next sequential id.
   */
  private nextId(prefix: IdPrefix, table: string): string {
    const rows = this.driver.all<{ id: string }>(`SELECT id FROM ${table}`);
    const pattern = new RegExp(`^${prefix}-(\\d+)$`);
    let max = 0;
    for (const { id } of rows) {
      const match = pattern.exec(id);
      if (match) {
        const value = Number(match[1]);
        if (value > max) max = value;
      }
    }
    return `${prefix}-${max + 1}`;
  }

  private insertRow(table: string, id: string, filter: string, entity: unknown): void {
    const seq = this.nextSeq(table);
    this.driver.run(
      `INSERT INTO ${table} (id, ${this.filterColumn(table)}, seq, payload) VALUES (?, ?, ?, ?)`,
      [id, filter, seq, this.serialize(entity)]
    );
  }

  private updateRow(table: string, id: string, filter: string, entity: unknown): void {
    this.driver.run(
      `UPDATE ${table} SET ${this.filterColumn(table)} = ?, payload = ? WHERE id = ?`,
      [filter, this.serialize(entity), id]
    );
  }

  private deleteRow(table: string, id: string): boolean {
    if (!this.rowExists(table, id)) return false;
    this.driver.run(`DELETE FROM ${table} WHERE id = ?`, [id]);
    return true;
  }

  private readRow<T>(
    table: string,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    label: string,
    id: string
  ): T | undefined {
    const row = this.driver.get<EntityRow>(`SELECT payload FROM ${table} WHERE id = ?`, [id]);
    if (row === undefined) return undefined;
    return this.parsePayload(schema, label, id, row.payload);
  }

  private listRows<T>(
    table: string,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    label: string,
    filter?: string
  ): T[] {
    const column = this.filterColumn(table);
    const rows =
      filter === undefined
        ? this.driver.all<EntityRow>(`SELECT id, payload FROM ${table} ORDER BY seq ASC`)
        : this.driver.all<EntityRow>(
            `SELECT id, payload FROM ${table} WHERE ${column} = ? ORDER BY seq ASC`,
            [filter]
          );
    return rows.map((row) => this.parsePayload(schema, label, row.id, row.payload));
  }

  /**
   * Re-parse a stored payload through its `Entity_Schema`. On failure raise a
   * redaction-applied error identifying the entity and id rather than returning
   * a malformed entity, so no secret can leak through the error message.
   */
  private parsePayload<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, label: string, id: string, payload: unknown): T {
    const raw = typeof payload === "string" ? this.deserialize(label, id, payload) : payload;
    const result = schema.safeParse(raw);
    if (!result.success) {
      const detail = redactString(result.error.message);
      throw new Error(`Corrupt ${label} payload for id ${redactString(id)}: ${detail}`);
    }
    return result.data;
  }

  private deserialize(label: string, id: string, payload: string): unknown {
    try {
      return JSON.parse(payload);
    } catch (error) {
      const message = redactString(error instanceof Error ? error.message : String(error));
      throw new Error(`Corrupt ${label} payload for id ${redactString(id)}: ${message}`);
    }
  }
}
