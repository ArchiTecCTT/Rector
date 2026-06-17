import type {
  Artifact,
  Conversation,
  CreateArtifactInput,
  CreateConversationInput,
  CreateMemoryEntryInput,
  CreateMessageInput,
  CreateRunInput,
  MemoryEntry,
  MemoryLayer,
  Message,
  Run,
  RunEvent,
  UpdateArtifactInput,
  UpdateConversationInput,
  UpdateMemoryEntryInput,
  UpdateMessageInput,
  UpdateRunInput,
} from "./schemas";
import type { DeploymentConfig, TiDBConnectionConfig } from "../deployment";
import { redactString } from "../security/redaction";
import { ensureRestrictedDir, ensureRestrictedFile } from "../security/filePermissions";
import { dirname } from "node:path";
import { InMemoryRectorStore } from "./inMemoryRectorStore";
import { SqlRectorStore, createSqliteDriver, type SqlDriver } from "./sqlRectorStore";
import { createTiDBDriver } from "./tidbRectorStore";
import type { SessionSearchHit, SessionSearchQuery } from "./sessionSearch";

export * from "./schemas";
export * from "./inMemoryRectorStore";
export * from "./sqlRectorStore";
export * from "./tidbRectorStore";
export * from "./sessionSearch";
export * from "./lineage";

/**
 * The store contract shared by every Rector store implementation.
 *
 * Extracted byte-for-byte from the existing public async method surface of
 * `InMemoryRectorStore` so the in-memory store implements it without a single
 * signature change and remains the default and the test baseline.
 */
export interface RectorStore {
  createConversation(input: CreateConversationInput): Promise<Conversation>;
  getConversation(id: string): Promise<Conversation | undefined>;
  listConversations(workspaceId?: string): Promise<Conversation[]>;
  updateConversation(id: string, patch: UpdateConversationInput): Promise<Conversation | undefined>;
  deleteConversation(id: string): Promise<boolean>;
  searchConversations?(query: SessionSearchQuery): Promise<SessionSearchHit[]>;
  getConversationLineage?(conversationId: string): Promise<Conversation[]>;

  createMessage(input: CreateMessageInput): Promise<Message>;
  getMessage(id: string): Promise<Message | undefined>;
  listMessages(conversationId?: string): Promise<Message[]>;
  updateMessage(id: string, patch: UpdateMessageInput): Promise<Message | undefined>;
  deleteMessage(id: string): Promise<boolean>;

  createRun(input: CreateRunInput): Promise<Run>;
  getRun(id: string): Promise<Run | undefined>;
  listRuns(conversationId?: string): Promise<Run[]>;
  updateRun(id: string, patch: UpdateRunInput): Promise<Run | undefined>;
  deleteRun(id: string): Promise<boolean>;
  commitRunTransition(
    runId: string,
    patch: UpdateRunInput,
    event: RunEvent
  ): Promise<{ run: Run; event: RunEvent }>;

  appendEvent(event: RunEvent): Promise<RunEvent>;
  getEvent(id: string): Promise<RunEvent | undefined>;
  listEvents(runId?: string): Promise<RunEvent[]>;
  deleteEvent(id: string): Promise<boolean>;

  createArtifact(input: CreateArtifactInput): Promise<Artifact>;
  getArtifact(id: string): Promise<Artifact | undefined>;
  listArtifacts(kind?: string): Promise<Artifact[]>;
  updateArtifact(id: string, patch: UpdateArtifactInput): Promise<Artifact | undefined>;
  deleteArtifact(id: string): Promise<boolean>;

  // Advanced memory (Chunk 27 / neuro-symbolic Step 2)
  createMemoryEntry(input: CreateMemoryEntryInput): Promise<MemoryEntry>;
  getMemoryEntry(id: string): Promise<MemoryEntry | undefined>;
  listMemoryEntries(layer?: MemoryLayer): Promise<MemoryEntry[]>;
  updateMemoryEntry(id: string, patch: UpdateMemoryEntryInput): Promise<MemoryEntry | undefined>;
  deleteMemoryEntry(id: string): Promise<boolean>;
  searchMemory(query?: string, options?: { layer?: MemoryLayer; limit?: number }): Promise<MemoryEntry[]>;
  pruneMemory(options?: { targetLayer?: MemoryLayer; maxEntries?: number }): Promise<{ pruned: number; summarized: number }>;
}

/**
 * The persistence configuration block consumed by {@link createRectorStore},
 * i.e. `DeploymentConfig["persistence"]`.
 */
export type PersistenceConfig = DeploymentConfig["persistence"];

/** Optional construction overrides for {@link createRectorStore}. */
export interface CreateRectorStoreOverrides {
  /** An injected SqlDriver that ALWAYS wins over the configured driver. */
  driver?: SqlDriver;
  /** Deterministic clock forwarded to the constructed store (tests). */
  now?: () => string;
  /** AES-256-GCM key for SQLite payload encryption at rest. When provided, all
   *  payloads are sealed with AES-256-GCM and prefixed with `ENC1:`; unencrypted
   *  (legacy) rows are still readable for backward compat. */
  encryptionKey?: Buffer;
  /** HMAC-SHA256 key for SQLite payload integrity verification. When provided,
   *  MACs are computed on insert/update and verified on read. Rows without a MAC
   *  (legacy) are accepted with a warning. Derived from the master key via
   *  `deriveMacKey()` with info `"rector.payload-mac.v1"`. */
  macKey?: Buffer;
}

