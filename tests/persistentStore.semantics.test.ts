import { afterEach, describe, expect, it } from "vitest";
import {
  SqlRectorStore,
  createSqliteDriver,
  type SqlDriver,
} from "../src/store/sqlRectorStore";
import type { CreateRunInput, Run, RunEvent } from "../src/store/schemas";

/**
 * Store-semantics unit tests for `SqlRectorStore` (task 2.5).
 *
 * These are deterministic, example-based tests covering three invariants the store
 * must preserve to match `InMemoryRectorStore`:
 *
 *  1. Duplicate-event-id rejection — both `appendEvent` and `commitRunTransition`
 *     refuse an event id that already exists (Requirement 1.9).
 *  2. Atomic-and-rollback `commitRunTransition` — when the event append fails inside
 *     the transaction, the run update is rolled back so the prior run state and the
 *     event log remain unchanged (Requirement 1.10).
 *  3. Redaction-applied parse error on a corrupt read — the thrown error passes both
 *     the id and the parse detail through `redactString`, so no secret can leak
 *     through the error message (Requirement 1.13).
 *
 * No API key, no network: every test uses an in-memory SQLite database (`:memory:`)
 * or an injected `SqlDriver` double, so nothing is written to disk and there are no
 * temp files to clean up.
 *
 * _Requirements: 1.9, 1.10, 1.13_
 */

// A deterministic monotonic clock so created timestamps are stable across a test.
function fixedClock(): () => string {
  let tick = 0;
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  return () => new Date(base + tick++ * 1000).toISOString();
}

function baseRunInput(conversationId: string, overrides: Partial<CreateRunInput> = {}): CreateRunInput {
  return {
    conversationId,
    userMessageId: "umsg-1",
    status: "running",
    phase: "TRIAGE",
    route: "local",
    complexity: "simple",
    budget: {
      maxUsd: 2,
      maxInputTokens: 10_000,
      maxOutputTokens: 5_000,
      maxModelCalls: 8,
      maxRuntimeMs: 60_000,
      maxHealingAttempts: 2,
      allowedProviders: ["local"],
      approvalRequiredAboveUsd: 1,
    },
    costEstimate: { usd: 0.5 },
    tokenEstimate: { input: 100, output: 200 },
    traceId: "trace-1",
    attempts: 0,
    healingAttempts: 0,
    validationAttempts: 0,
    ...overrides,
  };
}

function buildEvent(id: string, runId: string, overrides: Partial<RunEvent> = {}): RunEvent {
  return {
    id,
    runId,
    type: "PHASE_CHANGED",
    phase: "PLANNING",
    payload: {},
    traceId: "trace-1",
    createdAt: "2026-06-03T00:00:00.000Z",
    ...overrides,
  } as RunEvent;
}

// Create a conversation + run so the store has a run to transition / append events against.
async function seedRun(store: SqlRectorStore): Promise<Run> {
  const conversation = await store.createConversation({
    title: "semantics",
    workspaceId: "ws-1",
    retentionPolicy: "default",
  });
  return store.createRun(baseRunInput(conversation.id, { userMessageId: "umsg-1" }));
}

