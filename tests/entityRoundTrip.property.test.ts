import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  SqlRectorStore,
  type RectorStore,
  type SqlDriver,
  type Artifact,
  type Conversation,
  type CreateArtifactInput,
  type CreateConversationInput,
  type CreateMessageInput,
  type CreateRunInput,
  type Message,
  type Run,
  type RunEvent,
} from "../src/store";
import { RUN_EVENT_TYPES } from "../src/protocol/events";
import { RUN_PHASES } from "../src/protocol/phases";

/**
 * Task 12.4 — TiDB entity write-then-read round-trip property test.
 *
 * Feature: cloud-capable-transition, Property 30: Entity write-then-read round-trip is deep-equal
 * **Validates: Requirements 8.5**
 *
 * For any of the five persisted entity kinds (conversations, messages, runs,
 * run_events, artifacts), writing the entity through the `RectorStore`
 * (`SqlRectorStore`) and then reading it back by its identifier returns an
 * entity deep-equal to the one written (Req 8.5, the TiDB_Store round-trip
 * property).
 *
 * The store is exercised over an injected, hand-written **in-memory `SqlDriver`
 * double** (below) that emulates the `mysql` dialect TiDB speaks — no real
 * database, no cloud account, no network, no `node:sqlite` engine. The double
 * implements exactly the synchronous statement surface `SqlRectorStore` issues
 * (DDL, seq/id scans, INSERT/UPDATE/DELETE, single-row and list reads, and the
 * BEGIN/COMMIT/ROLLBACK transaction used by `commitRunTransition`), so the real
 * persistence path (schema-validated serialize on write, JSON re-parse through
 * the entity `Zod` schema on read) is what proves the round trip — exactly the
 * "injected in-memory driver, hermetic, no real DB" surface Property 30 names.
 */

// ---------------------------------------------------------------------------
// In-memory SqlDriver double (emulates the TiDB `mysql` dialect; no real DB)
// ---------------------------------------------------------------------------

interface StoredRow {
  id: string;
  filter: string | null;
  seq: number;
  payload: unknown;
}

type Table = Map<string, StoredRow>;

/**
 * A minimal synchronous SQL interpreter that recognizes exactly the fixed set
 * of statement shapes `SqlRectorStore` emits. It keeps each table as an ordered
 * `Map<id, row>` in process memory and supports a single-level transaction via
 * a snapshot taken on `BEGIN` and restored on `ROLLBACK`.
 */