/**
 * Raised when the persistence configuration is invalid — an unknown driver, or
 * a `tidb` driver with a missing/incomplete connection block. Thrown before any
 * store is constructed and before any I/O (no file handle, no network).
 */
export class StoreConfigError extends Error {
  readonly name = "StoreConfigError";
  constructor(message: string) {
    super(message);
  }
}

/** The local SQLite file used when `driver === "sqlite"` and no path is configured. */
export const DEFAULT_SQLITE_PATH = ".rector/rector.db";

/**
 * The TiDB connection fields that must all be present AND non-empty for the
 * hosted path (Req 8.2: a field that is missing OR empty names that field).
 *
 * A string field is treated as absent when it is undefined or trims to empty;
 * `port` is treated as absent when it is undefined or not a finite number.
 * Raised before any driver is constructed, so no network connection is
 * attempted for an incomplete config.
 */
function assertCompleteTiDBConfig(
  tidb: TiDBConnectionConfig | undefined
): asserts tidb is Required<Pick<TiDBConnectionConfig, "host" | "port" | "user" | "password" | "database">> &
  TiDBConnectionConfig {
  const isBlankString = (value: unknown): boolean =>
    typeof value !== "string" || value.trim().length === 0;
  const isInvalidPort = (value: unknown): boolean =>
    typeof value !== "number" || !Number.isFinite(value);

  const missing: string[] = [];
  if (!tidb || isBlankString(tidb.host)) missing.push("host");
  if (!tidb || isInvalidPort(tidb.port)) missing.push("port");
  if (!tidb || isBlankString(tidb.user)) missing.push("user");
  if (!tidb || isBlankString(tidb.password)) missing.push("password");
  if (!tidb || isBlankString(tidb.database)) missing.push("database");
  if (missing.length > 0) {
    throw new StoreConfigError(
      `Persistence driver "tidb" requires a complete connection block; missing: ${missing.join(", ")}.`
    );
  }
}

/**
 * Resolve which {@link RectorStore} implementation to construct from the
 * deployment persistence configuration.
 *
 * Selection rules:
 * - An injected `overrides.driver` ALWAYS wins: a {@link SqlRectorStore} is
 *   built over it regardless of the configured driver value.
 * - `memory` (or an absent config) returns the default {@link InMemoryRectorStore},
 *   the provider-free baseline — no I/O.
 * - `sqlite` returns a {@link SqlRectorStore} over a local SQLite file (no cloud
 *   account, no network), defaulting the path to {@link DEFAULT_SQLITE_PATH}.
 * - `tidb` returns a {@link SqlRectorStore} over the optional hosted TiDB driver,
 *   built only from a complete connection block.
 *
 * An unknown driver, or a `tidb` driver with a missing/incomplete connection
 * block, raises a {@link StoreConfigError} BEFORE any store is constructed and
 * before any I/O (no file handle opened, no network connection attempted).
 *
 * The `mongoUri`, `mongoDb`, and `redisUrl` fields are ignored for selection and
 * no Mongo client dependency is added.
 */
export function createRectorStore(
  config?: PersistenceConfig,
  overrides?: CreateRectorStoreOverrides
): RectorStore {
  // An injected driver always wins (tests inject an in-memory SqlDriver double).
  if (overrides?.driver) {
    return new SqlRectorStore({ driver: overrides.driver, now: overrides?.now, encryptionKey: overrides?.encryptionKey, macKey: overrides?.macKey });
  }

  const driver = config?.driver ?? "memory";

  switch (driver) {
    case "memory":
      // DEFAULT + test baseline, unchanged. No I/O.
      return new InMemoryRectorStore({ now: overrides?.now });

    case "sqlite": {
      const path = config?.sqlitePath ?? DEFAULT_SQLITE_PATH;
      // ":memory:" is the SQLite in-memory sentinel — it is not a real filesystem
      // path, so skip file-permission operations that would fail or warn on it.
      const isInMemory = path === ":memory:";
      if (!isInMemory) {
        ensureRestrictedDir(dirname(path));
      }
      const store = new SqlRectorStore({
        driver: createSqliteDriver({ path }),
        now: overrides?.now,
        encryptionKey: overrides?.encryptionKey,
        macKey: overrides?.macKey,
      });
      if (!isInMemory) {
        ensureRestrictedFile(path);
      }
      return store;
    }

    case "tidb": {
      // Validate the connection block BEFORE constructing the driver so no
      // network connection is attempted for an incomplete config.
      const tidb = config?.tidb;
      assertCompleteTiDBConfig(tidb);
      const { host, port, user, password, database, tls } = tidb;
      return new SqlRectorStore({
        driver: createTiDBDriver({ host, port, user, password, database, tls }),
        now: overrides?.now,
        encryptionKey: overrides?.encryptionKey,
        macKey: overrides?.macKey,
      });
    }

    default:
      // Defensive: the schema constrains driver to the enum, but a malformed
      // config object could still carry an unknown value. Fail before any I/O.
      throw new StoreConfigError(`Unknown persistence driver: ${String(driver)}.`);
  }
}

