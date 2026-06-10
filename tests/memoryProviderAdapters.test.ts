import { describe, it, expect, beforeEach } from "vitest";

import { Mem0MemoryProvider, type Mem0Client, type Mem0MemoryRecord } from "../src/memory/mem0Adapter";
import { ChromaMemoryProvider, type ChromaClient, type ChromaCollection } from "../src/memory/chromaMemoryAdapter";
import { TiDBMemoryProvider } from "../src/memory/tidbMemoryAdapter";
import { LocalMemoryProvider } from "../src/memory/provider";
import { SqlRectorStore, createSqliteDriver } from "../src/store/sqlRectorStore";
import type { CreateMemoryEntryInput, MemoryEntry } from "../src/store/schemas";

const FIXED_NOW = () => "2026-06-10T12:00:00.000Z";

// ---------------------------------------------------------------------------
// Mem0 mock client
// ---------------------------------------------------------------------------

function createMem0MockClient(): Mem0Client & { store: Map<string, Mem0MemoryRecord> } {
  const store = new Map<string, Mem0MemoryRecord>();
  let seq = 0;

  return {
    store,
    async add(messages, options) {
      seq += 1;
      const id = `mem0-id-${seq}`;
      const record: Mem0MemoryRecord = {
        id,
        memory: messages[0]?.content ?? "",
        metadata: options?.metadata,
        created_at: FIXED_NOW(),
      };
      store.set(id, record);
      return { results: [{ id }] };
    },
    async search(query, options) {
      const results = Array.from(store.values()).filter((r) =>
        (r.memory ?? "").toLowerCase().includes(query.toLowerCase()),
      );
      return { results: results.slice(0, options?.limit ?? 20) };
    },
    async get(id) {
      return store.get(id) ?? null;
    },
    async getAll() {
      return { results: Array.from(store.values()) };
    },
    async update(id, content, options) {
      const current = store.get(id);
      if (!current) return;
      store.set(id, { ...current, memory: content, metadata: options?.metadata ?? current.metadata });
    },
    async delete(id) {
      store.delete(id);
    },
  };
}

// ---------------------------------------------------------------------------
// Chroma mock client
// ---------------------------------------------------------------------------

function createChromaMockClient(): ChromaClient {
  const collections = new Map<string, ChromaCollection>();

  function getCollection(name: string): ChromaCollection {
    let col = collections.get(name);
    if (!col) {
      const docs = new Map<string, { document: string; metadata: Record<string, string | number | boolean> }>();
      col = {
        async add(input) {
          for (let i = 0; i < input.ids.length; i++) {
            docs.set(input.ids[i], {
              document: input.documents[i],
              metadata: input.metadatas?.[i] ?? {},
            });
          }
        },
        async get(input) {
          if (input?.ids) {
            return {
              ids: input.ids.filter((id) => docs.has(id)),
              documents: input.ids.filter((id) => docs.has(id)).map((id) => docs.get(id)!.document),
              metadatas: input.ids.filter((id) => docs.has(id)).map((id) => docs.get(id)!.metadata),
            };
          }
          const ids = Array.from(docs.keys());
          return {
            ids,
            documents: ids.map((id) => docs.get(id)!.document),
            metadatas: ids.map((id) => docs.get(id)!.metadata),
          };
        },
        async query(input) {
          const q = input.queryTexts[0]?.toLowerCase() ?? "";
          const matches = Array.from(docs.entries()).filter(([, v]) => v.document.toLowerCase().includes(q));
          const sliced = matches.slice(0, input.nResults);
          return {
            ids: [sliced.map(([id]) => id)],
            documents: [sliced.map(([, v]) => v.document)],
            metadatas: [sliced.map(([, v]) => v.metadata)],
          };
        },
        async update(input) {
          for (let i = 0; i < input.ids.length; i++) {
            const existing = docs.get(input.ids[i]);
            if (existing) {
              docs.set(input.ids[i], {
                document: input.documents?.[i] ?? existing.document,
                metadata: input.metadatas?.[i] ?? existing.metadata,
              });
            }
          }
        },
        async delete(input) {
          for (const id of input.ids) docs.delete(id);
        },
      };
      collections.set(name, col);
    }
    return col;
  }

  return {
    async getOrCreateCollection(input) {
      return getCollection(input.name);
    },
  };
}

// ---------------------------------------------------------------------------
// Shared CRUD + search + prune suite
// ---------------------------------------------------------------------------

