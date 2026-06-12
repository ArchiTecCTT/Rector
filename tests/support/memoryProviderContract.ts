import { expect, it, vi } from "vitest";

import type { Mem0Client, Mem0MemoryRecord } from "../../src/memory/mem0Adapter";
import type { ChromaClient, ChromaCollection, ChromaQueryResult } from "../../src/memory/chromaMemoryAdapter";
import type { MemoryProvider } from "../../src/memory/provider";
import { createSqliteDriver, type SqlDriver } from "../../src/store";

export const FIXED_NOW = "2026-06-10T12:00:00.000Z";
export const fixedNow = () => FIXED_NOW;

export function createMysqlDialectSqliteDriver(): SqlDriver {
  const sqlite = createSqliteDriver({ path: ":memory:" });
  return {
    dialect: "mysql",
    exec: (sql) => sqlite.exec(sql),
    run: (sql, params) => sqlite.run(sql, params),
    get: (sql, params) => sqlite.get(sql, params),
    all: (sql, params) => sqlite.all(sql, params),
    close: () => sqlite.close(),
  };
}

export type FakeMem0Client = Mem0Client & {
  store: Map<string, Mem0MemoryRecord>;
  calls: Array<{ op: string; payload: unknown }>;
};

export function createFakeMem0Client(options: { addShape?: "id" | "results" | "array" | "wrapped" } = {}): FakeMem0Client {
  const store = new Map<string, Mem0MemoryRecord>();
  const calls: Array<{ op: string; payload: unknown }> = [];
  let seq = 0;
  const addShape = options.addShape ?? "results";

  const client: FakeMem0Client = {
    store,
    calls,
    async add(messages, requestOptions) {
      calls.push({ op: "add", payload: { messages, requestOptions } });
      seq += 1;
      const id = `mem0-id-${seq}`;
      const record: Mem0MemoryRecord = {
        id,
        memory: messages[0]?.content ?? "",
        metadata: requestOptions?.metadata,
        created_at: FIXED_NOW,
        updated_at: FIXED_NOW,
      };
      store.set(id, record);
      if (addShape === "id") return { id };
      if (addShape === "array") return [record];
      if (addShape === "wrapped") return { results: [{ memory: record } as unknown as Mem0MemoryRecord] };
      return { results: [record] };
    },
    async search(query, requestOptions) {
      calls.push({ op: "search", payload: { query, requestOptions } });
      const results = Array.from(store.values()).filter((record) =>
        (record.memory ?? record.content ?? "").toLowerCase().includes(query.toLowerCase()),
      );
      return { results: results.slice(0, requestOptions?.limit ?? 20) };
    },
    async get(id) {
      calls.push({ op: "get", payload: { id } });
      return store.get(id) ?? null;
    },
    async getAll(options) {
      calls.push({ op: "getAll", payload: { options } });
      return { results: Array.from(store.values()) };
    },
    async update(id, content, options) {
      calls.push({ op: "update", payload: { id, content, options } });
      const current = store.get(id);
      if (!current) return;
      store.set(id, { ...current, memory: content, metadata: options?.metadata ?? current.metadata, updated_at: FIXED_NOW });
    },
    async delete(id) {
      calls.push({ op: "delete", payload: { id } });
      store.delete(id);
    },
  };

  return client;
}

export type FakeChromaClient = ChromaClient & {
  collections: Map<string, ChromaCollection>;
  calls: Array<{ op: string; payload: unknown }>;
};

type FakeChromaMetadata = Record<string, string | number | boolean>;
type FakeChromaDocument = { document: string; metadata: FakeChromaMetadata };
type FakeChromaDocumentStore = Map<string, FakeChromaDocument>;
type FakeChromaCalls = Array<{ op: string; payload: unknown }>;

function metadataMatches(metadata: FakeChromaMetadata, where?: Record<string, unknown>): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, value]) => metadata[key] === value);
}

