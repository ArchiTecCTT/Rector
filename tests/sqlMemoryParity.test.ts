import { afterEach, describe, expect, it } from "vitest";

import { InMemoryRectorStore, SqlRectorStore, createSqliteDriver, type RectorStore, type SqlDriver } from "../src/store";
import type { CreateMemoryEntryInput, MemoryEntry } from "../src/store";
import { createMysqlDialectSqliteDriver, fixedNow } from "./support/memoryProviderContract";

const OLD_TS = "2020-01-01T00:00:00.000Z";

function memoryInputs(): CreateMemoryEntryInput[] {
  return [
    {
      layer: "episodic",
      content: "Remember token=sk-1234567890SECRET before providers",
      timestamp: OLD_TS,
      tags: ["security"],
      source: "system",
      metadata: { apiKey: "sk-1234567890SECRET", priority: "low" },
    },
    {
      layer: "episodic",
      content: "Important user-note architecture memory",
      timestamp: "2026-06-10T12:00:00.000Z",
      tags: ["note", "architecture"],
      source: "user-note",
      metadata: { priority: "high" },
      accessCount: 5,
    },
    {
      layer: "core",
      content: "Core planner truth",
      timestamp: "2026-06-10T12:00:00.000Z",
      tags: ["planner"],
      source: "ponder",
      metadata: {},
    },
  ];
}

function stripGenerated(entry: MemoryEntry): Omit<MemoryEntry, "id"> {
  // Store ids intentionally differ by backend construction path; advanced-memory
  // parity is about fields, filters, search/prune semantics, and redaction.
  const { id: _id, ...rest } = entry;
  return rest;
}

async function seed(store: RectorStore): Promise<MemoryEntry[]> {
  const created: MemoryEntry[] = [];
  for (const input of memoryInputs()) created.push(await store.createMemoryEntry(input));
  return created;
}

describe("SQL/TiDB advanced memory parity", () => {
  const openDrivers = new Set<SqlDriver>();

  afterEach(() => {
    for (const driver of openDrivers) driver.close();
    openDrivers.clear();
  });

  function sqliteStore(): SqlRectorStore {
    const driver = createSqliteDriver({ path: ":memory:" });
    openDrivers.add(driver);
    return new SqlRectorStore({ driver, now: fixedNow });
  }

  function mysqlDialectStore(): SqlRectorStore {
    const driver = createMysqlDialectSqliteDriver();
    openDrivers.add(driver);
    return new SqlRectorStore({ driver, now: fixedNow });
  }

  it.each([
    ["in-memory", () => new InMemoryRectorStore({ now: fixedNow }) as RectorStore],
    ["sql", () => sqliteStore() as RectorStore],
    ["tidb-driver-double", () => mysqlDialectStore() as RectorStore],
  ])("supports the full advanced memory CRUD/search/prune surface for %s", async (_name, makeStore) => {
    const store = makeStore();
    const created = await seed(store);

    expect(created[0]?.content).toContain("[REDACTED]");
    expect(created[0]?.metadata.apiKey).toBe("[REDACTED]");

    const fetched = await store.getMemoryEntry(created[1]!.id);
    expect(fetched).toEqual(created[1]);

    const episodic = await store.listMemoryEntries("episodic");
    expect(episodic.map((entry) => entry.layer)).toEqual(["episodic", "episodic"]);

    const updated = await store.updateMemoryEntry(created[0]!.id, {
      content: "Updated password=swordfish content",
      metadata: { password: "swordfish", priority: "medium" },
    });
    expect(updated?.content).toContain("password=[REDACTED]");
    expect(updated?.metadata.password).toBe("[REDACTED]");

    const searchResults = await store.searchMemory("architecture", { layer: "episodic", limit: 1 });
    expect(searchResults).toHaveLength(1);
    expect(searchResults[0]?.id).toBe(created[1]?.id);

    const prune = await store.pruneMemory({ targetLayer: "episodic", maxEntries: 1 });
    expect(prune.pruned).toBe(1);
    expect(prune.summarized).toBe(0);
    expect((await store.listMemoryEntries("episodic")).map((entry) => entry.id)).toEqual([created[1]?.id]);

    expect(await store.deleteMemoryEntry(created[2]!.id)).toBe(true);
    expect(await store.getMemoryEntry(created[2]!.id)).toBeUndefined();
  });

  it("matches in-memory field semantics for SQL and TiDB driver doubles", async () => {
    const stores = [new InMemoryRectorStore({ now: fixedNow }), sqliteStore(), mysqlDialectStore()];
    const snapshots: Array<Array<Omit<MemoryEntry, "id">>> = [];

    for (const store of stores) {
      await seed(store);
      snapshots.push((await store.searchMemory("memory", { limit: 10 })).map(stripGenerated));
    }

    expect(snapshots[1]).toEqual(snapshots[0]);
    expect(snapshots[2]).toEqual(snapshots[0]);
  });
});
