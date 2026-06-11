/**
 * Chunk 035 Phase 1 — Boot-time Startup_Migration wiring tests.
 *
 * Exercises the seams `src/bin/server.ts` and `src/api/server.ts` wire together
 * without importing the side-effectful server entrypoint (which calls
 * `bootstrap()` and `process.exit` at module load).
 *
 * Hermetic: in-memory SqlDriver doubles, no network, no disk.
 */
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/api/server";
import { createInMemoryMemoryConfigStore } from "../src/providers/memoryConfigStore";
import type { PersistenceConfig } from "../src/store";
import * as storeModule from "../src/store";
import {
  PersistenceInitializationError,
  SqlRectorStore,
  createSqliteDriver,
  runStartupMigration,
  type RectorStore,
  type SqlDriver,
} from "../src/store";
import { TaskManager } from "../src/thalamus/router";

/** Mirrors the boot migration gate in `src/bin/server.ts`. */
async function resolveBootstrappedStore(
  persistence?: PersistenceConfig,
  overrides?: storeModule.StartupMigrationOverrides,
): Promise<RectorStore | undefined> {
  const driver = persistence?.driver;
  if (driver === "sqlite" || driver === "tidb") {
    return runStartupMigration(persistence, overrides);
  }
  return undefined;
}

function recordingSqliteDriver(): SqlDriver & { ddl: string[] } {
  const ddl: string[] = [];
  return {
    dialect: "sqlite",
    ddl,
    exec(sql: string): void {
      ddl.push(sql.replace(/\s+/g, " ").trim());
    },
    run(): void {},
    get(): undefined {
      return undefined;
    },
    all(): [] {
      return [];
    },
    close(): void {},
  };
}

function fixedClock(): () => string {
  let tick = 0;
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  return () => new Date(base + tick++ * 1000).toISOString();
}

describe("boot migration gate (src/bin/server.ts seam)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs Startup_Migration for sqlite and tidb drivers", async () => {
    const migrationSpy = vi.spyOn(storeModule, "runStartupMigration");
    const driver = recordingSqliteDriver();

    const sqliteStore = await resolveBootstrappedStore({ driver: "sqlite" }, { driver, now: fixedClock() });
    expect(sqliteStore).toBeInstanceOf(SqlRectorStore);
    expect(migrationSpy).toHaveBeenCalledTimes(1);

    migrationSpy.mockClear();
    const tidbStore = await resolveBootstrappedStore(
      {
        driver: "tidb",
        tidb: {
          host: "gateway.example",
          port: 4000,
          user: "user",
          password: "secret",
          database: "rector",
          tls: true,
        },
      },
      { driver, now: fixedClock() },
    );
    expect(tidbStore).toBeInstanceOf(SqlRectorStore);
    expect(migrationSpy).toHaveBeenCalledTimes(1);
  });

  it("skips Startup_Migration for memory and absent persistence", async () => {
    const migrationSpy = vi.spyOn(storeModule, "runStartupMigration");

    expect(await resolveBootstrappedStore({ driver: "memory" })).toBeUndefined();
    expect(await resolveBootstrappedStore(undefined)).toBeUndefined();
    expect(migrationSpy).not.toHaveBeenCalled();
  });
});

describe("createApp store injection (src/api/server.ts seam)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the injected boot-time store and skips createRectorStore", async () => {
    const createSpy = vi.spyOn(storeModule, "createRectorStore");
    const injected = await runStartupMigration(
      { driver: "sqlite" },
      { driver: createSqliteDriver({ path: ":memory:" }), now: fixedClock() },
    );

    await injected.createConversation({
      title: "Boot-injected conversation",
      workspaceId: "boot-ws",
      retentionPolicy: "default",
    });

    const app = createApp(new TaskManager(), {
      store: injected,
      persistence: { driver: "sqlite" },
    });

    expect(createSpy).not.toHaveBeenCalled();

    await new Promise<void>((resolve, reject) => {
      const server = app.listen(0, async () => {
        try {
          const addr = server.address();
          const port = typeof addr === "object" && addr ? addr.port : 3000;
          const res = await fetch(`http://127.0.0.1:${port}/api/chat/conversations`);
          const data = (await res.json()) as { conversations: Array<{ title: string }> };
          expect(res.status).toBe(200);
          expect(data.conversations.some((c) => c.title === "Boot-injected conversation")).toBe(true);
          server.close((err) => (err ? reject(err) : resolve()));
        } catch (error) {
          server.close(() => reject(error));
        }
      });
    });
  });

  it("passes the sql-backed store as the local-sqlite-mem delegate", async () => {
    const injected = await runStartupMigration(
      { driver: "sqlite" },
      { driver: createSqliteDriver({ path: ":memory:" }), now: fixedClock() },
    );
    const memoryConfigStore = createInMemoryMemoryConfigStore();
    const now = "2026-06-10T12:00:00.000Z";

    await memoryConfigStore.upsertMemoryProvider({
      id: "local-sqlite-mem:boot",
      kind: "local-sqlite-mem",
      label: "Local SQLite memory",
      config: {},
      secretRef: "memory:local-sqlite-mem",
      createdAt: now,
      updatedAt: now,
    });
    await memoryConfigStore.setActiveMemoryProvider("local-sqlite-mem:boot");

    const app = createApp(new TaskManager(), {
      store: injected,
      persistence: { driver: "sqlite" },
      memoryConfigStore,
      secretStore: {
        async setSecret() {
          return { ok: true, value: undefined };
        },
        async getSecret() {
          return { ok: false, error: "not configured" };
        },
        async hasSecret() {
          return false;
        },
        async deleteSecret() {
          return { ok: true, value: undefined };
        },
      },
      orchestration: { mode: "external" },
    });

    await new Promise<void>((resolve, reject) => {
      const server: http.Server = app.listen(0, async () => {
        try {
          const addr = server.address();
          const port = typeof addr === "object" && addr ? addr.port : 3000;
          const base = `http://127.0.0.1:${port}`;

          const created = await fetch(`${base}/api/notes`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: "sqlite-backed note" }),
          });
          expect(created.status).toBe(201);

          const entries = await injected.listMemoryEntries("episodic");
          expect(entries).toHaveLength(1);
          expect(entries[0]?.content).toBe("sqlite-backed note");

          server.close((err) => (err ? reject(err) : resolve()));
        } catch (error) {
          server.close(() => reject(error));
        }
      });
    });
  });
});

describe("boot migration failure handling (src/bin/server.ts seam)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("surfaces PersistenceInitializationError from runStartupMigration unchanged", async () => {
    vi.spyOn(SqlRectorStore.prototype, "listConversations").mockImplementation(
      () => new Promise<never>(() => {}),
    );

    await expect(
      resolveBootstrappedStore(
        { driver: "sqlite" },
        { driver: createSqliteDriver({ path: ":memory:" }), deadlineMs: 10, now: fixedClock() },
      ),
    ).rejects.toBeInstanceOf(PersistenceInitializationError);
  });
});