/**
 * Task 6 — Local_Mode invariance regression (Correctness Property 7, Req 17.1/17.2).
 *
 * Local_Mode is Rector's provider-free regression baseline. This test pins the
 * invariant that, with `ORCHESTRATOR_MODE=local`, **no provider/network call
 * occurs regardless of any persisted configuration or secret** — even when a
 * provider record and its Secret_Store secret are present and an Active_Route_Map
 * designates that provider.
 *
 * It exercises the real selection code through deterministic doubles only — an
 * in-memory Provider_Config_Store and a fake {@link SecretStore} — with ZERO
 * disk or network. A `fetch` double that throws on any call stands in for the
 * network: if any provider were constructed live and invoked, the spy would
 * fire and fail the test.
 *
 * Two paths are covered:
 *   1. The production Local_Mode path used by `src/bin/server.ts`
 *      (`buildModelRouter({ mode: "local" })`), which never consults the
 *      Config_Bridge at all.
 *   2. The Config_Bridge itself in `mode: "local"` (`buildConfiguredRouter`)
 *      seeded with a record + secret + active route, proving the invariant holds
 *      end-to-end even if the bridge is ever used on the local path.
 */
import { describe, expect, it, vi } from "vitest";

import {
  type ProviderConfigRecord,
} from "../src/providers/config";
import {
  createInMemoryProviderConfigStore,
  type ProviderConfigStore,
} from "../src/providers/configStore";
import { buildConfiguredRouter } from "../src/providers/configBridge";
import { buildModelRouter, type ModelRoute } from "../src/providers/llm";
import type { SecretStore, SecretStoreResult } from "../src/security/secretStore";

const FIXED_TS = "2026-01-01T00:00:00.000Z";

/** Every selectable capability route, so the assertion covers all roles. */
const ALL_CAPABILITIES: ModelRoute[] = ["cheap", "fast", "flagship", "research"];

/** A deterministic in-memory {@link SecretStore} double (no disk/network). */
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

/** A `fetch` double that fails the moment it is called — proving no network egress. */
function createNetworkTripwire(): typeof fetch {
  return vi.fn(async () => {
    throw new Error("Local_Mode must never make a network call");
  }) as unknown as typeof fetch;
}

/** A configured openai-compatible record (with a live-looking secret) to seed. */
function makeRecord(overrides: Partial<ProviderConfigRecord> = {}): ProviderConfigRecord {
  return {
    id: "openai-compatible:proxy",
    kind: "openai-compatible",
    label: "Proxy",
    baseUrl: "https://proxy.example.com/v1",
    model: "model-default",
    secretRef: "secret:openai-compatible:proxy",
    createdAt: FIXED_TS,
    updatedAt: FIXED_TS,
    ...overrides,
  };
}

async function seedStore(
  records: ProviderConfigRecord[],
  activeRoutes: Partial<Record<"flagship" | "slm", string>> = {},
): Promise<ProviderConfigStore> {
  const store = createInMemoryProviderConfigStore();
  for (const record of records) {
    const result = await store.upsertProvider(record);
    expect(result.ok).toBe(true);
  }
  for (const [role, id] of Object.entries(activeRoutes)) {
    await store.setActiveRoute(role as "flagship" | "slm", id ?? null);
  }
  return store;
}

describe("Local_Mode invariance — Property 7 (Req 17.1, 17.2)", () => {
  it("production local path selects the fake provider regardless of persisted config", () => {
    // Mirrors `src/bin/server.ts`: Local_Mode builds the provider-free router and
    // never consults the Config_Bridge, so persisted config can never influence it.
    const router = buildModelRouter({ mode: "local" });

    for (const capability of ALL_CAPABILITIES) {
      const selection = router.select({ capability });
      expect(selection.provider.metadata.id).toBe("fake");
    }
  });

  it("Config_Bridge in local mode never selects a configured provider or touches the network", async () => {
    // A fully-configured provider, a stored secret, and an active-route designation
    // are all present — the maximal opportunity for a leak into selection.
    const record = makeRecord();
    const store = await seedStore([record], { flagship: record.id });
    const secrets = createFakeSecretStore({ [record.secretRef]: "sk-LIVE-DEADBEEF-supersecret" });
    const fetchTripwire = createNetworkTripwire();

    // Build with mode: "local" and enableNetwork: true to prove that NEITHER the
    // mode-local selection NOR network is ever reached even when network is opted in.
    const router = await buildConfiguredRouter({
      store,
      secrets,
      mode: "local",
      baseEnv: {},
      enableNetwork: true,
      fetchImpl: fetchTripwire,
    });

    for (const capability of ALL_CAPABILITIES) {
      const selection = router.select({ capability });
      // Always the fake fallback; the active-route override is never applied in local mode.
      expect(selection.provider.metadata.id).toBe("fake");
      expect(selection.reason).not.toContain("active route");
    }

    // No provider was ever invoked, so the network tripwire never fired. Selection
    // and router construction are pure with respect to the network in local mode.
    expect(fetchTripwire).not.toHaveBeenCalled();
  });

  it("invoking the local selection uses the fake provider and performs no network call", async () => {
    const record = makeRecord();
    const store = await seedStore([record], { flagship: record.id });
    const secrets = createFakeSecretStore({ [record.secretRef]: "sk-LIVE-DEADBEEF-supersecret" });
    const fetchTripwire = createNetworkTripwire();

    const router = await buildConfiguredRouter({
      store,
      secrets,
      mode: "local",
      baseEnv: {},
      enableNetwork: true,
      fetchImpl: fetchTripwire,
    });

    const selection = router.select({ capability: "flagship" });
    // The fake provider produces a deterministic response with no I/O.
    const response = await selection.provider.invoke({
      messages: [{ role: "user", content: "ping" }],
      modelRoute: selection.modelRoute,
    });

    expect(response.provider).toBe("fake");
    expect(fetchTripwire).not.toHaveBeenCalled();
  });
});
