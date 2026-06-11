/**
 * Chunk 36 stretch — unit tests for runMemoryProviderConnectionTest.
 *
 * Pure, injectable doubles: no network, no disk, no real adapters.
 */
import { describe, it, expect } from "vitest";

import { runMemoryProviderConnectionTest } from "../src/api/server";
import type { MemoryProvider } from "../src/memory/provider";
import { LocalMemoryProvider } from "../src/memory/provider";

function stubProvider(input: {
  id: string;
  kind: string;
  validateConfig?: () => void;
}): MemoryProvider {
  return {
    id: input.id,
    kind: input.kind,
    metadata: { id: input.id, kind: input.kind },
    validateConfig: input.validateConfig,
    createMemoryEntry: async () => {
      throw new Error("not used");
    },
    getMemoryEntry: async () => undefined,
    listMemoryEntries: async () => [],
    updateMemoryEntry: async () => undefined,
    deleteMemoryEntry: async () => false,
    searchMemory: async () => [],
    pruneMemory: async () => ({ pruned: 0, summarized: 0 }),
  };
}

describe("runMemoryProviderConnectionTest", () => {
  it("always succeeds for local-inmemory without network", () => {
    const provider = new LocalMemoryProvider({
      id: "local-inmemory:default",
      kind: "local-inmemory",
      label: "Local",
    });

    const result = runMemoryProviderConnectionTest({
      providerId: provider.id,
      provider,
      kind: provider.kind,
    });

    expect(result).toEqual({
      ok: true,
      providerId: "local-inmemory:default",
      kind: "local-inmemory",
      networkAttempted: false,
    });
  });

  it("always succeeds for local-sqlite-mem without network", () => {
    const provider = new LocalMemoryProvider({
      id: "local-sqlite-mem:main",
      kind: "local-sqlite-mem",
      label: "SQLite",
    });

    const result = runMemoryProviderConnectionTest({
      providerId: provider.id,
      provider,
      kind: provider.kind,
    });

    expect(result.ok).toBe(true);
    expect(result.networkAttempted).toBe(false);
  });

  it("succeeds when external provider validateConfig passes", () => {
    const provider = stubProvider({
      id: "mem0:main",
      kind: "mem0",
      validateConfig: () => {
        /* ok */
      },
    });

    const result = runMemoryProviderConnectionTest({
      providerId: "mem0:main",
      provider,
      kind: "mem0",
    });

    expect(result.ok).toBe(true);
    expect(result.networkAttempted).toBe(false);
  });

  it("returns CONFIG_INVALID and redacts secrets when validateConfig throws", () => {
    const secret = "sk-VALIDATE-CONFIG-SECRET-abcdefghij";
    const provider = stubProvider({
      id: "mem0:leak",
      kind: "mem0",
      validateConfig: () => {
        throw new Error(`missing apiKey=${secret}`);
      },
    });

    const result = runMemoryProviderConnectionTest({
      providerId: "mem0:leak",
      provider,
      kind: "mem0",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("CONFIG_INVALID");
    expect(result.networkAttempted).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("treats missing validateConfig on external kinds as success", () => {
    const provider = stubProvider({ id: "custom:1", kind: "custom-memory" });

    const result = runMemoryProviderConnectionTest({
      providerId: "custom:1",
      provider,
      kind: "custom-memory",
    });

    expect(result.ok).toBe(true);
    expect(result.networkAttempted).toBe(false);
  });
});