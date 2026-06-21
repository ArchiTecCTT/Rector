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

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { computePayloadMac, verifyPayloadMac } from "../security/payloadIntegrity.js";
import { ConcurrentTransitionError } from "../orchestration/runStateMachine";
import { z } from "zod";
import { redactString } from "../security/redaction";
import {
  ArtifactSchema,
  ConversationSchema,
  MessageSchema,
  RunEventSchema,
  RunSchema,
  MemoryEntrySchema,
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
  type MemoryEntry,
  type MemoryLayer,
  type CreateMemoryEntryInput,
  type UpdateMemoryEntryInput,
} from "./schemas";
import type { RectorStore } from "./index";
import {
  compareMemoryPruneCandidates,
  compareMemorySearchResults,
  memoryPruneScore,
  normalizeMemorySearchLimit,
  sanitizeCreateMemoryEntryInput,
  sanitizeUpdateMemoryEntryInput,
} from "../memory/entryUtils";
import {
  getConversationLineage as walkConversationLineage,
  validateParentConversation,
} from "./lineage";
import {
  buildSessionSearchHit,
  compareSessionSearchHits,
  keywordSearchConversations,
  normalizeSessionSearchLimit,
  normalizeSessionSearchQuery,
  redactedIndexContent,
  toFts5Query,
  type SessionSearchHit,
  type SessionSearchQuery,
} from "./sessionSearch";

export interface SqlRectorStoreOptions {
  driver: SqlDriver;
  now?: () => string;
  /** Optional AES-256-GCM key for payload encryption at rest. When provided,
   *  all payloads are sealed with AES-256-GCM and prefixed with `ENC1:`;
   *  unencrypted (legacy) rows are still readable for backward compat. */
  encryptionKey?: Buffer;
  /** Optional HMAC-SHA256 key for payload integrity verification. When provided,
   *  MACs are computed on insert/update and verified on read. Rows without a
   *  MAC (legacy) are accepted with a warning. Derived from the master key
   *  via `deriveMacKey()` with info `"rector.payload-mac.v1"`. */
  macKey?: Buffer;
}

/** Prefixes used for store-generated entity ids, mirroring `InMemoryRectorStore`. */
type IdPrefix = "conv" | "msg" | "run" | "art" | "mem";

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
/** Prefix identifying an AES-256-GCM encrypted payload in the DB. */
const ENC1_PREFIX = "ENC1:";

/** Nonce length for AES-256-GCM (96 bits / 12 bytes). */
const GCM_NONCE_LENGTH = 12;

export class SqlRectorStore implements RectorStore {
  private readonly driver: SqlDriver;
  private readonly encryptionKey: Buffer | undefined;
  private readonly macKey: Buffer | undefined;

  constructor(options: SqlRectorStoreOptions) {
    this.driver = options.driver;
    this.encryptionKey = options.encryptionKey;
    this.macKey = options.macKey;
    this.nowFn = options.now ?? (() => new Date().toISOString());
    this.migrate();
  }

  private readonly nowFn: () => string;

  // --- Conversations -------------------------------------------------------

