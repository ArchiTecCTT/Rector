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