async function exerciseMemoryProvider(provider: {
  createMemoryEntry(i: CreateMemoryEntryInput): Promise<MemoryEntry>;
  getMemoryEntry(id: string): Promise<MemoryEntry | undefined>;
  listMemoryEntries(layer?: "working" | "episodic" | "core"): Promise<MemoryEntry[]>;
  updateMemoryEntry(id: string, p: { content?: string }): Promise<MemoryEntry | undefined>;
  deleteMemoryEntry(id: string): Promise<boolean>;
  searchMemory(q?: string, o?: { layer?: "episodic"; limit?: number }): Promise<MemoryEntry[]>;
  pruneMemory(o?: { targetLayer?: "episodic"; maxEntries?: number }): Promise<{ pruned: number; summarized: number }>;
}) {
  const created = await provider.createMemoryEntry({
    layer: "episodic",
    content: "Remember to redact secrets before LLM calls",
    timestamp: FIXED_NOW(),
    tags: ["security", "note"],
    source: "user-note",
    metadata: { priority: "high" },
  });
  expect(created.id).toBeTruthy();
  expect(created.content).toContain("redact");

  const fetched = await provider.getMemoryEntry(created.id);
  expect(fetched?.id).toBe(created.id);

  const listed = await provider.listMemoryEntries("episodic");
  expect(listed.some((e) => e.id === created.id)).toBe(true);

  const updated = await provider.updateMemoryEntry(created.id, {
    content: "Always redact secrets in outbound paths",
  });
  expect(updated?.content).toContain("outbound");

  const searchResults = await provider.searchMemory("redact", { layer: "episodic", limit: 5 });
  expect(searchResults.length).toBeGreaterThan(0);

  const deleted = await provider.deleteMemoryEntry(created.id);
  expect(deleted).toBe(true);
  expect(await provider.getMemoryEntry(created.id)).toBeUndefined();

  // Prune: seed many low-value entries then prune
  for (let i = 0; i < 5; i++) {
    await provider.createMemoryEntry({
      layer: "episodic",
      content: `low value ${i}`,
      timestamp: "2020-01-01T00:00:00.000Z",
      tags: [],
      source: "system",
      metadata: {},
    });
  }
  await provider.createMemoryEntry({
    layer: "episodic",
    content: "Important user note about architecture",
    timestamp: FIXED_NOW(),
    tags: ["note"],
    source: "user-note",
    metadata: {},
  });

  const pruneResult = await provider.pruneMemory({ targetLayer: "episodic", maxEntries: 2 });
  expect(pruneResult.pruned).toBeGreaterThan(0);
}

describe("Mem0MemoryProvider (mocked client)", () => {
  let mockClient: ReturnType<typeof createMem0MockClient>;

  beforeEach(() => {
    mockClient = createMem0MockClient();
  });

  it("CRUD + search + prune with injectable clientFactory", async () => {
    const provider = new Mem0MemoryProvider({
      id: "mem0:test",
      apiKey: "test-key",
      now: FIXED_NOW,
      clientFactory: () => mockClient,
    });
    await exerciseMemoryProvider(provider);
    expect(mockClient.store.size).toBeGreaterThan(0);
  });

  it("validateConfig rejects empty api key", () => {
    const provider = new Mem0MemoryProvider({
      id: "mem0:test",
      apiKey: "",
      clientFactory: () => mockClient,
    });
    expect(() => provider.validateConfig()).toThrow(/API key/i);
  });
});

describe("ChromaMemoryProvider (mocked client)", () => {
  it("CRUD + search + prune with injectable clientFactory", async () => {
    const mockClient = createChromaMockClient();
    const provider = new ChromaMemoryProvider({
      id: "chroma:test",
      config: { baseUrl: "http://localhost:8000" },
      apiKey: "chroma-key",
      now: FIXED_NOW,
      clientFactory: () => mockClient,
    });
    await exerciseMemoryProvider(provider);
  });

  it("validateConfig requires baseUrl", () => {
    const provider = new ChromaMemoryProvider({
      id: "chroma:test",
      clientFactory: () => createChromaMockClient(),
    });
    expect(() => provider.validateConfig()).toThrow(/baseUrl/i);
  });
});

describe("TiDBMemoryProvider (injected SqlRectorStore delegate)", () => {
  it("CRUD + search + prune via delegate store", async () => {
    const driver = createSqliteDriver({ path: ":memory:" });
    const delegate = new SqlRectorStore({ driver, now: FIXED_NOW });
    const provider = new TiDBMemoryProvider({
      id: "tidb-memory:test",
      delegateStore: delegate,
    });
    await exerciseMemoryProvider(provider);
    driver.close();
  });
});

describe("LocalMemoryProvider baseline (regression guard)", () => {
  it("CRUD + search + prune unchanged", async () => {
    const provider = new LocalMemoryProvider({
      id: "local-inmemory:test",
      kind: "local-inmemory",
      now: FIXED_NOW,
    });
    await exerciseMemoryProvider(provider);
  });
});