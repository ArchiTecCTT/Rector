import { afterEach, describe, expect, it } from "vitest";
import {
  createRectorStore,
  createSqliteDriver,
  InMemoryRectorStore,
  SqlRectorStore,
  type RectorStore,
  type SqlDriver,
} from "../src/store";
import { parseDeploymentEnvironment } from "../src/deployment";

/**
 * Read-back-mismatch and local-default unit tests for the store factory path (task 8.4).
 *
 * These deterministic, example-based tests pin down two guarantees of the persistence layer
 * exercised end-to-end through `createRectorStore`, with ZERO network or provider calls:
 *
 *  - Read-back mismatch reporting (Requirement 8.2): a write-then-read-back cycle over the store
 *    factory path PASSES only when the read-back record matches the written record field-for-field;
 *    when the persisted representation is tampered with so the read-back diverges, the mismatch is
 *    surfaced — either as a field-for-field difference the smoke contract reports as a FAILURE, or,
 *    when the tampered payload no longer satisfies its schema, as a redaction-applied read-back
 *    error rather than a silently-returned malformed record.
 *  - Local default selection (Requirement 8.6): when no persistence driver is explicitly
 *    configured, the factory selects a local, network-free store (the in-memory baseline) and never
 *    the optional hosted TiDB path; the local file-backed `sqlite` driver round-trips correctly.
 *
 * Every case stays off the network: the SQLite cases use an in-memory SQLite database (`:memory:`)
 * via Node's built-in `node:sqlite`, and no TiDB connection is ever constructed.
 *
 * _Requirements: 8.2, 8.6_
 */

// --- field-for-field comparison mirroring the TiDB smoke-test contract -------

/** Deep, order-insensitive structural equality used for the field-for-field check. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => deepEqual(value, b[index]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a as Record<string, unknown>).sort();
    const bKeys = Object.keys(b as Record<string, unknown>).sort();
    if (aKeys.length !== bKeys.length || aKeys.some((key, index) => key !== bKeys[index])) {
      return false;
    }
    return aKeys.every((key) =>
      deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
    );
  }
  return false;
}

/** List the field names whose values differ between the written and read-back records. */
function diffFields(written: Record<string, unknown>, readBack: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(written), ...Object.keys(readBack)]);
  const mismatched: string[] = [];
  for (const key of keys) {
    if (!deepEqual(written[key], readBack[key])) mismatched.push(key);
  }
  return mismatched.sort();
}

/**
 * Wrap a real `SqlDriver` so that single-row payload read-backs are passed through a tamper hook,
 * leaving every other statement (DDL, seq/id scans, inserts) untouched. This lets a test corrupt
 * exactly what comes back from a read while the store writes and reads through its real code path.
 */
function tamperingReadDriver(
  inner: SqlDriver,
  tamper: (payload: unknown) => unknown
): SqlDriver {
  return {
    dialect: inner.dialect,
    exec: (sql) => inner.exec(sql),
    run: (sql, params) => inner.run(sql, params),
    get<T = unknown>(sql: string, params?: unknown[]): T | undefined {
      const row = inner.get<T>(sql, params);
      // The store reads an entity back with `SELECT payload FROM <table> WHERE id = ?`; only those
      // payload-bearing single-row reads are tampered with.
      if (row !== undefined && /select\s+payload\s+from/i.test(sql)) {
        const record = row as { payload: unknown };
        return { ...record, payload: tamper(record.payload) } as T;
      }
      return row;
    },
    all: <T = unknown>(sql: string, params?: unknown[]) => inner.all<T>(sql, params),
    close: () => inner.close(),
  };
}

const NOW = () => "2026-06-03T00:00:00.000Z";

const CONVERSATION_INPUT = {
  title: "read-back fixture",
  workspaceId: "workspace-1",
  retentionPolicy: "default" as const,
};

