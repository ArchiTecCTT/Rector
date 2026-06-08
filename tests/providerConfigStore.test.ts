/**
 * Task 3.2 — Provider_Config_Store unit + property tests
 * (Requirements 11.6, 11.7, 14.2).
 *
 * The Provider_Config_Store persists **non-secret** provider configuration to
 * `.rector/providers.json`. These tests drive the SAME local code path that
 * runs against disk in production, but through an injectable in-memory
 * {@link ProviderConfigFs} double, so every assertion is deterministic with
 * ZERO disk, network, or provider calls.
 *
 * They cover three guarantees from the design's Correctness Properties:
 *
 *   1. Round-trip — `upsertProvider`/`removeProvider`/`setActiveRoute` mutations
 *      persist and read back correctly through the backing.
 *
 *   2. Property 4 (Atomic persistence, Req 11.7) — when an atomic write fails
 *      (the temp-file `writeFile` or the `rename` over the target throws), the
 *      previously persisted state is left fully intact and the mutation reports
 *      a redacted `{ ok: false }` rather than throwing.
 *
 *   3. Property 2 (Config/secret separation, Req 11.6 / 14.2) — no stored record
 *      field ever contains a secret value; secrets are referenced by `secretRef`
 *      only, so the serialized `providers.json` never contains the secret
 *      material.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  emptyProviderConfigState,
  ProviderConfigStateSchema,
  type ProviderConfigRecord,
  type ProviderConfigState,
} from "../src/providers/config";
import {
  createLocalProviderConfigStore,
  createInMemoryProviderConfigStore,
  type DiscoveryCacheInvalidator,
  type ProviderConfigFs,
} from "../src/providers/configStore";

const FILE_PATH = ".rector/providers.json";
const FIXED_TS = "2026-01-01T00:00:00.000Z";

/** Build a minimal, schema-valid non-secret record. */
function makeRecord(overrides: Partial<ProviderConfigRecord> = {}): ProviderConfigRecord {
  return {
    id: "openai-compatible:my-proxy",
    kind: "openai-compatible",
    label: "My Proxy",
    baseUrl: "https://proxy.example.com/v1",
    model: "gpt-4o-mini",
    secretRef: "secret:openai-compatible:my-proxy",
    createdAt: FIXED_TS,
    updatedAt: FIXED_TS,
    ...overrides,
  };
}

/**
 * In-memory {@link ProviderConfigFs} double with per-operation fault injection.
 *
 * Mirrors the local adapter's contract: `readFile` returns `undefined` for an
 * absent file, writes land in a path→contents map, and `rename` moves the temp
 * file over the target. A pending error is consumed (thrown once) the next time
 * the matching operation runs, modelling a transient mid-write/mid-rename fault.
 */
class InMemoryConfigFs implements ProviderConfigFs {
  readonly files = new Map<string, string>();
  failNextWrite: Error | null = null;
  failNextRename: Error | null = null;

  async readFile(path: string): Promise<string | undefined> {
    return this.files.get(path);
  }

  async writeFile(path: string, data: string): Promise<void> {
    if (this.failNextWrite) {
      const error = this.failNextWrite;
      this.failNextWrite = null;
      throw error;
    }
    this.files.set(path, data);
  }

  async rename(fromPath: string, toPath: string): Promise<void> {
    if (this.failNextRename) {
      const error = this.failNextRename;
      this.failNextRename = null;
      throw error;
    }
    const data = this.files.get(fromPath);
    if (data === undefined) throw new Error("ENOENT: temp file missing during rename");
    this.files.set(toPath, data);
    this.files.delete(fromPath);
  }

  async mkdir(_dirPath: string): Promise<void> {
    // No-op: directories are implicit in this in-memory model.
  }
}

function newStore(fsImpl: ProviderConfigFs) {
  return createLocalProviderConfigStore({ filePath: FILE_PATH, fsImpl });
}

