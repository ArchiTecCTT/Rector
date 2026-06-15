import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PersistenceInitializationError,
  runStartupMigration,
  STARTUP_MIGRATION_TABLES,
  SqlRectorStore,
  type CreateConversationInput,
  type PersistenceConfig,
  type RectorStore,
  type SqlDriver,
} from "../src/store";
import { RUN_PHASES } from "../src/protocol/phases";

/**
 * Task 12.5 — Integration test for the pooled TiDB driver and the
 * Startup_Migration verify/provision sequence.
 *
 * _Validates: Requirements 8.1, 8.4_
 *
 * `runStartupMigration` (src/store/index.ts) is the boot-time step that, for the
 * hosted `tidb` path, constructs the TiDB-style `SqlRectorStore` over a pooled
 * MySQL-wire driver, provisions the five entity tables (the store constructor
 * runs idempotent `CREATE TABLE IF NOT EXISTS` DDL), and then verifies every one
 * of {@link STARTUP_MIGRATION_TABLES} is present and queryable — all BEFORE the
 * server serves any request.
 *
 * This test exercises that exact sequence end-to-end without a real database. It
 * injects a hermetic **pooled** `SqlDriver` double whose `dialect` is `"mysql"`
 * (so the store emits the MySQL-dialect DDL it would use against TiDB Cloud) and
 * which multiplexes every query over a fixed pool of in-process connections that
 * share a single in-memory relational backend. No network, no cloud account, no
 * optional `sync-mysql` dependency, no disk — the injected driver short-circuits
 * the real `createTiDBDriver` path while preserving the production
 * `runStartupMigration` -> `createRectorStore` -> `SqlRectorStore` wiring.
 */

// --- Pooled MySQL-wire SqlDriver double ------------------------------------

interface BackendRow {
  id: string;
  filter: string | null;
  seq: number;
  payload: unknown;
  mac: string | null;
}

interface PooledMysqlDriverDouble extends SqlDriver {
  /** Every DDL statement the store ran on construction (the provision step). */
  readonly ddl: readonly string[];
  /** The set of tables that have been provisioned in the backend. */
  readonly provisionedTables: () => string[];
  /** Total queries routed through the pool across every pooled connection. */
  readonly totalQueries: () => number;
  /** How many distinct pooled connections actually served a query. */
  readonly connectionsUsed: () => number;
  /** Whether the whole pool has been drained/closed. */
  readonly isClosed: () => boolean;
}

/**
 * Build a hermetic, in-memory, pool-backed `SqlDriver` double that speaks the
 * `mysql` dialect. It understands exactly the bounded set of SQL shapes that
 * {@link SqlRectorStore} issues (DDL, `INSERT`, `UPDATE`, `DELETE`, the
 * `seq`/existence/by-id reads, and the ordered list reads) and emulates them
 * over a `Map`-of-`Map` relational backend.
 *
 * The "pool" is modelled as a fixed array of connection slots that all share the
 * same backend; every query is routed round-robin across the slots so the test
 * can observe that the driver multiplexes work across more than one pooled
 * connection (Req 8.1, connection pooling) rather than a single socket.
 */