describe("SqlRectorStore store semantics (task 2.5)", () => {
  const openDrivers = new Set<SqlDriver>();

  function track(driver: SqlDriver): SqlDriver {
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

  // --- 1. Duplicate-event-id rejection (Requirement 1.9) -------------------

  describe("duplicate-event-id rejection", () => {
    it("appendEvent rejects an event id that already exists", async () => {
      const driver = track(createSqliteDriver({ path: ":memory:" }));
      const store = new SqlRectorStore({ driver, now: fixedClock() });
      const run = await seedRun(store);

      await store.appendEvent(buildEvent("evt-dup", run.id));

      await expect(store.appendEvent(buildEvent("evt-dup", run.id, { phase: "EXECUTING" }))).rejects.toThrow(
        /Duplicate event ID: evt-dup/
      );

      // The first event is still the only one persisted (no double-append).
      expect(await store.listEvents(run.id)).toHaveLength(1);
    });

    it("commitRunTransition rejects an event id that already exists", async () => {
      const driver = track(createSqliteDriver({ path: ":memory:" }));
      const store = new SqlRectorStore({ driver, now: fixedClock() });
      const run = await seedRun(store);

      await store.appendEvent(buildEvent("evt-dup", run.id));

      await expect(
        store.commitRunTransition(run.id, { phase: "PLANNING" }, buildEvent("evt-dup", run.id))
      ).rejects.toThrow(/Duplicate event ID: evt-dup/);

      // The rejected transition left the run phase and the event log untouched.
      const reread = await store.getRun(run.id);
      expect(reread?.phase).toBe("TRIAGE");
      expect(await store.listEvents(run.id)).toHaveLength(1);
    });
  });

  // --- 2. Atomic rollback on a failed commitRunTransition (Requirement 1.10) ---

  describe("atomic-and-rollback commitRunTransition", () => {
    // Wrap a real SQLite driver so that the run-event INSERT throws *inside* the
    // transaction, after the run UPDATE has already been issued. This exercises the
    // real BEGIN -> UPDATE -> (failed INSERT) -> ROLLBACK path against SQLite.
    function failingEventInsertDriver(base: SqlDriver): SqlDriver {
      return {
        dialect: base.dialect,
        exec: (sql: string) => base.exec(sql),
        run: (sql: string, params?: unknown[]) => {
          if (/INSERT INTO run_events/i.test(sql)) {
            throw new Error("Injected failure on run_events INSERT");
          }
          return base.run(sql, params);
        },
        get: <T = unknown>(sql: string, params?: unknown[]) => base.get<T>(sql, params),
        all: <T = unknown>(sql: string, params?: unknown[]) => base.all<T>(sql, params),
        close: () => base.close(),
      };
    }

    it("rolls back the run update and leaves the event log unchanged when the event append fails", async () => {
      const base = track(createSqliteDriver({ path: ":memory:" }));
      const store = new SqlRectorStore({ driver: base, now: fixedClock() });

      const run = await seedRun(store);
      const priorEvent = await store.appendEvent(buildEvent("evt-prior", run.id));
      const runBefore = await store.getRun(run.id);
      expect(runBefore?.phase).toBe("TRIAGE");

      // A second store over the SAME connection, but whose run-event INSERT fails.
      const failingStore = new SqlRectorStore({
        driver: failingEventInsertDriver(base),
        now: fixedClock(),
      });

      await expect(
        failingStore.commitRunTransition(
          run.id,
          { phase: "DONE", status: "complete" },
          buildEvent("evt-new", run.id, { type: "RUN_COMPLETED", phase: "DONE" })
        )
      ).rejects.toThrow(/Injected failure on run_events INSERT/);

      // The prior run state is fully unchanged (the UPDATE was rolled back).
      const runAfter = await store.getRun(run.id);
      expect(runAfter).toEqual(runBefore);
      expect(runAfter?.phase).toBe("TRIAGE");
      expect(runAfter?.status).toBe("running");

      // The event log still contains exactly the one prior event — nothing appended.
      const events = await store.listEvents(run.id);
      expect(events).toEqual([priorEvent]);
      expect(await store.getEvent("evt-new")).toBeUndefined();
    });
  });

  // --- 3. Redaction-applied parse error on a corrupt read (Requirement 1.13) ---

  describe("redaction-applied parse error on a corrupt payload", () => {
    // An injected driver double that returns a fixed (corrupt) payload for any read,
    // giving precise control over both the stored payload and the lookup id.
    function corruptReadDriver(payload: unknown): SqlDriver {
      return {
        dialect: "sqlite",
        exec: () => {},
        run: () => {},
        get: <T = unknown>(sql: string) => {
          if (/SELECT payload FROM/i.test(sql)) {
            return { payload } as T;
          }
          return undefined;
        },
        all: <T = unknown>() => [] as T[],
        close: () => {},
      };
    }

    it("redacts a secret embedded in the parse detail (invalid-JSON branch)", async () => {
      // Invalid JSON whose surrounding text contains a redactable secret fragment.
      const secret = "sk-LIVESECRET1234567890";
      const corruptJson = `token=${secret} not valid json`;
      const driver = corruptReadDriver(corruptJson);
      const store = new SqlRectorStore({ driver });

      let caught: unknown;
      try {
        await store.getRun("run-1");
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      const message = (caught as Error).message;
      expect(message).toContain("Corrupt run payload");
      // Redaction was applied to the detail: the secret keyword fragment is gone...
      expect(message).toContain("[REDACTED]");
      expect(message).not.toContain("token=sk-LI");
      // ...and the raw secret never appears.
      expect(message).not.toContain(secret);
    });

    it("redacts a secret embedded in the entity id (schema-violation branch)", async () => {
      // A valid-JSON object that violates the RunSchema, so the safeParse branch runs.
      const driver = corruptReadDriver({ not: "a-valid-run" });
      const store = new SqlRectorStore({ driver });

      // The lookup id itself carries a redactable secret.
      const secret = "sk-LIVESECRET1234567890DEADBEEF";
      const secretId = `token=${secret}`;

      let caught: unknown;
      try {
        await store.getRun(secretId);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      const message = (caught as Error).message;
      expect(message).toContain("Corrupt run payload");
      // The id was passed through redactString: the secret is replaced, not echoed.
      expect(message).toContain("[REDACTED]");
      expect(message).not.toContain(secret);
      expect(message).not.toContain("token=sk-LIVESECRET");
    });
  });
});
