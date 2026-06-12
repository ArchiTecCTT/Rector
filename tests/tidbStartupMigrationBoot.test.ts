import { describe, expect, it, vi } from "vitest";

import {
  PersistenceInitializationError,
  STARTUP_MIGRATION_TABLES,
  StoreConfigError,
  runStartupMigration,
  type PersistenceConfig,
  type RectorStore,
  type StartupMigrationOverrides,
} from "../src/store";
import { createMysqlDialectSqliteDriver, fixedNow } from "./support/memoryProviderContract";

async function bootGate(
  persistence: PersistenceConfig | undefined,
  listen: () => void,
  overrides?: StartupMigrationOverrides,
): Promise<RectorStore | undefined> {
  const driver = persistence?.driver;
  if (driver === "sqlite" || driver === "tidb") {
    const store = await runStartupMigration(persistence, overrides);
    listen();
    return store;
  }
  listen();
  return undefined;
}

describe("TiDB startup migration boot hardening", () => {
  it("verifies the memories table with the rest of the startup migration tables", async () => {
    expect(STARTUP_MIGRATION_TABLES).toContain("memories");

    const driver = createMysqlDialectSqliteDriver();
    try {
      const store = await runStartupMigration(
        {
          driver: "tidb",
          tidb: {
            host: "gateway.example",
            port: 4000,
            user: "rector",
            password: "secret",
            database: "rector",
            tls: true,
          },
        },
        { driver, now: fixedNow },
      );

      const created = await store.createMemoryEntry({
        layer: "episodic",
        content: "migrated memory table",
        timestamp: "2026-06-10T12:00:00.000Z",
        tags: ["migration"],
        source: "test",
        metadata: {},
      });
      expect((await store.getMemoryEntry(created.id))?.content).toBe("migrated memory table");
    } finally {
      driver.close();
    }
  });

  it("halts boot before listen on bad TiDB config", async () => {
    const listen = vi.fn();
    await expect(bootGate({ driver: "tidb" }, listen)).rejects.toBeInstanceOf(StoreConfigError);
    expect(listen).not.toHaveBeenCalled();
  });

  it("halts boot before listen on migration timeout and redacts errors", async () => {
    const listen = vi.fn();
    const driver = createMysqlDialectSqliteDriver();
    const allSpy = vi.spyOn(driver, "all").mockImplementation(() => {
      throw new Error("connect timeout password=swordfish");
    });
    try {
      await expect(bootGate({ driver: "sqlite" }, listen, { driver, deadlineMs: 50, now: fixedNow }))
        .rejects.toThrow(PersistenceInitializationError);
      await expect(bootGate({ driver: "sqlite" }, vi.fn(), { driver, deadlineMs: 50, now: fixedNow }))
        .rejects.not.toThrow(/swordfish/);
      expect(listen).not.toHaveBeenCalled();
    } finally {
      allSpy.mockRestore();
      driver.close();
    }
  });

  it("memory driver skips startup migration and still reaches listen", async () => {
    const listen = vi.fn();
    const store = await bootGate({ driver: "memory" }, listen);
    expect(store).toBeUndefined();
    expect(listen).toHaveBeenCalledTimes(1);
  });
});