function getOrCreateFakeChromaCollection(
  collections: Map<string, ChromaCollection>,
  calls: FakeChromaCalls,
  name: string,
): ChromaCollection {
  const existing = collections.get(name);
  if (existing) return existing;

  const collection = createFakeChromaCollectionInstance(calls);
  collections.set(name, collection);
  return collection;
}

function createFakeChromaCollectionInstance(calls: FakeChromaCalls): ChromaCollection {
  const docs: FakeChromaDocumentStore = new Map();
  return {
    async add(input) {
      calls.push({ op: "add", payload: input });
      addFakeChromaDocuments(docs, input.ids, input.documents, input.metadatas);
    },
    async get(input) {
      calls.push({ op: "get", payload: input });
      return getFakeChromaDocuments(docs, input?.ids, input?.where);
    },
    async query(input) {
      calls.push({ op: "query", payload: input });
      return queryFakeChromaDocuments(docs, input.queryTexts[0], input.nResults, input.where);
    },
    async update(input) {
      calls.push({ op: "update", payload: input });
      updateFakeChromaDocuments(docs, input.ids, input.documents, input.metadatas);
    },
    async delete(input) {
      calls.push({ op: "delete", payload: input });
      deleteFakeChromaDocuments(docs, input.ids);
    },
  };
}

function addFakeChromaDocuments(
  docs: FakeChromaDocumentStore,
  ids: readonly string[],
  documents: readonly string[],
  metadatas: readonly FakeChromaMetadata[] | undefined,
): void {
  for (let i = 0; i < ids.length; i++) {
    docs.set(ids[i], {
      document: documents[i],
      metadata: metadatas?.[i] ?? {},
    });
  }
}

function getFakeChromaDocuments(
  docs: FakeChromaDocumentStore,
  requestedIds?: readonly string[],
  where?: Record<string, unknown>,
): Awaited<ReturnType<ChromaCollection["get"]>> {
  const ids = (requestedIds ?? Array.from(docs.keys())).filter((id) => {
    const row = docs.get(id);
    return row !== undefined && metadataMatches(row.metadata, where);
  });
  return {
    ids,
    documents: ids.map((id) => docs.get(id)?.document ?? null),
    metadatas: ids.map((id) => docs.get(id)?.metadata ?? null),
  };
}

function queryFakeChromaDocuments(
  docs: FakeChromaDocumentStore,
  queryText: string | undefined,
  nResults: number,
  where?: Record<string, unknown>,
): ChromaQueryResult {
  const query = queryText?.toLowerCase() ?? "";
  const matches = Array.from(docs.entries())
    .filter(([, row]) => row.document.toLowerCase().includes(query) && metadataMatches(row.metadata, where))
    .map(([id, row], index) => ({ id, row, distance: index / 10 }));
  const sliced = matches.slice(0, nResults);
  return {
    ids: [sliced.map((match) => match.id)],
    documents: [sliced.map((match) => match.row.document)],
    metadatas: [sliced.map((match) => match.row.metadata)],
    distances: [sliced.map((match) => match.distance)],
  };
}

function updateFakeChromaDocuments(
  docs: FakeChromaDocumentStore,
  ids: readonly string[],
  documents: readonly string[] | undefined,
  metadatas: readonly FakeChromaMetadata[] | undefined,
): void {
  for (let i = 0; i < ids.length; i++) {
    const existing = docs.get(ids[i]);
    if (!existing) continue;
    docs.set(ids[i], {
      document: documents?.[i] ?? existing.document,
      metadata: metadatas?.[i] ?? existing.metadata,
    });
  }
}

function deleteFakeChromaDocuments(docs: FakeChromaDocumentStore, ids: readonly string[]): void {
  for (const id of ids) docs.delete(id);
}

export function createFakeChromaClient(): FakeChromaClient {
  const collections = new Map<string, ChromaCollection>();
  const calls: FakeChromaCalls = [];

  return {
    collections,
    calls,
    async getOrCreateCollection(input) {
      calls.push({ op: "getOrCreateCollection", payload: input });
      return getOrCreateFakeChromaCollection(collections, calls, input.name);
    },
  };
}