describe("Provider_Config_Store — round-trip persistence", () => {
  it("starts from an empty state when no backing file exists", async () => {
    const store = newStore(new InMemoryConfigFs());
    expect(await store.getState()).toEqual(emptyProviderConfigState());
  });

  it("persists an upserted record and reads it back", async () => {
    const fsImpl = new InMemoryConfigFs();
    const store = newStore(fsImpl);
    const record = makeRecord();

    const result = await store.upsertProvider(record);
    expect(result).toEqual({ ok: true, value: record });

    const state = await store.getState();
    expect(state.providers).toEqual([record]);
    // A fresh store over the same backing reads the persisted bytes (restart).
    const reread = await newStore(fsImpl).getState();
    expect(reread.providers).toEqual([record]);
  });

  it("replaces an existing record on upsert by id rather than duplicating", async () => {
    const fsImpl = new InMemoryConfigFs();
    const store = newStore(fsImpl);
    await store.upsertProvider(makeRecord({ label: "First" }));

    const updated = makeRecord({ label: "Second", model: "gpt-4o" });
    await store.upsertProvider(updated);

    const state = await store.getState();
    expect(state.providers).toHaveLength(1);
    expect(state.providers[0]).toEqual(updated);
  });

  it("removes a record and reads back the reduced state", async () => {
    const fsImpl = new InMemoryConfigFs();
    const store = newStore(fsImpl);
    const keep = makeRecord({ id: "together:main", kind: "together" });
    const drop = makeRecord({ id: "openai-compatible:tmp" });
    await store.upsertProvider(keep);
    await store.upsertProvider(drop);

    const result = await store.removeProvider(drop.id);
    expect(result).toEqual({ ok: true, value: undefined });

    const state = await store.getState();
    expect(state.providers).toEqual([keep]);
  });

  it("persists setActiveRoute and clears it with null, pruning a removed provider", async () => {
    const fsImpl = new InMemoryConfigFs();
    const store = newStore(fsImpl);
    const record = makeRecord();
    await store.upsertProvider(record);

    await store.setActiveRoute("flagship", record.id);
    expect((await store.getState()).activeRoutes).toEqual({ flagship: record.id });

    // Clearing a route with null drops just that role.
    await store.setActiveRoute("flagship", null);
    expect((await store.getState()).activeRoutes).toEqual({});

    // Removing a provider prunes it from any active route it served.
    await store.setActiveRoute("slm", record.id);
    await store.removeProvider(record.id);
    const finalState = await store.getState();
    expect(finalState.providers).toEqual([]);
    expect(finalState.activeRoutes).toEqual({});
  });
});

describe("Provider_Config_Store — Property 4: atomic persistence (Req 11.7)", () => {
  it("leaves prior state intact when the temp-file write fails mid-upsert", async () => {
    const fsImpl = new InMemoryConfigFs();
    const store = newStore(fsImpl);
    const original = makeRecord({ id: "together:main", kind: "together" });
    await store.upsertProvider(original);

    const persistedAfterSuccess = fsImpl.files.get(FILE_PATH);
    expect(persistedAfterSuccess).toBeDefined();

    fsImpl.failNextWrite = new Error("EIO: simulated disk failure during write");
    const failed = await store.upsertProvider(makeRecord({ id: "openai-compatible:new" }));

    expect(failed.ok).toBe(false);
    // The target file is byte-for-byte unchanged: no partial/corrupted value.
    expect(fsImpl.files.get(FILE_PATH)).toBe(persistedAfterSuccess);
    // The prior state is still readable and correct.
    expect((await store.getState()).providers).toEqual([original]);
  });

  it("leaves the target untouched when the atomic rename fails", async () => {
    const fsImpl = new InMemoryConfigFs();
    const store = newStore(fsImpl);
    const original = makeRecord({ id: "together:main", kind: "together" });
    await store.upsertProvider(original);

    const persistedAfterSuccess = fsImpl.files.get(FILE_PATH);

    fsImpl.failNextRename = new Error("EXDEV: simulated cross-device rename failure");
    const failed = await store.setActiveRoute("flagship", original.id);

    expect(failed.ok).toBe(false);
    // The half-written temp file never replaced the committed target.
    expect(fsImpl.files.get(FILE_PATH)).toBe(persistedAfterSuccess);
    const state = await store.getState();
    expect(state.providers).toEqual([original]);
    expect(state.activeRoutes).toEqual({});
  });

  it("persists no file at all when the very first write fails", async () => {
    const fsImpl = new InMemoryConfigFs();
    const store = newStore(fsImpl);

    fsImpl.failNextWrite = new Error("ENOSPC: simulated no space left on device");
    const failed = await store.upsertProvider(makeRecord());

    expect(failed.ok).toBe(false);
    expect(fsImpl.files.has(FILE_PATH)).toBe(false);
    expect((await store.getState()).providers).toEqual([]);
  });

  it("returns a redacted error message on a write failure", async () => {
    const fsImpl = new InMemoryConfigFs();
    const store = newStore(fsImpl);

    const secret = "sk-LIVE-DEADBEEF-supersecret";
    fsImpl.failNextWrite = new Error(
      `EIO writing; Authorization: Bearer ${secret} and token=${secret}`,
    );
    const failed = await store.upsertProvider(makeRecord());

    expect(failed.ok).toBe(false);
    if (failed.ok) throw new Error("expected failure");
    expect(failed.error).not.toContain(secret);
    expect(failed.error).toContain("[REDACTED]");
  });
});

