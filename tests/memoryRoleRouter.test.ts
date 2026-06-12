import { describe, expect, it, vi } from "vitest";

import { LocalMemoryProvider } from "../src/memory/provider";
import type { CreateMemoryEntryInput, MemoryEntry } from "../src/store/schemas";
import type { MemoryProviderRecord } from "../src/providers/memoryConfig";
import { createInMemoryMemoryConfigStore } from "../src/providers/memoryConfigStore";
import { createMemoryRoleAssignment } from "../src/providers/memoryAssignments";
import { createInMemoryMemoryAssignmentStore } from "../src/providers/memoryAssignmentStore";
import { MemoryRoleRouter } from "../src/providers/memoryRoleRouter";
import type { SecretStore, SecretStoreResult } from "../src/security/secretStore";

const NOW = "2026-06-12T12:00:00.000Z";

function fakeSecrets(initial: Record<string, string> = {}): SecretStore {
  const values = new Map(Object.entries(initial));
  return {
    async setSecret(providerId: string, value: string): Promise<SecretStoreResult<void>> {
      values.set(providerId, value);
      return { ok: true, value: undefined };
    },
    async getSecret(providerId: string): Promise<SecretStoreResult<string>> {
      const value = values.get(providerId);
      return value === undefined ? { ok: false, error: "missing" } : { ok: true, value };
    },
    async hasSecret(providerId: string): Promise<boolean> {
      return values.has(providerId);
    },
  };
}

