// Unit tests for the Setup Status composer (`computeSetupStatus`).
//
// Validates (by example): Requirements 1.1, 1.2, 1.3, 1.4, 1.10, 7.5
//
// These exercise the pure composer over an injected env map and an in-memory SecretStore
// double, so they run with zero network/provider calls and zero disk access. The named
// fast-check property tests for mode derivation (Property 3) and well-formed readiness
// (Property 4) are tracked separately as tasks 2.2 and 2.3.
import { describe, expect, it } from "vitest";

import { computeSetupStatus, computeMemoryReadiness, type SetupCategory } from "../src/setupStatus";
import type { SecretStore, SecretStoreResult } from "../src/security/secretStore";
import { createInMemoryMemoryConfigStore } from "../src/providers/memoryConfigStore";
import type { MemoryProviderRecord } from "../src/providers/memoryConfig";

/**
 * An in-memory {@link SecretStore} double seeded with the provider ids that currently have a
 * stored secret. `getSecret`/`setSecret` are present to satisfy the interface but the composer
 * only consults `hasSecret` (presence only), so they are never relied on here.
 */
function fakeSecretStore(presentProviderIds: string[] = []): SecretStore {
  const present = new Set(presentProviderIds);
  return {
    async setSecret(): Promise<SecretStoreResult<void>> {
      return { ok: true, value: undefined };
    },
    async getSecret(): Promise<SecretStoreResult<string>> {
      return { ok: false, error: "not used in these tests" };
    },
    async hasSecret(providerId: string): Promise<boolean> {
      return present.has(providerId);
    },
  };
}

const ALL_CATEGORIES: SetupCategory[] = ["provider", "persistence", "workspace", "budget", "memory"];

const FIXED_NOW = "2026-06-10T12:00:00.000Z";

