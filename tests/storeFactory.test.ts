import { afterEach, describe, expect, it } from "vitest";
import {
  createRectorStore,
  StoreConfigError,
  DEFAULT_SQLITE_PATH,
  InMemoryRectorStore,
  SqlRectorStore,
  type PersistenceConfig,
  type SqlDriver,
} from "../src/store";

/**
 * Factory-selection and configuration-error unit tests for `createRectorStore` (task 3.3).
 *
 * These are deterministic, example-based tests that pin down the store the factory selects
 * for each persistence configuration and the configuration errors it raises BEFORE any store
 * is constructed or any I/O occurs:
 *
 *  - `memory`/absent  -> the default `InMemoryRectorStore` (no I/O).
 *  - `sqlite`         -> a `SqlRectorStore` backed by a local SQLite database.
 *  - `tidb` (complete connection block) -> config validation PASSES, so the factory proceeds
 *                       to driver construction (it does NOT raise a `StoreConfigError`).
 *  - an injected `overrides.driver` ALWAYS wins, regardless of the configured driver.
 *  - an unknown driver, or `tidb` with a missing/incomplete connection block, raises a
 *    `StoreConfigError` before any store construction or network I/O.
 *  - the `mongoUri`/`mongoDb`/`redisUrl` fields are ignored for selection.
 *
 * No API key, no network, no temp files: the sqlite case uses an in-memory SQLite database
 * (`:memory:`) and the injected-driver case uses an in-memory `SqlDriver` double.
 *
 * _Requirements: 1.8, 1.11, 1.12, 1.14_
 */

// A minimal in-memory `SqlDriver` double. It records the DDL the store runs on construction so
// the override tests can confirm a `SqlRectorStore` (not the in-memory store) was built over it,
// and performs no file or network I/O.
function fakeSqlDriver(): SqlDriver & { execSql: string[]; closed: boolean } {
  const execSql: string[] = [];
  const driver = {
    dialect: "sqlite" as const,
    execSql,
    closed: false,
    exec(sql: string): void {
      execSql.push(sql);
    },
    run(): void {
      /* no-op: selection tests never write */
    },
    get<T = unknown>(): T | undefined {
      return undefined;
    },
    all<T = unknown>(): T[] {
      return [] as T[];
    },
    close(): void {
      driver.closed = true;
    },
  };
  return driver;
}

// A complete TiDB connection block — every required field present. Used to prove that a complete
// block passes config validation (it must NOT raise a `StoreConfigError`).
const COMPLETE_TIDB: NonNullable<PersistenceConfig["tidb"]> = {
  host: "gateway.tidbcloud.example",
  port: 4000,
  user: "alpha-user",
  password: "not-a-real-password",
  database: "rector",
  tls: true,
};