function record(overrides: Partial<MemoryProviderRecord>): MemoryProviderRecord {
  return {
    id: "local-sqlite-mem:main",
    kind: "local-sqlite-mem",
    label: "SQLite",
    config: {},
    secretRef: "memory:local-sqlite-mem:main",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function delegateMemoryStore(label: string): {
  createCalls: CreateMemoryEntryInput[];
  store: {
    createMemoryEntry(input: CreateMemoryEntryInput): Promise<MemoryEntry>;
    getMemoryEntry(): Promise<MemoryEntry | undefined>;
    listMemoryEntries(): Promise<MemoryEntry[]>;
    updateMemoryEntry(): Promise<MemoryEntry | undefined>;
    deleteMemoryEntry(): Promise<boolean>;
    searchMemory(): Promise<MemoryEntry[]>;
    pruneMemory(): Promise<{ pruned: number; summarized: number }>;
  };
} {
  const createCalls: CreateMemoryEntryInput[] = [];
  return {
    createCalls,
    store: {
      async createMemoryEntry(input) {
        createCalls.push(input);
        return {
          id: `${label}:${createCalls.length}`,
          layer: input.layer,
          content: input.content,
          timestamp: input.timestamp ?? NOW,
          lastMentioned: input.lastMentioned ?? input.timestamp ?? NOW,
          accessCount: input.accessCount ?? 0,
          tags: input.tags ?? [],
          source: input.source,
          metadata: input.metadata ?? {},
        };
      },
      async getMemoryEntry() { return undefined; },
      async listMemoryEntries() { return []; },
      async updateMemoryEntry() { return undefined; },
      async deleteMemoryEntry() { return false; },
      async searchMemory() { return []; },
      async pruneMemory() { return { pruned: 0, summarized: 0 }; },
    },
  };
}

describe("MemoryRoleRouter", () => {
  it("resolves unassigned roles to the zero-config local provider", async () => {
    const router = new MemoryRoleRouter({
      assignmentStore: createInMemoryMemoryAssignmentStore(),
      configStore: createInMemoryMemoryConfigStore(),
      secrets: fakeSecrets(),
    });

    const effective = await router.resolveMemoryProvider("episodicMemory");

    expect(effective.status).toBe("ready");
    expect(effective.source).toBe("localFallback");
    expect(effective.provider).toBeInstanceOf(LocalMemoryProvider);
    expect(effective.provider?.kind).toBe("local-inmemory");
  });

  it("uses a role assignment when the provider record exists", async () => {
    const configStore = createInMemoryMemoryConfigStore();
    await configStore.upsertMemoryProvider(record({ id: "local-sqlite-mem:role" }));
    const assignmentStore = createInMemoryMemoryAssignmentStore();
    await assignmentStore.upsertAssignment(
      createMemoryRoleAssignment({ role: "semanticMemory", providerRecordId: "local-sqlite-mem:role", now: NOW }),
    );
    const router = new MemoryRoleRouter({ assignmentStore, configStore, secrets: fakeSecrets() });

    const effective = await router.resolveMemoryProvider("semanticMemory");

    expect(effective.status).toBe("ready");
    expect(effective.source).toBe("assignment");
    expect(effective.provider?.id).toBe("local-sqlite-mem:role");
    expect(effective.provider?.kind).toBe("local-sqlite-mem");
  });

  it("does not read secrets or build external providers in local mode", async () => {
    const configStore = createInMemoryMemoryConfigStore();
    await configStore.upsertMemoryProvider(record({ id: "mem0:main", kind: "mem0", label: "Mem0", secretRef: "memory:mem0:main" }));
    const assignmentStore = createInMemoryMemoryAssignmentStore();
    await assignmentStore.upsertAssignment(
      createMemoryRoleAssignment({ role: "episodicMemory", providerRecordId: "mem0:main", now: NOW }),
    );
    const getSecret = vi.fn(async () => ({ ok: true, value: "sk-local-mode-should-not-read" }) as const);
    const secrets: SecretStore = {
      setSecret: async () => ({ ok: true, value: undefined }),
      getSecret,
      hasSecret: async () => true,
    };
    const router = new MemoryRoleRouter({ assignmentStore, configStore, secrets, mode: "local" });

    const effective = await router.resolveMemoryProvider("episodicMemory", { mode: "local" });

    expect(effective.provider?.kind).toBe("local-inmemory");
    expect(getSecret).not.toHaveBeenCalled();
    expect(effective.warnings.map((warning) => warning.code)).toContain("EXTERNAL_MEMORY");
  });

  it("applies resolve-time context when falling back to local memory", async () => {
    const assignmentStore = createInMemoryMemoryAssignmentStore();
    await assignmentStore.upsertAssignment(
      createMemoryRoleAssignment({ role: "episodicMemory", providerRecordId: "missing-memory", now: NOW }),
    );
    const router = new MemoryRoleRouter({
      assignmentStore,
      configStore: createInMemoryMemoryConfigStore(),
      secrets: fakeSecrets(),
    });
    const contextNow = "2030-01-01T00:00:00.000Z";

    const effective = await router.resolveMemoryProvider("episodicMemory", { now: () => contextNow });
    const entry = await effective.provider?.createMemoryEntry({ layer: "episodic", content: "uses context clock" });

    expect(effective.source).toBe("localFallback");
    expect(entry?.timestamp).toBe(contextNow);
  });

  it("does not reuse cached providers across different delegate/run contexts", async () => {
    const configStore = createInMemoryMemoryConfigStore();
    await configStore.upsertMemoryProvider(record({ id: "local-sqlite-mem:role" }));
    const assignmentStore = createInMemoryMemoryAssignmentStore();
    await assignmentStore.upsertAssignment(
      createMemoryRoleAssignment({ role: "semanticMemory", providerRecordId: "local-sqlite-mem:role", now: NOW }),
    );
    const first = delegateMemoryStore("first");
    const second = delegateMemoryStore("second");
    const router = new MemoryRoleRouter({ assignmentStore, configStore, secrets: fakeSecrets() });

    const firstEffective = await router.resolveMemoryProvider("semanticMemory", {
      delegateStoreForLocalSqliteMem: first.store,
      run: { id: "run-1" } as any,
    });
    await firstEffective.provider?.createMemoryEntry({ layer: "core", content: "first" });
    const secondEffective = await router.resolveMemoryProvider("semanticMemory", {
      delegateStoreForLocalSqliteMem: second.store,
      run: { id: "run-2" } as any,
    });
    await secondEffective.provider?.createMemoryEntry({ layer: "core", content: "second" });

    expect(first.createCalls.map((call) => call.content)).toEqual(["first"]);
    expect(second.createCalls.map((call) => call.content)).toEqual(["second"]);
    expect(secondEffective.provider).not.toBe(firstEffective.provider);
  });
});