function createInMemorySqlDriverDouble(): SqlDriver {
  const tables = new Map<string, Table>();
  let snapshot: Map<string, Table> | undefined;

  const tableOf = (name: string): Table => {
    let table = tables.get(name);
    if (!table) {
      table = new Map<string, StoredRow>();
      tables.set(name, table);
    }
    return table;
  };

  const cloneTables = (source: Map<string, Table>): Map<string, Table> => {
    const copy = new Map<string, Table>();
    for (const [name, table] of source) {
      const tableCopy: Table = new Map();
      for (const [id, row] of table) tableCopy.set(id, { ...row });
      copy.set(name, tableCopy);
    }
    return copy;
  };

  const matchTable = (sql: string, pattern: RegExp): string => {
    const match = pattern.exec(sql);
    if (!match) throw new Error(`In-memory driver double: unrecognized statement: ${sql}`);
    return match[1];
  };

  return {
    dialect: "mysql",

    exec(sql: string): void {
      const trimmed = sql.trim();
      if (/^CREATE TABLE IF NOT EXISTS/i.test(trimmed)) {
        const name = matchTable(trimmed, /CREATE TABLE IF NOT EXISTS (\w+)/i);
        tableOf(name);
        return;
      }
      if (/^BEGIN$/i.test(trimmed)) {
        snapshot = cloneTables(tables);
        return;
      }
      if (/^COMMIT$/i.test(trimmed)) {
        snapshot = undefined;
        return;
      }
      if (/^ROLLBACK$/i.test(trimmed)) {
        if (snapshot) {
          tables.clear();
          for (const [name, table] of snapshot) tables.set(name, table);
          snapshot = undefined;
        }
        return;
      }
      throw new Error(`In-memory driver double: unsupported exec statement: ${sql}`);
    },

    run(sql: string, params: unknown[] = []): void {
      const trimmed = sql.trim();

      if (/^INSERT INTO/i.test(trimmed)) {
        const name = matchTable(trimmed, /INSERT INTO (\w+)/i);
        const [id, filter, seq, payload] = params as [string, string | null, number, unknown];
        tableOf(name).set(id, { id, filter, seq: Number(seq), payload });
        return;
      }

      if (/^UPDATE/i.test(trimmed)) {
        const name = matchTable(trimmed, /UPDATE (\w+)/i);
        // SET {filterColumn} = ?, payload = ? WHERE id = ?  ->  [filter, payload, id]
        const [filter, payload, id] = params as [string | null, unknown, string];
        const row = tableOf(name).get(id);
        if (row) {
          row.filter = filter;
          row.payload = payload;
        }
        return;
      }

      if (/^DELETE FROM/i.test(trimmed)) {
        const name = matchTable(trimmed, /DELETE FROM (\w+)/i);
        const [id] = params as [string];
        tableOf(name).delete(id);
        return;
      }

      throw new Error(`In-memory driver double: unsupported run statement: ${sql}`);
    },

    get<T = unknown>(sql: string, params: unknown[] = []): T | undefined {
      const trimmed = sql.trim();

      // SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM {table}
      if (/COALESCE\(MAX\(seq\)/i.test(trimmed)) {
        const name = matchTable(trimmed, /FROM (\w+)/i);
        let max = 0;
        for (const row of tableOf(name).values()) if (row.seq > max) max = row.seq;
        return { next: max + 1 } as T;
      }

      // SELECT id FROM {table} WHERE id = ?
      if (/^SELECT id FROM/i.test(trimmed) && /WHERE id = \?/i.test(trimmed)) {
        const name = matchTable(trimmed, /FROM (\w+)/i);
        const [id] = params as [string];
        const row = tableOf(name).get(id);
        return row ? ({ id: row.id } as T) : undefined;
      }

      // SELECT payload FROM {table} WHERE id = ?
      if (/^SELECT payload FROM/i.test(trimmed) && /WHERE id = \?/i.test(trimmed)) {
        const name = matchTable(trimmed, /FROM (\w+)/i);
        const [id] = params as [string];
        const row = tableOf(name).get(id);
        return row ? ({ payload: row.payload } as T) : undefined;
      }

      throw new Error(`In-memory driver double: unsupported get statement: ${sql}`);
    },

    all<T = unknown>(sql: string, params: unknown[] = []): T[] {
      const trimmed = sql.trim();

      // SELECT id FROM {table}   (no WHERE) — used by nextId scans
      if (/^SELECT id FROM/i.test(trimmed) && !/WHERE/i.test(trimmed)) {
        const name = matchTable(trimmed, /FROM (\w+)/i);
        return [...tableOf(name).values()].map((row) => ({ id: row.id }) as T);
      }

      // SELECT id, payload FROM {table} [WHERE {col} = ?] ORDER BY seq ASC
      if (/^SELECT id, payload FROM/i.test(trimmed)) {
        const name = matchTable(trimmed, /FROM (\w+)/i);
        let rows = [...tableOf(name).values()];
        if (/WHERE/i.test(trimmed)) {
          const [filter] = params as [string];
          rows = rows.filter((row) => row.filter === filter);
        }
        rows.sort((a, b) => a.seq - b.seq);
        return rows.map((row) => ({ id: row.id, payload: row.payload }) as T);
      }

      throw new Error(`In-memory driver double: unsupported all statement: ${sql}`);
    },

    close(): void {
      tables.clear();
      snapshot = undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

// A deterministic monotonic clock so store-generated timestamps are stable; the
// round-trip equality does not depend on it (the stored payload is canonical),
// but a fixed clock keeps fixtures reproducible.
function fixedClock(): () => string {
  let tick = 0;
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  return () => new Date(base + tick++ * 1000).toISOString();
}

const neString = (maxLength: number) => fc.string({ minLength: 1, maxLength });
const WORKSPACES = ["ws-1", "ws-2", "ws-3"] as const;
const ARTIFACT_KINDS = ["patch", "log", "report"] as const;

const EVENT_BASE = Date.parse("2026-01-01T00:00:00.000Z");
const isoDateArb = fc
  .integer({ min: 0, max: 5_000_000 })
  .map((ms) => new Date(EVENT_BASE + ms).toISOString());

const payloadArb = fc.dictionary(
  fc.string({ minLength: 1, maxLength: 6 }),
  fc.oneof(fc.integer(), fc.boolean(), fc.string({ maxLength: 12 })),
  { maxKeys: 3 }
);

const recordArb = fc.dictionary(
  fc.string({ minLength: 1, maxLength: 6 }),
  fc.oneof(fc.integer({ min: 0, max: 10_000 }), fc.string({ maxLength: 12 })),
  { maxKeys: 3 }
);

const budgetArb = fc.record({
  maxUsd: fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true }),
  maxInputTokens: fc.nat({ max: 100_000 }),
  maxOutputTokens: fc.nat({ max: 100_000 }),
  maxModelCalls: fc.nat({ max: 100 }),
  maxRuntimeMs: fc.nat({ max: 600_000 }),
  maxHealingAttempts: fc.nat({ max: 10 }),
  allowedProviders: fc.array(neString(8), { maxLength: 3 }),
  approvalRequiredAboveUsd: fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true }),
});

