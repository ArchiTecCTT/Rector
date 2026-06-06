import type {
  Artifact,
  Conversation,
  CreateArtifactInput,
  CreateConversationInput,
  CreateMessageInput,
  CreateRunInput,
  Message,
  Run,
  RunEvent,
  UpdateArtifactInput,
  UpdateConversationInput,
  UpdateMessageInput,
  UpdateRunInput,
} from "./schemas";
import type { DeploymentConfig, TiDBConnectionConfig } from "../deployment";
import { InMemoryRectorStore } from "./inMemoryRectorStore";
import { SqlRectorStore, createSqliteDriver, type SqlDriver } from "./sqlRectorStore";
import { createTiDBDriver } from "./tidbRectorStore";

export * from "./schemas";
export * from "./inMemoryRectorStore";
export * from "./sqlRectorStore";
export * from "./tidbRectorStore";

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

/** The TiDB connection fields that must all be present for the hosted path. */
function assertCompleteTiDBConfig(
  tidb: TiDBConnectionConfig | undefined
): asserts tidb is Required<Pick<TiDBConnectionConfig, "host" | "port" | "user" | "password" | "database">> &
  TiDBConnectionConfig {
  const missing: string[] = [];
  if (!tidb || tidb.host === undefined) missing.push("host");
  if (!tidb || tidb.port === undefined) missing.push("port");
  if (!tidb || tidb.user === undefined) missing.push("user");
  if (!tidb || tidb.password === undefined) missing.push("password");
  if (!tidb || tidb.database === undefined) missing.push("database");
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
    return new SqlRectorStore({ driver: overrides.driver, now: overrides?.now });
  }

  const driver = config?.driver ?? "memory";

  switch (driver) {
    case "memory":
      // DEFAULT + test baseline, unchanged. No I/O.
      return new InMemoryRectorStore({ now: overrides?.now });

    case "sqlite": {
      const path = config?.sqlitePath ?? DEFAULT_SQLITE_PATH;
      return new SqlRectorStore({ driver: createSqliteDriver({ path }), now: overrides?.now });
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
      });
    }

    default:
      // Defensive: the schema constrains driver to the enum, but a malformed
      // config object could still carry an unknown value. Fail before any I/O.
      throw new StoreConfigError(`Unknown persistence driver: ${String(driver)}.`);
  }
}
