import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";

import type { MemoryProviderRecord } from "../src/providers/memoryConfig";
import { createInMemoryMemoryConfigStore } from "../src/providers/memoryConfigStore";
import { MEMORY_ROLES, createMemoryRoleAssignment, type MemoryRole } from "../src/providers/memoryAssignments";
import { createInMemoryMemoryAssignmentStore } from "../src/providers/memoryAssignmentStore";
import { MemoryRoleRouter } from "../src/providers/memoryRoleRouter";
import type { SecretStore } from "../src/security/secretStore";

const NOW = "2026-06-12T12:00:00.000Z";

function externalRecord(id: string): MemoryProviderRecord {
  return {
    id,
    kind: "mem0",
    label: "Mem0",
    config: { baseUrl: "https://api.mem0.test" },
    secretRef: `memory:${id}`,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("memory assignments preserve Local_Mode isolation", () => {
  it("does not read external secrets for arbitrary role assignments in local mode", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...MEMORY_ROLES), fc.string({ minLength: 1, maxLength: 24 }), async (role, suffix) => {
        const safeSuffix = suffix.replace(/[^a-zA-Z0-9_-]/g, "_") || "main";
        const providerId = `mem0:${safeSuffix}`;
        const configStore = createInMemoryMemoryConfigStore();
        await configStore.upsertMemoryProvider(externalRecord(providerId));
        const assignmentStore = createInMemoryMemoryAssignmentStore();
        await assignmentStore.upsertAssignment(
          createMemoryRoleAssignment({ role: role as MemoryRole, providerRecordId: providerId, now: NOW }),
        );
        const getSecret = vi.fn(async () => ({ ok: true, value: "sk-never-read-in-local-mode" }) as const);
        const secrets: SecretStore = {
          setSecret: async () => ({ ok: true, value: undefined }),
          getSecret,
          hasSecret: async () => true,
        };
        const router = new MemoryRoleRouter({ assignmentStore, configStore, secrets, mode: "local" });

        const effective = await router.resolveMemoryProvider(role as MemoryRole, { mode: "local" });

        expect(effective.provider?.kind).toBe("local-inmemory");
        expect(getSecret).not.toHaveBeenCalled();
      }),
      { numRuns: 25 },
    );
  });
});