function createPooledMysqlDriverDouble(
  options: { connectionLimit?: number } = {}
): PooledMysqlDriverDouble {
  const connectionLimit = options.connectionLimit ?? 4;

  let tables = new Map<string, Map<string, BackendRow>>();
  let tx: Map<string, Map<string, BackendRow>> | null = null;
  const ddl: string[] = [];
  let closed = false;

  // Pool bookkeeping: a fixed slot array, round-robin routing, usage tracking.
  const slots = Array.from({ length: connectionLimit }, (_, id) => ({ id, queries: 0 }));
  const usedSlotIds = new Set<number>();
  let totalQueries = 0;

  function route(): void {
    if (closed) throw new Error("pool is closed");
    const slot = slots[totalQueries % connectionLimit];
    slot.queries += 1;
    usedSlotIds.add(slot.id);
    totalQueries += 1;
  }

  const norm = (sql: string): string => sql.replace(/\s+/g, " ").trim();
  const tableFrom = (q: string, re: RegExp): string => {
    const match = re.exec(q);
    if (!match) throw new Error(`Cannot find table in: ${q}`);
    return match[1];
  };
  const requireTable = (name: string): Map<string, BackendRow> => {
    const table = tables.get(name);
    if (!table) throw new Error(`Table not provisioned: ${name}`);
    return table;
  };
  const snapshot = (): Map<string, Map<string, BackendRow>> => {
    const copy = new Map<string, Map<string, BackendRow>>();
    for (const [name, rows] of tables) {
      copy.set(name, new Map([...rows].map(([id, row]) => [id, { ...row }])));
    }
    return copy;
  };

  const driver: PooledMysqlDriverDouble = {
    dialect: "mysql",
    ddl,
    provisionedTables: () => [...tables.keys()],
    totalQueries: () => totalQueries,
    connectionsUsed: () => usedSlotIds.size,
    isClosed: () => closed,

    exec(sql: string): void {
      route();
      const q = norm(sql);
      if (/^CREATE TABLE IF NOT EXISTS/i.test(q)) {
        const name = tableFrom(q, /CREATE TABLE IF NOT EXISTS (\w+)/i);
        ddl.push(q);
        if (!tables.has(name)) tables.set(name, new Map());
        return;
      }
      if (/^BEGIN/i.test(q)) {
        tx = snapshot();
        return;
      }
      if (/^COMMIT/i.test(q)) {
        tx = null;
        return;
      }
      if (/^ROLLBACK/i.test(q)) {
        if (tx) tables = tx;
        tx = null;
        return;
      }
      throw new Error(`Unsupported exec statement: ${q}`);
    },

    run(sql: string, params?: unknown[]): void {
      route();
      const q = norm(sql);
      const p = params ?? [];
      if (/^INSERT INTO/i.test(q)) {
        const name = tableFrom(q, /INSERT INTO (\w+)/i);
        const table = requireTable(name);
        const id = String(p[0]);
        // With MAC column: INSERT INTO <table> (id, filter, seq, payload, mac) VALUES (?, ?, ?, ?, ?)
        // Without MAC column: INSERT INTO <table> (id, filter, seq, payload) VALUES (?, ?, ?, ?)
        const hasMac = p.length >= 5;
        table.set(id, {
          id,
          filter: p[1] === undefined || p[1] === null ? null : String(p[1]),
          seq: Number(p[2]),
          payload: p[3],
          mac: hasMac ? (p[4] === undefined || p[4] === null ? null : String(p[4])) : null,
        });
        return;
      }
      if (/^UPDATE/i.test(q)) {
        const name = tableFrom(q, /UPDATE (\w+)/i);
        const table = requireTable(name);
        const row = table.get(String(p[p.length - 1]));
        if (row) {
          row.filter = p[0] === undefined || p[0] === null ? null : String(p[0]);
          row.payload = p[1];
          // With MAC: UPDATE <table> SET <col> = ?, payload = ?, mac = ? WHERE id = ?
          if (p.length >= 4) {
            row.mac = p[2] === undefined || p[2] === null ? null : String(p[2]);
          }
        }
        return;
      }
      if (/^DELETE FROM/i.test(q)) {
        const name = tableFrom(q, /DELETE FROM (\w+)/i);
        requireTable(name).delete(String(p[0]));
        return;
      }
      throw new Error(`Unsupported run statement: ${q}`);
    },

    get<T = unknown>(sql: string, params?: unknown[]): T | undefined {
      route();
      const q = norm(sql);
      const p = params ?? [];
      // nextSeq: SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM <table>
      if (/COALESCE\(MAX\(seq\)/i.test(q)) {
        const name = tableFrom(q, /FROM (\w+)/i);
        const rows = [...requireTable(name).values()];
        const max = rows.reduce((acc, row) => (row.seq > acc ? row.seq : acc), 0);
        return { next: max + 1 } as unknown as T;
      }
      // rowExists: SELECT id FROM <table> WHERE id = ?
      if (/^SELECT id FROM \w+ WHERE id = \?$/i.test(q)) {
        const name = tableFrom(q, /FROM (\w+)/i);
        const row = requireTable(name).get(String(p[0]));
        return row ? ({ id: row.id } as unknown as T) : undefined;
      }
      // readRow: SELECT payload, mac FROM <table> WHERE id = ?
      if (/^SELECT payload,?\s*mac? FROM \w+ WHERE id = \?$/i.test(q)) {
        const name = tableFrom(q, /FROM (\w+)/i);
        const row = requireTable(name).get(String(p[0]));
        return row ? ({ payload: row.payload, mac: row.mac } as unknown as T) : undefined;
      }
      throw new Error(`Unsupported get statement: ${q}`);
    },

    all<T = unknown>(sql: string, params?: unknown[]): T[] {
      route();
      const q = norm(sql);
      const p = params ?? [];
      const name = tableFrom(q, /FROM (\w+)/i);
      const rows = [...requireTable(name).values()];
      // nextId scan: SELECT id FROM <table>
      if (/^SELECT id FROM \w+$/i.test(q)) {
        return rows.map((row) => ({ id: row.id })) as unknown as T[];
      }
      // listRows (all): SELECT id, payload, mac FROM <table> ORDER BY seq ASC
      if (/^SELECT id, payload, mac FROM \w+ ORDER BY seq ASC$/i.test(q)) {
        return [...rows]
          .sort((a, b) => a.seq - b.seq)
          .map((row) => ({ id: row.id, payload: row.payload, mac: row.mac })) as unknown as T[];
      }
      // listRows (filtered): SELECT id, payload, mac FROM <table> WHERE <col> = ? ORDER BY seq ASC
      if (/^SELECT id, payload, mac FROM \w+ WHERE \w+ = \? ORDER BY seq ASC$/i.test(q)) {
        const filter = p[0] === undefined || p[0] === null ? null : String(p[0]);
        return [...rows]
          .filter((row) => row.filter === filter)
          .sort((a, b) => a.seq - b.seq)
          .map((row) => ({ id: row.id, payload: row.payload, mac: row.mac })) as unknown as T[];
      }
      throw new Error(`Unsupported all statement: ${q}`);
    },

    close(): void {
      closed = true;
    },
  };

  return driver;
}

// A complete TiDB connection block. With an injected driver the real
// `createTiDBDriver` is never invoked, but passing a realistic `tidb` config
// documents that this is the hosted path and proves the injected driver wins.
const TIDB_CONFIG: PersistenceConfig = {
  driver: "tidb",
  tidb: {
    host: "gateway.tidbcloud.example",
    port: 4000,
    user: "alpha-user",
    password: "not-a-real-password",
    database: "rector",
    tls: true,
  },
};

// A fixed clock so generated timestamps are deterministic across the test.
function fixedClock(): () => string {
  let tick = 0;
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  return () => new Date(base + tick++ * 1000).toISOString();
}

const conversationInput: CreateConversationInput = {
  title: "Pooled migration round-trip",
  workspaceId: "ws-tidb",
  retentionPolicy: "default",
};

describe("TiDB pooled driver + Startup_Migration integration (task 12.5)", () => {
  const drivers = new Set<PooledMysqlDriverDouble>();

  function newDriver(connectionLimit?: number): PooledMysqlDriverDouble {
    const driver = createPooledMysqlDriverDouble({ connectionLimit });
    drivers.add(driver);
    return driver;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    for (const driver of drivers) {
      try {
        driver.close();
      } catch {
        /* already closed */
      }
    }
    drivers.clear();
  });

  // --- Verify/provision sequence (Req 8.4) ---------------------------------

  it("provisions the six entity tables over the injected pooled driver and verifies them", async () => {
    const driver = newDriver();

    const store = await runStartupMigration(TIDB_CONFIG, { driver, now: fixedClock() });

    // The hosted path constructs the TiDB-style SqlRectorStore over the driver.
    expect(store).toBeInstanceOf(SqlRectorStore);

    // Every Startup_Migration table was provisioned by the migrate() DDL...
    const provisioned = driver.provisionedTables();
    for (const table of STARTUP_MIGRATION_TABLES) {
      expect(provisioned).toContain(table);
    }
    // ...and exactly the six entity tables, nothing more.
    expect(provisioned.sort()).toEqual([...STARTUP_MIGRATION_TABLES].sort());

    // The DDL was emitted in the MySQL dialect (JSON payload + VARCHAR ids),
    // proving the mysql-dialect mapping that TiDB Cloud uses (Req 8.1, 8.3).
    expect(driver.ddl).toHaveLength(STARTUP_MIGRATION_TABLES.length);
    for (const statement of driver.ddl) {
      expect(statement).toContain("payload JSON NOT NULL");
      expect(statement).toContain("VARCHAR(255) PRIMARY KEY");
    }
  });

  // --- Connection pooling is exercised (Req 8.1) ---------------------------

  it("multiplexes the migration queries across more than one pooled connection", async () => {
    const driver = newDriver(4);

    await runStartupMigration(TIDB_CONFIG, { driver, now: fixedClock() });

    // The verify/provision sequence issues many queries; a pooled driver spreads
    // them across its connection slots rather than funnelling them through one.
    expect(driver.totalQueries()).toBeGreaterThan(0);
    expect(driver.connectionsUsed()).toBeGreaterThan(1);
  });

  // --- Startup_Migration deadline (Req 8.8) --------------------------------

  it("rejects with PersistenceInitializationError when migration exceeds deadlineMs", async () => {
    const driver = newDriver();
    vi.spyOn(SqlRectorStore.prototype, "listConversations").mockImplementation(
      () => new Promise<never>(() => {}),
    );

    await expect(
      runStartupMigration(TIDB_CONFIG, { driver, deadlineMs: 10, now: fixedClock() }),
    ).rejects.toBeInstanceOf(PersistenceInitializationError);
  });

  // --- Entity write/read after migration (Req 8.4, then 8.1) ---------------

  it("supports an entity write/read round-trip through the migrated store", async () => {
    const driver = newDriver();
    const store: RectorStore = await runStartupMigration(TIDB_CONFIG, {
      driver,
      now: fixedClock(),
    });

    // A write/read across every provisioned table works once migration completes.
    const conversation = await store.createConversation(conversationInput);
    expect(await store.getConversation(conversation.id)).toEqual(conversation);

    const message = await store.createMessage({
      conversationId: conversation.id,
      role: "user",
      content: "hello over the pooled driver",
      status: "complete",
      redactionState: "clean",
    });
    expect(await store.getMessage(message.id)).toEqual(message);

    const run = await store.createRun({
      conversationId: conversation.id,
      userMessageId: message.id,
      status: "queued",
      phase: RUN_PHASES[0],
      route: "CHAT",
      complexity: "low",
      budget: {
        maxUsd: 1,
        maxInputTokens: 1000,
        maxOutputTokens: 1000,
        maxModelCalls: 4,
        maxRuntimeMs: 60_000,
        maxHealingAttempts: 1,
        allowedProviders: ["local"],
        approvalRequiredAboveUsd: 5,
      },
      costEstimate: { usd: 0 },
      tokenEstimate: { input: 0, output: 0 },
      traceId: "trace-tidb-1",
      attempts: 0,
      healingAttempts: 0,
      validationAttempts: 0,
    });
    expect(await store.getRun(run.id)).toEqual(run);

    const event = await store.appendEvent({
      id: "evt-tidb-1",
      runId: run.id,
      type: "RUN_CREATED",
      phase: RUN_PHASES[0],
      payload: { source: "integration" },
      traceId: "trace-tidb-1",
      createdAt: "2026-01-01T00:00:10.000Z",
    });
    expect(await store.getEvent(event.id)).toEqual(event);

    const artifact = await store.createArtifact({
      kind: "report",
      uri: "memory://artifact/1",
      summary: "pooled-driver artifact",
      hash: "deadbeef",
      sizeBytes: 42,
      piiState: "none",
      retentionPolicy: "default",
      metadata: { origin: "test" },
    });
    expect(await store.getArtifact(artifact.id)).toEqual(artifact);

    // The list reads the verify step relies on now return the written entities.
    expect(await store.listConversations()).toEqual([conversation]);
    expect(await store.listMessages(conversation.id)).toEqual([message]);
    expect(await store.listRuns(conversation.id)).toEqual([run]);
    expect(await store.listEvents(run.id)).toEqual([event]);
    expect(await store.listArtifacts("report")).toEqual([artifact]);
  });
});