function makeMemoryRecord(overrides: Partial<MemoryProviderRecord> = {}): MemoryProviderRecord {
  return {
    id: "mem0:demo",
    kind: "mem0",
    label: "Demo Mem0",
    config: {},
    secretRef: "memory:mem0:demo",
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

describe("computeSetupStatus", () => {
  it("derives local mode when ORCHESTRATOR_MODE is unset", async () => {
    const status = await computeSetupStatus({}, fakeSecretStore());
    expect(status.mode).toBe("local");
  });

  it("derives external mode only when ORCHESTRATOR_MODE is exactly 'external'", async () => {
    expect((await computeSetupStatus({ ORCHESTRATOR_MODE: "external" }, fakeSecretStore())).mode).toBe("external");
    expect((await computeSetupStatus({ ORCHESTRATOR_MODE: "External" }, fakeSecretStore())).mode).toBe("local");
    expect((await computeSetupStatus({ ORCHESTRATOR_MODE: "local" }, fakeSecretStore())).mode).toBe("local");
    expect((await computeSetupStatus({ ORCHESTRATOR_MODE: "nonsense" }, fakeSecretStore())).mode).toBe("local");
  });

  it("returns exactly one well-formed readiness entry per category", async () => {
    const status = await computeSetupStatus({}, fakeSecretStore());
    const seen = status.categories.map((entry) => entry.category);

    expect(seen.sort()).toEqual([...ALL_CATEGORIES].sort());
    expect(new Set(seen).size).toBe(ALL_CATEGORIES.length); // no duplicates
    for (const entry of status.categories) {
      expect(["Ready", "Incomplete", "Error"]).toContain(entry.status);
    }
  });

  it("reports provider Ready in local mode without any provider configured", async () => {
    const status = await computeSetupStatus({}, fakeSecretStore());
    expect(providerStatus(status.categories)).toBe("Ready");
  });

  it("reports provider Incomplete in external mode with no provider configured", async () => {
    const status = await computeSetupStatus({ ORCHESTRATOR_MODE: "external" }, fakeSecretStore());
    expect(providerStatus(status.categories)).toBe("Incomplete");
  });

  it("reports provider Ready in external mode when a secret is present in the store", async () => {
    const status = await computeSetupStatus({ ORCHESTRATOR_MODE: "external" }, fakeSecretStore(["together"]));
    expect(providerStatus(status.categories)).toBe("Ready");
  });

  it("reports provider Ready in external mode when required env keys are present", async () => {
    const status = await computeSetupStatus(
      { ORCHESTRATOR_MODE: "external", TOGETHER_API_KEY: "anything" },
      fakeSecretStore()
    );
    expect(providerStatus(status.categories)).toBe("Ready");
  });

  it("reports persistence readiness across drivers", async () => {
    expect(persistenceStatus(await categoriesFor({}))).toBe("Ready"); // default memory
    expect(persistenceStatus(await categoriesFor({ RECTOR_PERSISTENCE: "sqlite" }))).toBe("Ready");
    expect(persistenceStatus(await categoriesFor({ RECTOR_PERSISTENCE: "tidb" }))).toBe("Incomplete");
    expect(
      persistenceStatus(
        await categoriesFor({
          RECTOR_PERSISTENCE: "tidb",
          TIDB_HOST: "h",
          TIDB_PORT: "4000",
          TIDB_USER: "u",
          TIDB_PASSWORD: "p",
          TIDB_DATABASE: "d",
        })
      )
    ).toBe("Ready");
    expect(persistenceStatus(await categoriesFor({ RECTOR_PERSISTENCE: "bogus" }))).toBe("Error");
  });

  it("reports workspace readiness for local and depot runtimes", async () => {
    expect(workspaceStatus(await categoriesFor({}))).toBe("Ready");
    expect(workspaceStatus(await categoriesFor({ SANDBOX_RUNTIME: "depot" }))).toBe("Incomplete");
    expect(workspaceStatus(await categoriesFor({ SANDBOX_RUNTIME: "depot", DEPOT_API_KEY: "x" }))).toBe("Ready");
    expect(workspaceStatus(await categoriesFor({ SANDBOX_RUNTIME: "bogus" }))).toBe("Error");
  });

  it("reports presence booleans only and never a secret value", async () => {
    const status = await computeSetupStatus(
      { ORCHESTRATOR_MODE: "external" },
      fakeSecretStore(["together", "azure-openai"])
    );

    expect(status.secretPresence.together).toBe(true);
    expect(status.secretPresence["azure-openai"]).toBe(true);
    expect(status.secretPresence.cloudflare).toBe(false);
    for (const value of Object.values(status.secretPresence)) {
      expect(typeof value).toBe("boolean");
    }
  });

  it("redacts secret-bearing content in category details", async () => {
    const status = await computeSetupStatus({}, fakeSecretStore());
    const serialized = JSON.stringify(status);
    // A bearer token embedded anywhere would be scrubbed by the boundary redaction pass.
    expect(serialized).not.toMatch(/Bearer\s+\S/);
  });

  it("reports memory Ready in local mode with the local-inmemory default", async () => {
    const status = await computeSetupStatus({}, fakeSecretStore());
    expect(memoryStatus(status.categories)).toBe("Ready");
    expect(memoryDetail(status.categories)).toContain("local-inmemory");
  });

  it("reports memory readiness from the env-only fallback", async () => {
    const external = { ORCHESTRATOR_MODE: "external" as const };
    expect(memoryStatus(await categoriesFor({ ...external, RECTOR_MEMORY_PROVIDER: "mem0" }))).toBe(
      "Incomplete",
    );
    expect(
      memoryStatus(
        await categoriesFor({ ...external, RECTOR_MEMORY_PROVIDER: "mem0", MEM0_API_KEY: "configured" }),
      ),
    ).toBe("Ready");
    expect(memoryStatus(await categoriesFor({ ...external, RECTOR_MEMORY_PROVIDER: "bogus" }))).toBe(
      "Error",
    );
  });

  it("reports memory readiness from the Memory_Config_Store when injected", async () => {
    const store = createInMemoryMemoryConfigStore();
    await store.upsertMemoryProvider(makeMemoryRecord());
    await store.setActiveMemoryProvider("mem0:demo");

    const incomplete = await computeSetupStatus(
      { ORCHESTRATOR_MODE: "external" },
      fakeSecretStore(),
      store,
    );
    expect(memoryStatus(incomplete.categories)).toBe("Incomplete");

    const secrets = fakeSecretStoreWithRefs(["memory:mem0:demo"]);
    const ready = await computeSetupStatus({ ORCHESTRATOR_MODE: "external" }, secrets, store);
    expect(memoryStatus(ready.categories)).toBe("Ready");
    expect(memoryDetail(ready.categories)).toContain("mem0");
  });

  it("computeMemoryReadiness reports active provider kind in detail", async () => {
    const store = createInMemoryMemoryConfigStore();
    await store.upsertMemoryProvider(
      makeMemoryRecord({ id: "chroma:demo", kind: "chroma", secretRef: "memory:chroma:demo" }),
    );
    await store.setActiveMemoryProvider("chroma:demo");

    const readiness = await computeMemoryReadiness(
      { ORCHESTRATOR_MODE: "external" },
      fakeSecretStore(),
      store,
    );
    expect(readiness.status).toBe("Incomplete");
    expect(readiness.detail).toContain("chroma");
    expect(readiness.detail).toContain("config.baseUrl");
  });
});

function providerStatus(categories: { category: SetupCategory; status: string }[]): string | undefined {
  return categories.find((entry) => entry.category === "provider")?.status;
}

function persistenceStatus(categories: { category: SetupCategory; status: string }[]): string | undefined {
  return categories.find((entry) => entry.category === "persistence")?.status;
}

function workspaceStatus(categories: { category: SetupCategory; status: string }[]): string | undefined {
  return categories.find((entry) => entry.category === "workspace")?.status;
}

function memoryStatus(categories: { category: SetupCategory; status: string }[]): string | undefined {
  return categories.find((entry) => entry.category === "memory")?.status;
}

function memoryDetail(categories: { category: SetupCategory; detail?: string }[]): string | undefined {
  return categories.find((entry) => entry.category === "memory")?.detail;
}

function fakeSecretStoreWithRefs(presentSecretRefs: string[] = []): SecretStore {
  const present = new Set(presentSecretRefs);
  return {
    async setSecret(): Promise<SecretStoreResult<void>> {
      return { ok: true, value: undefined };
    },
    async getSecret(): Promise<SecretStoreResult<string>> {
      return { ok: false, error: "not used in these tests" };
    },
    async hasSecret(secretRef: string): Promise<boolean> {
      return present.has(secretRef);
    },
  };
}

async function categoriesFor(env: Record<string, string | undefined>) {
  return (await computeSetupStatus(env, fakeSecretStore())).categories;
}
