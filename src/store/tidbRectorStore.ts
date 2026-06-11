import { createRequire } from "node:module";

import type { SqlDriver } from "./sqlRectorStore";

/** Default upper bound on simultaneously-open pooled connections (Req 8.1). */
export const DEFAULT_TIDB_CONNECTION_LIMIT = 10;
/**
 * Default per-connection acquisition/connect timeout in milliseconds. Aligned
 * with the 30s Startup_Migration connect deadline so a stalled TiDB Cloud
 * gateway surfaces as a connect error rather than hanging indefinitely.
 */
export const DEFAULT_TIDB_CONNECT_TIMEOUT_MS = 30_000;

/**
 * Connection options for the optional hosted TiDB Cloud persistence path.
 *
 * TiDB Cloud speaks the MySQL wire protocol, so the driver connects with a
 * MySQL-compatible client. This path is the optional hosted alpha only: it is
 * never auto-selected for local use. `createRectorStore` constructs it solely
 * when the deployment is explicitly configured with `driver: "tidb"` and a
 * complete connection block.
 */
export interface TiDBDriverInput {
  /** TiDB Cloud host endpoint. */
  host: string;
  /** TiDB Cloud port (typically 4000). */
  port: number;
  /** Database user. */
  user: string;
  /** Database password. Held only inside the client; never logged. */
  password: string;
  /** Target database/schema name. */
  database: string;
  /** Enable TLS. TiDB Cloud requires it, so this defaults to `true`. */
  tls?: boolean;
  /**
   * Maximum number of connections the pool keeps open at once. Defaults to
   * {@link DEFAULT_TIDB_CONNECTION_LIMIT}. The hosted client multiplexes the
   * synchronous `SqlDriver` calls over this pool rather than a single socket.
   */
  connectionLimit?: number;
  /**
   * Maximum number of connection requests the pool queues before rejecting.
   * `0` (the default) queues without bound, matching the underlying client.
   */
  queueLimit?: number;
  /**
   * Per-connection connect timeout in milliseconds. Defaults to
   * {@link DEFAULT_TIDB_CONNECT_TIMEOUT_MS}.
   */
  connectTimeoutMs?: number;
}

/**
 * The minimal shape of the synchronous MySQL client this module depends on at
 * runtime. It is declared locally so the module type-checks and builds without
 * the optional MySQL client package installed — the package is required only
 * when a caller actually constructs the TiDB driver.
 *
 * The client is pool-backed: its config is forwarded to the MySQL driver's
 * `createPool`, so a single instance multiplexes queries over the pool and
 * `dispose()` drains and closes every pooled connection.
 */
interface SyncMysqlConnection {
  query(sql: string, params?: unknown[]): unknown;
  dispose(): void;
}

type SyncMysqlConstructor = new (options: Record<string, unknown>) => SyncMysqlConnection;

/**
 * The optional synchronous MySQL-wire client. It is intentionally NOT a static
 * import: keeping it out of the module graph lets the build and the test suite
 * (which never use the hosted path) succeed without the package installed and
 * without opening any network connection.
 */
const OPTIONAL_MYSQL_CLIENT = "sync-mysql";

function loadSyncMysqlClient(): SyncMysqlConstructor {
  const requireFromHere = createRequire(import.meta.url);
  try {
    return requireFromHere(OPTIONAL_MYSQL_CLIENT) as SyncMysqlConstructor;
  } catch {
    throw new Error(
      `The TiDB Cloud persistence path requires the optional "${OPTIONAL_MYSQL_CLIENT}" ` +
        `dependency, which is not installed. Run \`npm install ${OPTIONAL_MYSQL_CLIENT}\` to ` +
        `enable driver "tidb", or use the default in-memory or local "sqlite" persistence ` +
        `instead (no cloud account or network required).`
    );
  }
}

function toRows<T>(result: unknown): T[] {
  // SELECT queries return a row array; write statements return an OK packet
  // object, which carries no rows.
  return Array.isArray(result) ? (result as T[]) : [];
}

/**
 * Create the optional hosted TiDB Cloud `SqlDriver` over the MySQL wire protocol.
 *
 * This driver conforms to the exact same synchronous `SqlDriver` contract as the
 * local SQLite driver, bridging the MySQL-compatible client behind a thin
 * synchronous wrapper. The client is configured as a **connection pool**: rather
 * than a single long-lived socket, it forwards pool options
 * (`connectionLimit`, `waitForConnections`, `queueLimit`, `connectTimeout`) to
 * the underlying MySQL driver's `createPool`, so concurrent store operations are
 * multiplexed across pooled connections and `close()` drains the whole pool.
 *
 * No connection is opened until this function is invoked, and it is never
 * auto-constructed for local use — only an explicit `driver: "tidb"`
 * configuration reaches this code path.
 *
 * The connection password lives only inside the underlying client; it is never
 * logged, echoed, or included in any thrown error message.
 */
export function createTiDBDriver(input: TiDBDriverInput): SqlDriver {
  const SyncMysql = loadSyncMysqlClient();

  const pool = new SyncMysql({
    host: input.host,
    port: input.port,
    user: input.user,
    password: input.password,
    database: input.database,
    // TiDB Cloud requires TLS; opt out only when explicitly disabled.
    ssl: input.tls === false ? undefined : { minVersion: "TLSv1.2" },
    multipleStatements: false,
    // Connection pooling: the synchronous client forwards these to the MySQL
    // driver's createPool. A bounded pool with a connect timeout keeps the
    // hosted path resilient under concurrency and surfaces a stalled gateway as
    // a connect error rather than an indefinite hang.
    connectionLimit: input.connectionLimit ?? DEFAULT_TIDB_CONNECTION_LIMIT,
    waitForConnections: true,
    queueLimit: input.queueLimit ?? 0,
    connectTimeout: input.connectTimeoutMs ?? DEFAULT_TIDB_CONNECT_TIMEOUT_MS,
  });

  return {
    dialect: "mysql",
    exec(sql: string): void {
      pool.query(sql);
    },
    run(sql: string, params?: unknown[]): void {
      pool.query(sql, params ?? []);
    },
    get<T = unknown>(sql: string, params?: unknown[]): T | undefined {
      const rows = toRows<T>(pool.query(sql, params ?? []));
      return rows.length > 0 ? rows[0] : undefined;
    },
    all<T = unknown>(sql: string, params?: unknown[]): T[] {
      return toRows<T>(pool.query(sql, params ?? []));
    },
    close(): void {
      // Drains and closes every pooled connection (pool.end under the hood).
      pool.dispose();
    },
  };
}