const conversationInputArb: fc.Arbitrary<CreateConversationInput> = fc.record({
  title: neString(20),
  workspaceId: fc.constantFrom(...WORKSPACES),
  retentionPolicy: neString(12),
});

const messageSpecArb = fc.record({
  role: neString(8),
  content: fc.string({ maxLength: 40 }),
  status: neString(8),
  redactionState: neString(8),
});

const runSpecArb = fc.record({
  status: neString(8),
  phase: fc.constantFrom(...RUN_PHASES),
  route: neString(8),
  complexity: neString(8),
  budget: budgetArb,
  costEstimate: recordArb,
  tokenEstimate: recordArb,
  traceId: neString(12),
  attempts: fc.nat({ max: 5 }),
  healingAttempts: fc.nat({ max: 5 }),
  validationAttempts: fc.nat({ max: 5 }),
});

const eventSpecArb = fc.record({
  type: fc.constantFrom(...RUN_EVENT_TYPES),
  phase: fc.constantFrom(...RUN_PHASES),
  payload: payloadArb,
  traceId: neString(12),
  createdAt: isoDateArb,
});

const artifactInputArb: fc.Arbitrary<CreateArtifactInput> = fc.record({
  kind: fc.constantFrom(...ARTIFACT_KINDS),
  uri: neString(24),
  summary: fc.string({ maxLength: 40 }),
  hash: neString(24),
  sizeBytes: fc.nat({ max: 1_000_000 }),
  piiState: neString(8),
  retentionPolicy: neString(12),
  metadata: recordArb,
});

// One self-contained scenario: a conversation plus a record of every other
// entity kind bound to it, so a single round-trip exercises all five tables.
const scenarioArb = fc.record({
  conversation: conversationInputArb,
  message: messageSpecArb,
  run: runSpecArb,
  event: eventSpecArb,
  artifact: artifactInputArb,
});

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

describe("entity write-then-read round-trip is deep-equal (Property 30)", () => {
  function buildStore(): { store: RectorStore; driver: SqlDriver } {
    const driver = createInMemorySqlDriverDouble();
    const store = new SqlRectorStore({ driver, now: fixedClock() });
    return { store, driver };
  }

  // Feature: cloud-capable-transition, Property 30: Entity write-then-read round-trip is deep-equal
  it("reads every written entity (conversations, messages, runs, run_events, artifacts) back deep-equal", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const { store, driver } = buildStore();
        try {
          // --- Write each entity kind through the store. ---
          const conversation: Conversation = await store.createConversation(scenario.conversation);

          const messageInput: CreateMessageInput = {
            conversationId: conversation.id,
            role: scenario.message.role,
            content: scenario.message.content,
            status: scenario.message.status,
            redactionState: scenario.message.redactionState,
          };
          const message: Message = await store.createMessage(messageInput);

          const runInput: CreateRunInput = {
            conversationId: conversation.id,
            userMessageId: message.id,
            status: scenario.run.status,
            phase: scenario.run.phase,
            route: scenario.run.route,
            complexity: scenario.run.complexity,
            budget: scenario.run.budget,
            costEstimate: scenario.run.costEstimate,
            tokenEstimate: scenario.run.tokenEstimate,
            traceId: scenario.run.traceId,
            attempts: scenario.run.attempts,
            healingAttempts: scenario.run.healingAttempts,
            validationAttempts: scenario.run.validationAttempts,
          };
          const run: Run = await store.createRun(runInput);

          const event: RunEvent = await store.appendEvent({
            id: "evt-1",
            runId: run.id,
            type: scenario.event.type,
            phase: scenario.event.phase,
            payload: scenario.event.payload,
            traceId: scenario.event.traceId,
            createdAt: scenario.event.createdAt,
          } as RunEvent);

          const artifact: Artifact = await store.createArtifact(scenario.artifact);

          // --- Read each entity back by id: it must be deep-equal (Req 8.5). ---
          expect(await store.getConversation(conversation.id)).toEqual(conversation);
          expect(await store.getMessage(message.id)).toEqual(message);
          expect(await store.getRun(run.id)).toEqual(run);
          expect(await store.getEvent(event.id)).toEqual(event);
          expect(await store.getArtifact(artifact.id)).toEqual(artifact);
        } finally {
          driver.close();
        }
      }),
      { numRuns: 100 }
    );
  });
});