  async createConversation(input: CreateConversationInput): Promise<Conversation> {
    const now = this.nowFn();
    const id = this.nextId("conv", "conversations");
    if (input.parentConversationId) {
      await validateParentConversation(this, id, input.parentConversationId, {
        workspaceId: input.workspaceId,
      });
    }
    const conversation = ConversationSchema.parse({
      ...structuredClone(input),
      id,
      compressionGeneration: input.compressionGeneration ?? 0,
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
    const nextWorkspaceId = patch.workspaceId ?? current.workspaceId;
    const nextParentConversationId = Object.prototype.hasOwnProperty.call(patch, "parentConversationId")
      ? patch.parentConversationId
      : current.parentConversationId;
    if (nextParentConversationId) {
      await validateParentConversation(this, current.id, nextParentConversationId, {
        workspaceId: nextWorkspaceId,
      });
    }
    const updated = ConversationSchema.parse({
      ...current,
      ...structuredClone(patch),
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: this.nowFn(),
    });
    this.updateRow("conversations", updated.id, updated.workspaceId, updated);
    if (updated.workspaceId !== current.workspaceId) {
      await this.reindexConversationMessages(updated.id);
    }
    return updated;
  }

  async deleteConversation(id: string): Promise<boolean> {
    const deleted = this.deleteRow("conversations", id);
    if (deleted) this.deleteConversationFromSearch(id);
    return deleted;
  }

  async searchConversations(query: SessionSearchQuery): Promise<SessionSearchHit[]> {
    const normalizedQuery = normalizeSessionSearchQuery(query.query);
    const normalized = { ...query, query: normalizedQuery, limit: normalizeSessionSearchLimit(query.limit) };
    if (this.driver.dialect !== "sqlite" || !normalizedQuery) {
      return keywordSearchConversations(this, normalized);
    }

    const ftsQuery = toFts5Query(normalizedQuery);
    if (!ftsQuery) return [];

    const rows = this.driver.all<{
      message_id: string;
      conversation_id: string;
      content: string;
      rank: number | bigint;
    }>(
      `SELECT message_id, conversation_id, content, bm25(messages_fts) AS rank
       FROM messages_fts
       WHERE messages_fts MATCH ? AND workspace_id = ?
       ORDER BY rank ASC
       LIMIT ?`,
      [ftsQuery, normalized.workspaceId, normalized.limit],
    );

    const hits: SessionSearchHit[] = [];
    for (const row of rows) {
      const conversation = await this.getConversation(row.conversation_id);
      if (!conversation || conversation.workspaceId !== normalized.workspaceId) continue;
      const message = await this.getMessage(row.message_id);
      if (!message) continue;
      hits.push(
        buildSessionSearchHit({
          conversation,
          message,
          content: row.content,
          query: normalizedQuery,
          baseScore: 2 + 1 / (1 + Math.abs(Number(row.rank ?? 0))),
        }),
      );
    }

    return hits.sort(compareSessionSearchHits).slice(0, normalized.limit);
  }

  async getConversationLineage(conversationId: string): Promise<Conversation[]> {
    return walkConversationLineage(this, conversationId);
  }

  // --- Messages ------------------------------------------------------------

  async createMessage(input: CreateMessageInput): Promise<Message> {
    const message = MessageSchema.parse({
      ...structuredClone(input),
      id: this.nextId("msg", "messages"),
      createdAt: this.nowFn(),
    });
    this.insertRow("messages", message.id, message.conversationId, message);
    await this.indexMessageForSearch(message);
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
    await this.indexMessageForSearch(updated);
    return updated;
  }

  async deleteMessage(id: string): Promise<boolean> {
    const deleted = this.deleteRow("messages", id);
    if (deleted) this.deleteMessageFromSearch(id);
    return deleted;
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

    // Optimistic concurrency (M21): patch.version is the new version,
    // current.version is the expected existing version.
    const expectedVersion = (current.version ?? 0);
    const newVersion = patch.version ?? expectedVersion + 1;

    const updated = RunSchema.parse({
      ...current,
      ...structuredClone(patch),
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: this.nowFn(),
      version: newVersion,
    });
    const parsedEvent = RunEventSchema.parse(structuredClone(event));

    if (this.rowExists("run_events", parsedEvent.id)) {
      throw new Error(`Duplicate event ID: ${parsedEvent.id}`);
    }

    const eventSeq = this.nextSeq("run_events");
    this.driver.exec("BEGIN");
    try {
      const updatedPayload = this.serialize(updated);
      const updatedMac = this.macKey ? computePayloadMac(updatedPayload, this.macKey) : null;
      this.driver.run(
        "UPDATE runs SET conversation_id = ?, payload = ?, mac = ?, version = ? WHERE id = ? AND version = ?",
        [updated.conversationId, updatedPayload, updatedMac, newVersion, updated.id, expectedVersion]
      );
      // Verify that the row was actually updated (version matched)
      const checkRow = this.driver.get<{ id: string }>(
        "SELECT id FROM runs WHERE id = ? AND version = ?",
        [updated.id, newVersion]
      );
      if (!checkRow) {
        // Version mismatch — another transition occurred concurrently
        this.driver.exec("ROLLBACK");
        throw new ConcurrentTransitionError(runId, expectedVersion, -1);
      }
      const eventPayload = this.serialize(parsedEvent);
      const eventMac = this.macKey ? computePayloadMac(eventPayload, this.macKey) : null;
      this.driver.run(
        "INSERT INTO run_events (id, run_id, seq, payload, mac) VALUES (?, ?, ?, ?, ?)",
        [parsedEvent.id, parsedEvent.runId, eventSeq, eventPayload, eventMac]
      );
      this.driver.exec("COMMIT");
    } catch (error) {
      try {
        this.driver.exec("ROLLBACK");
      } catch (rollbackError) {
        console.error("[CRITICAL] Transaction rollback failed - database may be in inconsistent state:", rollbackError);
      }
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
      `payload ${jsonType} NOT NULL, ` +
      `mac TEXT)`;

    this.driver.exec(table("conversations", "workspace_id"));
    this.driver.exec(table("messages", "conversation_id"));
    this.driver.exec(table("runs", "conversation_id"));
    this.driver.exec(table("run_events", "run_id"));
    this.driver.exec(table("artifacts", "kind"));
    this.driver.exec(table("memories", "layer"));

    if (!mysql) {
      this.driver.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
          message_id UNINDEXED,
          conversation_id UNINDEXED,
          workspace_id UNINDEXED,
          content,
          tokenize = 'porter'
        )
      `);
    }

    // Idempotent MAC column addition for payload integrity verification (H8).
    // ALTER TABLE ... ADD COLUMN is a no-op if the column already exists on SQLite ≥ 3.35.0,
    // but older SQLite silently ignores it; wrap in try/catch for robustness.
    const macTables = ["conversations", "messages", "runs", "run_events", "artifacts", "memories"];
    const validTableNames = new Set(["conversations", "messages", "runs", "run_events", "artifacts", "memories"]);
    for (const t of macTables) {
      if (!validTableNames.has(t)) {
        throw new Error(`Invalid table name in MAC migration: ${t}`);
      }
      try {
        this.driver.exec(`ALTER TABLE ${t} ADD COLUMN mac TEXT`);
      } catch {
        // Column already exists — expected for subsequent boots.
      }
    }

    // Idempotent version column addition for optimistic concurrency (M21).
    try {
      this.driver.exec("ALTER TABLE runs ADD COLUMN version INTEGER NOT NULL DEFAULT 0");
    } catch {
      // Column already exists — expected for subsequent boots.
    }
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
      case "memories":
        return "layer";
      default:
        throw new Error(`Unknown store table: ${table}`);
    }
  }

  private serialize(entity: unknown): string {
    const json = JSON.stringify(entity);
    if (!this.encryptionKey) return json;
    // AES-256-GCM seal: nonce(12) + ciphertext + authTag(16)
    const nonce = randomBytes(GCM_NONCE_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, nonce);
    const ciphertext = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const sealed = Buffer.concat([nonce, ciphertext, tag]);
    return ENC1_PREFIX + sealed.toString("base64");
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
    const payload = this.serialize(entity);
    const mac = this.macKey ? computePayloadMac(payload, this.macKey) : null;
    this.driver.run(
      `INSERT INTO ${table} (id, ${this.filterColumn(table)}, seq, payload, mac) VALUES (?, ?, ?, ?, ?)`,
      [id, filter, seq, payload, mac]
    );
  }

  private updateRow(table: string, id: string, filter: string, entity: unknown): void {
    const payload = this.serialize(entity);
    const mac = this.macKey ? computePayloadMac(payload, this.macKey) : null;
    this.driver.run(
      `UPDATE ${table} SET ${this.filterColumn(table)} = ?, payload = ?, mac = ? WHERE id = ?`,
      [filter, payload, mac, id]
    );
  }

  private deleteRow(table: string, id: string): boolean {
    if (!this.rowExists(table, id)) return false;
    this.driver.run(`DELETE FROM ${table} WHERE id = ?`, [id]);
    return true;
  }

  private async indexMessageForSearch(message: Message): Promise<void> {
    if (this.driver.dialect !== "sqlite") return;
    const conversation = await this.getConversation(message.conversationId);
    if (!conversation) {
      this.deleteMessageFromSearch(message.id);
      return;
    }
    this.deleteMessageFromSearch(message.id);
    this.driver.run(
      "INSERT INTO messages_fts (message_id, conversation_id, workspace_id, content) VALUES (?, ?, ?, ?)",
      [message.id, message.conversationId, conversation.workspaceId, redactedIndexContent(message.content)],
    );
  }

  private deleteMessageFromSearch(messageId: string): void {
    if (this.driver.dialect !== "sqlite") return;
    this.driver.run("DELETE FROM messages_fts WHERE message_id = ?", [messageId]);
  }

  private deleteConversationFromSearch(conversationId: string): void {
    if (this.driver.dialect !== "sqlite") return;
    this.driver.run("DELETE FROM messages_fts WHERE conversation_id = ?", [conversationId]);
  }

  private async reindexConversationMessages(conversationId: string): Promise<void> {
    if (this.driver.dialect !== "sqlite") return;
    const messages = await this.listMessages(conversationId);
    for (const message of messages) {
      await this.indexMessageForSearch(message);
    }
  }

  private readRow<T>(
    table: string,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    label: string,
    id: string
  ): T | undefined {
    const row = this.driver.get<{ payload: unknown; mac: string | null }>(
      `SELECT payload, mac FROM ${table} WHERE id = ?`, [id]
    );
    if (row === undefined) return undefined;
    return this.parsePayload(schema, label, id, row.payload, row.mac);
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
        ? this.driver.all<{ id: string; payload: unknown; mac: string | null }>(
            `SELECT id, payload, mac FROM ${table} ORDER BY seq ASC`
          )
        : this.driver.all<{ id: string; payload: unknown; mac: string | null }>(
            `SELECT id, payload, mac FROM ${table} WHERE ${column} = ? ORDER BY seq ASC`,
            [filter]
          );
    return rows.map((row) => this.parsePayload(schema, label, row.id, row.payload, row.mac));
  }

  /**
   * Re-parse a stored payload through its `Entity_Schema`. On failure raise a
   * redaction-applied error identifying the entity and id rather than returning
   * a malformed entity, so no secret can leak through the error message.
   */
  private parsePayload<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, label: string, id: string, payload: unknown, mac: string | null): T {
    const raw = typeof payload === "string" ? this.deserialize(label, id, payload) : payload;

    // Verify payload integrity MAC if a key is configured.
    if (this.macKey) {
      const serializedPayload = typeof payload === "string" ? payload : JSON.stringify(payload);
      if (mac) {
        const valid = verifyPayloadMac(serializedPayload, mac, this.macKey);
        if (!valid) {
          throw new Error(
            `Payload integrity check failed for ${label} id ${redactString(id)}: MAC mismatch. ` +
            `The data may have been tampered with.`
          );
        }
      } else {
        // Legacy row without MAC — accept with warning.
        console.warn(
          `[SECURITY] No MAC on ${label} id ${redactString(id)} — legacy row accepted. ` +
          `Re-writing to add MAC.`
        );
      }
    }

    const result = schema.safeParse(raw);
    if (!result.success) {
      const detail = redactString(result.error.message);
      throw new Error(`Corrupt ${label} payload for id ${redactString(id)}: ${detail}`);
    }
    return result.data;
  }

  private deserialize(label: string, id: string, payload: string): unknown {
    try {
      if (payload.startsWith(ENC1_PREFIX)) {
        if (!this.encryptionKey) {
          throw new Error(
            `Encrypted ${label} payload for id ${redactString(id)} cannot be decrypted: no encryption key provided. ` +
            `Set RECTOR_DB_ENCRYPTION=true and ensure the secret key is available.`
          );
        }
        const sealed = Buffer.from(payload.slice(ENC1_PREFIX.length), "base64");
        // Layout: nonce(12) + ciphertext + authTag(16)
        const nonce = sealed.subarray(0, GCM_NONCE_LENGTH);
        const tag = sealed.subarray(sealed.length - 16);
        const ciphertext = sealed.subarray(GCM_NONCE_LENGTH, sealed.length - 16);
        const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, nonce);
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return JSON.parse(plaintext.toString("utf8"));
      }
      return JSON.parse(payload);
    } catch (error) {
      if (error instanceof Error && error.message.includes("no encryption key provided")) throw error;
      const message = redactString(error instanceof Error ? error.message : String(error));
      throw new Error(`Corrupt ${label} payload for id ${redactString(id)}: ${message}`);
    }
  }

  // === Advanced Memory (Chunk 27 / neuro-symbolic Step 2) ===
  async createMemoryEntry(input: CreateMemoryEntryInput): Promise<MemoryEntry> {
    const now = this.nowFn();
    const sanitized = sanitizeCreateMemoryEntryInput(input);
    const entry = MemoryEntrySchema.parse({
      ...structuredClone(sanitized),
      id: this.nextId("mem", "memories"),
      accessCount: sanitized.accessCount ?? 0,
      lastMentioned: sanitized.lastMentioned ?? now,
      timestamp: sanitized.timestamp ?? now,
      tags: sanitized.tags ?? [],
      metadata: sanitized.metadata ?? {},
    });
    this.insertRow("memories", entry.id, entry.layer, entry);
    return entry;
  }

  async getMemoryEntry(id: string): Promise<MemoryEntry | undefined> {
    return this.readRow("memories", MemoryEntrySchema, "memory", id);
  }

  async listMemoryEntries(layer?: MemoryLayer): Promise<MemoryEntry[]> {
    return this.listRows("memories", MemoryEntrySchema, "memory", layer);
  }

  async updateMemoryEntry(
    id: string,
    patch: UpdateMemoryEntryInput
  ): Promise<MemoryEntry | undefined> {
    const current = await this.getMemoryEntry(id);
    if (!current) return undefined;

    const updated = MemoryEntrySchema.parse({
      ...current,
      ...structuredClone(sanitizeUpdateMemoryEntryInput(patch)),
      id: current.id,
    });
    this.updateRow("memories", updated.id, updated.layer, updated);
    return updated;
  }

  async deleteMemoryEntry(id: string): Promise<boolean> {
    return this.deleteRow("memories", id);
  }

  async searchMemory(query?: string, options: { layer?: MemoryLayer; limit?: number } = {}): Promise<MemoryEntry[]> {
    const { layer } = options;
    const limit = normalizeMemorySearchLimit(options.limit);
    let results = await this.listMemoryEntries(layer);

    if (query && query.trim()) {
      const q = query.toLowerCase();
      results = results.filter((e) =>
        e.content.toLowerCase().includes(q) ||
        e.tags.some((t) => t.toLowerCase().includes(q)) ||
        (e.source && e.source.toLowerCase().includes(q))
      );
    }

    results.sort(compareMemorySearchResults);

    return results.slice(0, limit);
  }

  async pruneMemory(options: { targetLayer?: MemoryLayer; maxEntries?: number } = {}): Promise<{ pruned: number; summarized: number }> {
    const { targetLayer = "episodic", maxEntries = 100 } = options;
    const layerEntries = await this.listMemoryEntries(targetLayer);

    if (layerEntries.length <= maxEntries) {
      return { pruned: 0, summarized: 0 };
    }

    const pruneNow = this.nowFn();
    const scored = layerEntries.map((entry) => ({ entry, score: memoryPruneScore(entry, pruneNow) }));

    scored.sort(compareMemoryPruneCandidates); // lowest first

    let pruned = 0;
    let summarized = 0;
    const toPrune = scored.slice(0, Math.max(0, layerEntries.length - maxEntries));

    for (const { entry } of toPrune) {
      // Simple "summarize" for alpha: if high enough access, move a stub summary to core
      if (entry.accessCount > 2 && entry.layer === "episodic") {
        const summaryContent = `[summary] ${entry.content.slice(0, 120)}... (from ${entry.timestamp})`;
        await this.createMemoryEntry({
          layer: "core",
          content: summaryContent,
          timestamp: this.nowFn(),
          tags: [...entry.tags, "auto-summary"],
          source: "prune",
          metadata: { originalId: entry.id, originalLayer: entry.layer },
        });
        summarized++;
      }
      await this.deleteMemoryEntry(entry.id);
      pruned++;
    }

    return { pruned, summarized };
  }
}