export function runMemoryProviderContractSuite(
  makeProvider: () => MemoryProvider | Promise<MemoryProvider>,
  options: { close?: () => void; localNoNetwork?: boolean } = {},
): void {
  it("round-trips create/get/list/update/delete with metadata and redaction", async () => {
    const fetchSpy = options.localNoNetwork
      ? vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network disabled"))
      : undefined;
    try {
      const provider = await makeProvider();
      const created = await provider.createMemoryEntry({
        layer: "episodic",
        content: "Remember token=sk-1234567890SECRET before outbound calls",
        timestamp: FIXED_NOW,
        tags: ["security", "note"],
        source: "user-note",
        metadata: { priority: "high", apiKey: "sk-1234567890SECRET" },
      });

      expect(created.id).toBeTruthy();
      expect(created.content).toContain("[REDACTED]");
      expect(created.content).not.toContain("sk-1234567890SECRET");
      expect(created.metadata.priority).toBe("high");
      expect(created.metadata.apiKey).toBe("[REDACTED]");

      const fetched = await provider.getMemoryEntry(created.id);
      expect(fetched?.id).toBe(created.id);
      expect(fetched?.metadata.priority).toBe("high");

      const listed = await provider.listMemoryEntries("episodic");
      expect(listed.some((entry) => entry.id === created.id)).toBe(true);

      const updated = await provider.updateMemoryEntry(created.id, {
        content: "Always redact password=swordfish in memory updates",
        metadata: { priority: "critical", password: "swordfish" },
      });
      expect(updated?.content).toContain("password=[REDACTED]");
      expect(updated?.metadata.password).toBe("[REDACTED]");

      const searchResults = await provider.searchMemory("redact", { layer: "episodic", limit: 5 });
      expect(searchResults.some((entry) => entry.id === created.id)).toBe(true);

      expect(await provider.deleteMemoryEntry(created.id)).toBe(true);
      expect(await provider.getMemoryEntry(created.id)).toBeUndefined();
      if (fetchSpy) expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy?.mockRestore();
      options.close?.();
    }
  });

  it("searches by content/query/layer and enforces result limit", async () => {
    try {
      const provider = await makeProvider();
      await provider.createMemoryEntry({
        layer: "episodic",
        content: "alpha episodic item one",
        timestamp: FIXED_NOW,
        tags: ["alpha"],
        source: "run",
        metadata: {},
      });
      await provider.createMemoryEntry({
        layer: "core",
        content: "alpha core item two",
        timestamp: FIXED_NOW,
        tags: ["alpha"],
        source: "ponder",
        metadata: {},
      });

      const episodic = await provider.searchMemory("alpha", { layer: "episodic", limit: 1 });
      expect(episodic).toHaveLength(1);
      expect(episodic[0]?.layer).toBe("episodic");
    } finally {
      options.close?.();
    }
  });

  it("prunes deterministically with the injected clock", async () => {
    try {
      const provider = await makeProvider();
      for (let i = 0; i < 4; i++) {
        await provider.createMemoryEntry({
          layer: "episodic",
          content: `old low value ${i}`,
          timestamp: "2020-01-01T00:00:00.000Z",
          tags: [],
          source: "system",
          metadata: {},
        });
      }
      const keeper = await provider.createMemoryEntry({
        layer: "episodic",
        content: "Important user-note memory survives pruning",
        timestamp: FIXED_NOW,
        tags: ["note"],
        source: "user-note",
        metadata: {},
        accessCount: 5,
      });

      const result = await provider.pruneMemory({ targetLayer: "episodic", maxEntries: 1 });
      expect(result.pruned).toBe(4);
      const remaining = await provider.listMemoryEntries("episodic");
      expect(remaining.map((entry) => entry.id)).toEqual([keeper.id]);
    } finally {
      options.close?.();
    }
  });
}
