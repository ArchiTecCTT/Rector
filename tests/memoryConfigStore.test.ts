import { describe, it, expect, beforeEach } from "vitest";
import {
  createInMemoryMemoryConfigStore,
  type MemoryConfigStore,
} from "../src/providers/memoryConfigStore";
import {
  MemoryProviderKindSchema,
  type MemoryProviderRecord,
} from "../src/providers/memoryConfig";

/**
 * Basic smoke tests for the Memory Config Store (Chunk 34).
 * Mirrors the structure and spirit of providerConfigStore.test.ts but for memory providers.
 * These run fast (in-memory double) and exercise the non-secret persistence + active selection.
 */

function makeRecord(overrides: Partial<MemoryProviderRecord> = {}): MemoryProviderRecord {
  const now = new Date().toISOString();
  return {
    id: "local-inmemory:test",
    kind: "local-inmemory",
    label: "Test Local",
    config: {},
    secretRef: "memory:test",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("MemoryConfigStore (in-memory)", () => {
  let store: MemoryConfigStore;

  beforeEach(() => {
    store = createInMemoryMemoryConfigStore();
  });

  it("starts empty with no active provider", async () => {
    const state = await store.getState();
    expect(state.providers).toEqual([]);
    expect(state.activeMemoryProviderId).toBeUndefined();
  });

  it("upsert + get roundtrips a record and preserves active when set", async () => {
    const rec = makeRecord({ id: "mem0:demo", kind: "mem0", label: "Demo Mem0" });
    const res = await store.upsertMemoryProvider(rec);
    expect(res.ok).toBe(true);

    const state = await store.getState();
    expect(state.providers.length).toBe(1);
    expect(state.providers[0].id).toBe("mem0:demo");

    await store.setActiveMemoryProvider("mem0:demo");
    const state2 = await store.getState();
    expect(state2.activeMemoryProviderId).toBe("mem0:demo");
  });

  it("remove clears the record and unsets it if it was active", async () => {
    const rec = makeRecord({ id: "local-sqlite-mem:local", kind: "local-sqlite-mem" });
    await store.upsertMemoryProvider(rec);
    await store.setActiveMemoryProvider(rec.id);

    const rem = await store.removeMemoryProvider(rec.id);
    expect(rem.ok).toBe(true);

    const state = await store.getState();
    expect(state.providers.find((p) => p.id === rec.id)).toBeUndefined();
    expect(state.activeMemoryProviderId).toBeUndefined();
  });

  it("kind schema accepts the v1 kinds", () => {
    expect(MemoryProviderKindSchema.parse("local-inmemory")).toBe("local-inmemory");
    expect(MemoryProviderKindSchema.parse("mem0")).toBe("mem0");
    expect(() => MemoryProviderKindSchema.parse("weird")).toThrow();
  });
});