describe("Provider_Config_Store — Property 2: config/secret separation (Req 11.6, 14.2)", () => {
  // Arbitraries for non-secret record fields. Each generated record carries a
  // freshly generated secret value that MUST NOT appear anywhere in the store.
  const idArb = fc.string({ minLength: 1, maxLength: 24 }).filter((s) => s.trim().length > 0);
  const labelArb = fc.string({ minLength: 1, maxLength: 24 }).filter((s) => s.trim().length > 0);
  const modelArb = fc.string({ minLength: 1, maxLength: 24 }).filter((s) => s.trim().length > 0);
  // Long, high-entropy secrets so a coincidental substring match is implausible.
  const secretArb = fc.string({ minLength: 24, maxLength: 256 });

  const recordWithSecretArb = fc
    .tuple(idArb, labelArb, modelArb, secretArb)
    .map(([id, label, model, secretValue]) => ({
      // The secret value is what we'll separately hand to the (mock) Secret_Store;
      // it must never be written into the config record's fields.
      secretValue,
      record: makeRecord({
        id,
        label,
        model,
        baseUrl: "https://proxy.example.com/v1",
        // The record references the secret by key only.
        secretRef: `secret:${id}`,
      }),
    }));

  /** Recursively collect every string leaf in a parsed JSON value. */
  function collectStrings(value: unknown, acc: string[]): void {
    if (typeof value === "string") {
      acc.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) collectStrings(item, acc);
    } else if (value && typeof value === "object") {
      for (const item of Object.values(value)) collectStrings(item, acc);
    }
  }

  it("never writes a secret value into the serialized providers.json", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(recordWithSecretArb, {
          minLength: 1,
          maxLength: 5,
          selector: (entry) => entry.record.id,
        }),
        async (entries) => {
          const fsImpl = new InMemoryConfigFs();
          const store = newStore(fsImpl);

          for (const { record } of entries) {
            const result = await store.upsertProvider(record);
            expect(result.ok).toBe(true);
          }
          // Also exercise an active-route selection in the persisted state.
          await store.setActiveRoute("flagship", entries[0].record.id);

          const stored = fsImpl.files.get(FILE_PATH);
          expect(stored).toBeDefined();
          const representation = stored as string;

          // 1) The raw serialized bytes contain no secret value substring.
          for (const { secretValue } of entries) {
            expect(representation.includes(secretValue)).toBe(false);
          }

          // 2) No string leaf in the parsed JSON equals/contains a secret value;
          //    the only secret-derived data present is the `secretRef` key.
          const parsed = JSON.parse(representation) as unknown;
          const leaves: string[] = [];
          collectStrings(parsed, leaves);
          for (const { secretValue } of entries) {
            for (const leaf of leaves) {
              expect(leaf.includes(secretValue)).toBe(false);
            }
          }

          // 3) The persisted shape is a valid, secret-free config state and each
          //    record is referenced by a secretRef only.
          const validated = ProviderConfigStateSchema.parse(parsed) as ProviderConfigState;
          for (const { record } of entries) {
            const persisted = validated.providers.find((p) => p.id === record.id);
            expect(persisted?.secretRef).toBe(record.secretRef);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("Provider_Config_Store — Discovery_Cache invalidation (Req 16.3, task 6.2)", () => {
  /** A trivial Discovery_Cache double recording every `invalidate` call. */
  class RecordingCache implements DiscoveryCacheInvalidator {
    readonly invalidated: string[] = [];
    invalidate(providerId: string): void {
      this.invalidated.push(providerId);
    }
  }

  it("evicts the provider's cache entry on upsertProvider (local store)", async () => {
    const cache = new RecordingCache();
    const store = createLocalProviderConfigStore({
      filePath: FILE_PATH,
      fsImpl: new InMemoryConfigFs(),
      cache,
    });
    const record = makeRecord();

    await store.upsertProvider(record);

    expect(cache.invalidated).toEqual([record.id]);
  });

  it("evicts the provider's cache entry on removeProvider (local store)", async () => {
    const cache = new RecordingCache();
    const fsImpl = new InMemoryConfigFs();
    const store = createLocalProviderConfigStore({ filePath: FILE_PATH, fsImpl, cache });
    const record = makeRecord();
    await store.upsertProvider(record);
    cache.invalidated.length = 0; // ignore the upsert eviction

    await store.removeProvider(record.id);

    expect(cache.invalidated).toEqual([record.id]);
  });

  it("evicts both the previous and the newly designated provider on setActiveRoute", async () => {
    const cache = new RecordingCache();
    const fsImpl = new InMemoryConfigFs();
    const store = createLocalProviderConfigStore({ filePath: FILE_PATH, fsImpl, cache });
    const first = makeRecord({ id: "together:first", kind: "together" });
    const second = makeRecord({ id: "openai-compatible:second" });
    await store.upsertProvider(first);
    await store.upsertProvider(second);

    // Initial designation invalidates only the newly designated provider.
    cache.invalidated.length = 0;
    await store.setActiveRoute("flagship", first.id);
    expect(cache.invalidated).toEqual([first.id]);

    // Re-pointing the role invalidates both the replaced and the new provider.
    cache.invalidated.length = 0;
    await store.setActiveRoute("flagship", second.id);
    expect(cache.invalidated).toEqual([first.id, second.id]);

    // Clearing the role invalidates the provider it had been pointing at.
    cache.invalidated.length = 0;
    await store.setActiveRoute("flagship", null);
    expect(cache.invalidated).toEqual([second.id]);
  });

  it("does not invalidate when an atomic write fails (no eviction on a no-op)", async () => {
    const cache = new RecordingCache();
    const fsImpl = new InMemoryConfigFs();
    const store = createLocalProviderConfigStore({ filePath: FILE_PATH, fsImpl, cache });

    fsImpl.failNextWrite = new Error("EIO: simulated disk failure during write");
    const failed = await store.upsertProvider(makeRecord());

    expect(failed.ok).toBe(false);
    // The mutation never committed, so nothing was evicted.
    expect(cache.invalidated).toEqual([]);
  });

  it("evicts on every mutation of the in-memory store too", async () => {
    const cache = new RecordingCache();
    const store = createInMemoryProviderConfigStore(undefined, { cache });
    const record = makeRecord();

    await store.upsertProvider(record);
    await store.setActiveRoute("slm", record.id);
    await store.removeProvider(record.id);

    expect(cache.invalidated).toEqual([record.id, record.id, record.id]);
  });

  it("remains fully backward compatible when no cache is injected", async () => {
    const store = createLocalProviderConfigStore({
      filePath: FILE_PATH,
      fsImpl: new InMemoryConfigFs(),
    });
    const record = makeRecord();

    // The mutations behave exactly as before; no cache, no throw.
    expect((await store.upsertProvider(record)).ok).toBe(true);
    expect((await store.setActiveRoute("flagship", record.id)).ok).toBe(true);
    expect((await store.removeProvider(record.id)).ok).toBe(true);
  });
});