describe("createRectorStore factory selection and configuration errors (task 3.3)", () => {
  const openDrivers = new Set<SqlDriver>();

  function track<T extends SqlDriver>(driver: T): T {
    openDrivers.add(driver);
    return driver;
  }

  afterEach(() => {
    for (const driver of openDrivers) {
      try {
        driver.close();
      } catch {
        /* already closed */
      }
    }
    openDrivers.clear();
  });

  // --- memory default (Requirement 1.1, baseline for 1.14) -----------------

  describe("memory default", () => {
    it("returns an InMemoryRectorStore when no config is supplied", () => {
      const store = createRectorStore();
      expect(store).toBeInstanceOf(InMemoryRectorStore);
    });

    it("returns an InMemoryRectorStore when the driver is explicitly \"memory\"", () => {
      const store = createRectorStore({ driver: "memory" });
      expect(store).toBeInstanceOf(InMemoryRectorStore);
    });
  });

  // --- sqlite selection (Requirement 1.6) ----------------------------------

  describe("sqlite selection", () => {
    it("returns a SqlRectorStore backed by SQLite for driver \"sqlite\"", () => {
      // ":memory:" keeps the test off disk (no temp file to clean up) while still exercising the
      // real SQLite driver construction the factory performs for the sqlite path.
      const store = createRectorStore({ driver: "sqlite", sqlitePath: ":memory:" });
      expect(store).toBeInstanceOf(SqlRectorStore);
      expect(store).not.toBeInstanceOf(InMemoryRectorStore);
    });

    it("exposes a default local SQLite path constant for the no-path sqlite case", () => {
      // The factory defaults the sqlite path to DEFAULT_SQLITE_PATH when none is configured; assert
      // the constant is a local (non-":memory:") file path so the no-path branch stays file-backed.
      expect(DEFAULT_SQLITE_PATH).toBe(".rector/rector.db");
      expect(DEFAULT_SQLITE_PATH).not.toBe(":memory:");
    });
  });

  // --- tidb selection (Requirement 1.12 success boundary) ------------------

  describe("tidb selection with a complete connection block", () => {
    it("passes config validation (does NOT raise a StoreConfigError) for a complete block", () => {
      // A COMPLETE tidb block must clear the factory's config-validation gate. Past that gate the
      // factory constructs the TiDB driver, which lazily requires the optional "sync-mysql" package
      // only when invoked. That package is not installed here, so construction throws a distinct
      // missing-dependency Error — NOT a StoreConfigError. The requirement under test (1.12) is that
      // a complete block is NOT rejected as a configuration error, so we assert exactly that.
      let caught: unknown;
      let store: unknown;
      try {
        store = createRectorStore({ driver: "tidb", tidb: COMPLETE_TIDB });
      } catch (error) {
        caught = error;
      }

      // Either the driver constructed (sync-mysql present) -> a SqlRectorStore, or it threw a
      // non-config error from driver construction. In neither case is it a StoreConfigError.
      expect(caught).not.toBeInstanceOf(StoreConfigError);
      if (caught === undefined) {
        // Only reachable if the optional "sync-mysql" package happens to be installed.
        expect(store).toBeInstanceOf(SqlRectorStore);
      } else {
        // The missing optional dependency is a generic Error whose message points at the package,
        // not a configuration error and not a network failure.
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).toContain("sync-mysql");
      }
    });
  });

  // --- injected-driver override precedence (Requirement 1.8) ---------------

  describe("injected-driver override precedence", () => {
    it("builds a SqlRectorStore over the injected driver even when the config selects memory", () => {
      const driver = track(fakeSqlDriver());
      const store = createRectorStore({ driver: "memory" }, { driver });
      expect(store).toBeInstanceOf(SqlRectorStore);
      expect(store).not.toBeInstanceOf(InMemoryRectorStore);
      // The injected driver was actually used: the store ran its DDL on construction.
      expect(driver.execSql.length).toBeGreaterThan(0);
    });

    it("builds a SqlRectorStore over the injected driver when no config is supplied", () => {
      const driver = track(fakeSqlDriver());
      const store = createRectorStore(undefined, { driver });
      expect(store).toBeInstanceOf(SqlRectorStore);
    });

    it("lets the injected driver win over a tidb config with an incomplete block (no error, no network)", () => {
      // Without the override this incomplete tidb block would raise a StoreConfigError; the injected
      // driver takes precedence so the factory never inspects the tidb block at all.
      const driver = track(fakeSqlDriver());
      const store = createRectorStore({ driver: "tidb", tidb: { host: "only-host" } }, { driver });
      expect(store).toBeInstanceOf(SqlRectorStore);
    });
  });

  // --- unknown-driver error (Requirement 1.11) -----------------------------

  describe("unknown-driver error", () => {
    it("throws a StoreConfigError for a driver outside { memory, sqlite, tidb }", () => {
      // Cast through unknown: a malformed config object can carry a value the enum forbids; the
      // factory must still fail with a config error before constructing any store or doing any I/O.
      const badConfig = { driver: "postgres" } as unknown as PersistenceConfig;
      expect(() => createRectorStore(badConfig)).toThrow(StoreConfigError);
    });
  });

  // --- incomplete-tidb error (Requirement 1.12) ----------------------------

  describe("incomplete-tidb error", () => {
    it("throws a StoreConfigError when the tidb connection block is entirely absent", () => {
      expect(() => createRectorStore({ driver: "tidb" })).toThrow(StoreConfigError);
    });

    it("throws a StoreConfigError when the tidb connection block is incomplete", () => {
      // Missing port/user/password/database — the factory must reject before any network attempt.
      let caught: unknown;
      try {
        createRectorStore({ driver: "tidb", tidb: { host: "gateway.tidbcloud.example" } });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(StoreConfigError);
      // The error names the missing fields and never mentions the optional driver dependency,
      // confirming it was raised at config validation rather than at driver construction.
      const message = (caught as Error).message;
      expect(message).toMatch(/missing/i);
      expect(message).not.toContain("sync-mysql");
    });
  });

  // --- Mongo fields ignored (Requirement 1.14) -----------------------------

  describe("Mongo/Redis fields ignored for selection", () => {
    it("still returns an InMemoryRectorStore when mongo/redis fields are present", () => {
      const store = createRectorStore({
        driver: "memory",
        mongoUri: "mongodb://localhost:27017",
        mongoDb: "rector",
        redisUrl: "redis://localhost:6379",
      });
      expect(store).toBeInstanceOf(InMemoryRectorStore);
    });

    it("does not let mongo/redis fields change an injected-driver selection", () => {
      const driver = track(fakeSqlDriver());
      const store = createRectorStore(
        {
          driver: "memory",
          mongoUri: "mongodb://localhost:27017",
          mongoDb: "rector",
          redisUrl: "redis://localhost:6379",
        },
        { driver }
      );
      expect(store).toBeInstanceOf(SqlRectorStore);
    });
  });
});