describe("store read-back mismatch reporting and local default selection (task 8.4)", () => {
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

  // --- Read-back mismatch reporting (Requirement 8.2) ----------------------

  describe("write-then-read-back mismatch reporting", () => {
    it("reports a match when the read-back record equals the written record field-for-field", async () => {
      const driver = track(createSqliteDriver({ path: ":memory:" }));
      const store: RectorStore = createRectorStore({ driver: "sqlite" }, { driver, now: NOW });

      const written = await store.createConversation(CONVERSATION_INPUT);
      const readBack = await store.getConversation(written.id);

      expect(readBack).toBeDefined();
      const mismatched = diffFields(
        written as unknown as Record<string, unknown>,
        readBack as unknown as Record<string, unknown>
      );
      // No mismatched fields -> the smoke contract reports a PASS.
      expect(mismatched).toEqual([]);
      expect(readBack).toEqual(written);
    });

    it("reports a failure when a tampered read-back diverges from the written record field-for-field", async () => {
      // The store writes faithfully; only the read-back payload is tampered so a single field drifts.
      const inner = createSqliteDriver({ path: ":memory:" });
      const driver = track(
        tamperingReadDriver(inner, (payload) => {
          const record = JSON.parse(payload as string) as Record<string, unknown>;
          return JSON.stringify({ ...record, title: "tampered-on-read" });
        })
      );
      const store: RectorStore = createRectorStore({ driver: "sqlite" }, { driver, now: NOW });

      const written = await store.createConversation(CONVERSATION_INPUT);
      const readBack = await store.getConversation(written.id);

      expect(readBack).toBeDefined();
      const mismatched = diffFields(
        written as unknown as Record<string, unknown>,
        readBack as unknown as Record<string, unknown>
      );
      // A diverging field is detected -> the smoke contract reports this cycle as a FAILURE.
      expect(mismatched).toContain("title");
      expect(readBack?.title).toBe("tampered-on-read");
      expect(readBack?.title).not.toBe(written.title);
    });

    it("surfaces a redacted read-back error rather than returning a schema-invalid record", async () => {
      // Tamper the read-back so the persisted payload no longer satisfies the entity schema (a
      // required field is dropped). The store must reject the corrupt read-back instead of handing
      // back a malformed record, and the error must be redaction-applied.
      const inner = createSqliteDriver({ path: ":memory:" });
      const driver = track(
        tamperingReadDriver(inner, (payload) => {
          const record = JSON.parse(payload as string) as Record<string, unknown>;
          delete record.workspaceId; // required by ConversationSchema
          return JSON.stringify(record);
        })
      );
      const store: RectorStore = createRectorStore({ driver: "sqlite" }, { driver, now: NOW });

      const written = await store.createConversation(CONVERSATION_INPUT);
      await expect(store.getConversation(written.id)).rejects.toThrow(/corrupt conversation payload/i);
    });
  });

  // --- Local default selection (Requirement 8.6) ---------------------------

  describe("local default persistence selection", () => {
    it("selects a local, network-free store when no driver is configured", () => {
      // No config at all -> the provider-free local baseline, never the hosted TiDB path.
      const store = createRectorStore();
      expect(store).toBeInstanceOf(InMemoryRectorStore);
    });

    it("selects a local store from a default-parsed deployment config with no driver set", () => {
      // An empty environment parses to the local default persistence block; building a store from
      // it stays local (no TiDB connection is constructed and no network is touched).
      const config = parseDeploymentEnvironment({});
      const store = createRectorStore(config.persistence);
      expect(store).toBeInstanceOf(InMemoryRectorStore);
      expect(store).not.toBeInstanceOf(SqlRectorStore);
    });

    it("round-trips through the local file-backed SQLite driver without a network call", async () => {
      // The local default driver for durable persistence is SQLite; ":memory:" exercises the real
      // node:sqlite path off disk and off network.
      const store = createRectorStore({ driver: "sqlite", sqlitePath: ":memory:" }, { now: NOW });
      expect(store).toBeInstanceOf(SqlRectorStore);

      const written = await store.createConversation(CONVERSATION_INPUT);
      const readBack = await store.getConversation(written.id);
      expect(readBack).toEqual(written);
    });
  });
});
