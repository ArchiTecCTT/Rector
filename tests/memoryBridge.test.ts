import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  resolveActiveMemoryProvider,
  buildMemoryProviderFromRecord,
} from "../src/providers/memoryBridge";
import { createInMemoryMemoryConfigStore, type MemoryConfigStore } from "../src/providers/memoryConfigStore";
import type { MemoryProviderRecord } from "../src/providers/memoryConfig";
import type { SecretStore, SecretStoreResult } from "../src/security/secretStore";
import { Mem0MemoryProvider } from "../src/memory/mem0Adapter";
import { ChromaMemoryProvider } from "../src/memory/chromaMemoryAdapter";
import { LocalMemoryProvider } from "../src/memory/provider";

const FIXED_NOW = () => "2026-06-10T12:00:00.000Z";

function createFakeSecretStore(initial: Record<string, string> = {}): SecretStore {
  const secrets = new Map<string, string>(Object.entries(initial));
  return {
    async setSecret(providerId: string, value: string): Promise<SecretStoreResult<void>> {
      secrets.set(providerId, value);
      return { ok: true, value: undefined };
    },
    async getSecret(providerId: string): Promise<SecretStoreResult<string>> {
      const value = secrets.get(providerId);
      return value === undefined
        ? { ok: false, error: `No secret stored for provider "${providerId}".` }
        : { ok: true, value };
    },
    async hasSecret(providerId: string): Promise<boolean> {
      return secrets.has(providerId);
    },
  };
}

function makeRecord(overrides: Partial<MemoryProviderRecord> = {}): MemoryProviderRecord {
  return {
    id: "mem0:demo",
    kind: "mem0",
    label: "Demo Mem0",
    config: {},
    secretRef: "memory:mem0:demo",
    createdAt: FIXED_NOW(),
    updatedAt: FIXED_NOW(),
    ...overrides,
  };
}

describe("memoryBridge", () => {
  let store: MemoryConfigStore;

  beforeEach(() => {
    store = createInMemoryMemoryConfigStore();
  });

  it("falls back to pure local-inmemory when an external provider secret is missing", async () => {
    const getSecret = vi.fn(async () => ({ ok: false, error: "missing" }));
    const secrets: SecretStore = {
      setSecret: async () => ({ ok: true, value: undefined }),
      getSecret,
      hasSecret: async () => false,
    };

    await store.upsertMemoryProvider(makeRecord({ kind: "mem0", id: "mem0:active" }));
    await store.setActiveMemoryProvider("mem0:active");

    const provider = await resolveActiveMemoryProvider(store, secrets, { now: FIXED_NOW });

    expect(provider).toBeInstanceOf(LocalMemoryProvider);
    expect(provider.kind).toBe("local-inmemory");
    expect(provider.id).toBe("local-inmemory:default");
    expect(getSecret).toHaveBeenCalled();
  });

  it("resolves external mem0 kind when secret is present", async () => {
    const secrets = createFakeSecretStore({ "memory:mem0:demo": "mem0-api-key-secret" });
    await store.upsertMemoryProvider(makeRecord());
    await store.setActiveMemoryProvider("mem0:demo");

    const provider = await resolveActiveMemoryProvider(store, secrets, { now: FIXED_NOW });

    expect(provider).toBeInstanceOf(Mem0MemoryProvider);
    expect(provider.kind).toBe("mem0");
    expect(provider.id).toBe("mem0:demo");
  });

  it("resolves external chroma kind when secret and baseUrl are present", async () => {
    const secrets = createFakeSecretStore({ "memory:chroma:demo": "chroma-token" });
    const rec = makeRecord({
      id: "chroma:demo",
      kind: "chroma",
      label: "Chroma",
      secretRef: "memory:chroma:demo",
      config: { baseUrl: "http://localhost:8000" },
    });
    await store.upsertMemoryProvider(rec);
    await store.setActiveMemoryProvider("chroma:demo");

    const provider = await resolveActiveMemoryProvider(store, secrets, { now: FIXED_NOW });

    expect(provider).toBeInstanceOf(ChromaMemoryProvider);
    expect(provider.kind).toBe("chroma");
  });

  it("falls back to local-inmemory when external adapter construction fails (missing secret)", async () => {
    const secrets = createFakeSecretStore({});
    await store.upsertMemoryProvider(makeRecord());
    await store.setActiveMemoryProvider("mem0:demo");

    const provider = await resolveActiveMemoryProvider(store, secrets, { now: FIXED_NOW });

    expect(provider).toBeInstanceOf(LocalMemoryProvider);
    expect(provider.kind).toBe("local-inmemory");
    expect(provider.id).toBe("local-inmemory:default");
  });

  it("falls back to local-inmemory when chroma config is incomplete", async () => {
    const secrets = createFakeSecretStore({ "memory:chroma:demo": "chroma-token" });
    const rec = makeRecord({
      id: "chroma:demo",
      kind: "chroma",
      secretRef: "memory:chroma:demo",
      config: {},
    });
    await store.upsertMemoryProvider(rec);
    await store.setActiveMemoryProvider("chroma:demo");

    const provider = await resolveActiveMemoryProvider(store, secrets, { now: FIXED_NOW });

    expect(provider).toBeInstanceOf(LocalMemoryProvider);
    expect(provider.kind).toBe("local-inmemory");
  });

  it("buildMemoryProviderFromRecord returns local kinds without secret", () => {
    const rec = makeRecord({ id: "local-inmemory:test", kind: "local-inmemory" });
    const provider = buildMemoryProviderFromRecord(rec, undefined, { now: FIXED_NOW });
    expect(provider).toBeInstanceOf(LocalMemoryProvider);
    expect(provider.id).toBe("local-inmemory:test");
  });
});