/**
 * The relational tables the {@link runStartupMigration} step verifies and
 * provisions before the Rector_Server serves any request (Req 8.4). The order
 * mirrors the entity DDL emitted by {@link SqlRectorStore}.
 */
export const STARTUP_MIGRATION_TABLES = [
  "conversations",
  "messages",
  "runs",
  "run_events",
  "artifacts",
  "memories",
] as const;

/**
 * The Startup_Migration deadline in milliseconds (Req 8.8): connect + provision
 * must complete within this window or startup is halted.
 */
export const DEFAULT_STARTUP_MIGRATION_DEADLINE_MS = 30_000;

/**
 * Raised when the Startup_Migration cannot establish the persistence connection
 * or provision the relational tables within the deadline (Req 8.8). The message
 * is routed through {@link redactString} so no connection password or embedded
 * URL credential can leak; on this error the caller halts startup and serves no
 * request.
 */
export class PersistenceInitializationError extends Error {
  readonly name = "PersistenceInitializationError";
  constructor(message: string) {
    super(message);
  }
}

/** Construction overrides for {@link runStartupMigration}. */
export interface StartupMigrationOverrides extends CreateRectorStoreOverrides {
  /**
   * The connect+provision deadline in milliseconds. Defaults to
   * {@link DEFAULT_STARTUP_MIGRATION_DEADLINE_MS}. Exposed for deterministic
   * tests of the timeout path.
   */
  deadlineMs?: number;
}

/**
 * Race a unit of provisioning work against a deadline (Req 8.8). On expiry the
 * returned promise rejects with the supplied timeout error; the timer is always
 * cleared and is `unref`'d so it never keeps the process alive on its own.
 */
async function withDeadline<T>(
  work: Promise<T>,
  deadlineMs: number,
  onTimeout: () => Error
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), deadlineMs);
    if (typeof timer.unref === "function") timer.unref();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Verify that each of the {@link STARTUP_MIGRATION_TABLES} is present and
 * queryable by issuing a bounded list read against every entity through the
 * public store surface. A table that was not provisioned surfaces here as a
 * driver error, which {@link runStartupMigration} classifies as an
 * initialization failure.
 */
async function verifyStartupTables(store: RectorStore): Promise<void> {
  await store.listConversations();
  await store.listMessages();
  await store.listRuns();
  await store.listEvents();
  await store.listArtifacts();
  await store.listMemoryEntries();
}

/**
 * The boot-time Startup_Migration step (Req 8.4, 8.8).
 *
 * Constructs the configured {@link RectorStore} and, for the relational paths,
 * provisions the six entity tables (the {@link SqlRectorStore} constructor runs
 * idempotent `CREATE TABLE IF NOT EXISTS` DDL) and then verifies each of the
 * {@link STARTUP_MIGRATION_TABLES} exists and is queryable — all **before** the
 * server serves any request. The combined connect + provision work is raced
 * against a 30 000 ms deadline ({@link DEFAULT_STARTUP_MIGRATION_DEADLINE_MS}).
 *
 * On timeout or provision failure the step rejects with a
 * {@link PersistenceInitializationError} whose message is redacted, so the
 * caller halts startup and serves nothing. A {@link StoreConfigError} (an
 * incomplete config detected before any connection, Req 8.2) propagates
 * unchanged so the operator still sees the named missing field(s).
 */
export async function runStartupMigration(
  config?: PersistenceConfig,
  overrides?: StartupMigrationOverrides
): Promise<RectorStore> {
  const deadlineMs = overrides?.deadlineMs ?? DEFAULT_STARTUP_MIGRATION_DEADLINE_MS;

  const provision = (async (): Promise<RectorStore> => {
    // Constructing the store opens the (pooled) connection for the `tidb` path
    // and runs `migrate()` to provision every missing table.
    const store = createRectorStore(config, overrides);
    await verifyStartupTables(store);
    return store;
  })();

  try {
    return await withDeadline(
      provision,
      deadlineMs,
      () =>
        new PersistenceInitializationError(
          redactString(
            `Persistence initialization failed: the Startup_Migration did not connect and ` +
              `provision the ${STARTUP_MIGRATION_TABLES.join(", ")} tables within ${deadlineMs} ms.`
          )
        )
    );
  } catch (error) {
    // A timeout is already the right, redacted error.
    if (error instanceof PersistenceInitializationError) throw error;
    // An incomplete-config error is raised before any connection and names the
    // missing field(s); surface it unchanged rather than as a generic failure.
    if (error instanceof StoreConfigError) throw error;
    const detail = redactString(error instanceof Error ? error.message : String(error));
    throw new PersistenceInitializationError(`Persistence initialization failed: ${detail}`);
  }
}
