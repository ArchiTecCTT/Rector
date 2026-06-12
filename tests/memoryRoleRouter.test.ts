import { describe, expect, it, vi } from "vitest";

import { LocalMemoryProvider } from "../src/memory/provider";
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
});
