/**
 * Feature: cloud-capable-transition, Property 33: Local mode never consults the
 * Config_Bridge and selects the provider-free fallback.
 *
 * Validates: Requirements 9.3, 5.6
 *
 *   9.3 "WHILE Orchestrator_Mode is `local`, THE Config_Bridge SHALL NOT be
 *        consulted for router construction."
 *   5.6 "WHILE Orchestrator_Mode is `local`, THE Config_Bridge SHALL NOT
 *        construct any external provider and the Model_Router SHALL select the
 *        provider-free fallback."
 *
 * `buildConfiguredRouter` is the Config_Bridge entry point. In `local` mode it
 * MUST refuse to construct any external provider: it reads NO persisted
 * configuration and NO secret, and the router it returns selects the
 * provider-free fallback (the {@link FakeLLMProvider}) for every request.
 *
 * The property is observed directly through *counting* doubles: a
 * Provider_Config_Store wrapper that tallies every `getState` read and a
 * Secret_Store wrapper that tallies every `getSecret`/`hasSecret` read. Both
 * are pre-seeded with a fully-populated, schema-valid configuration (records,
 * secrets present, and Active_Route_Map designations) so that *if* local mode
 * erroneously consulted the bridge the counters would tick and a non-fake
 * provider could be constructed. The property asserts the opposite: zero reads
 * on either store and a `fake` selection for every capability.
 *
 * Hermetic: an in-memory Provider_Config_Store, an in-memory SecretStore, and
 * an injected `fetch` that throws if ever reached. ZERO real disk, network, or
 * live provider access.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { MODEL_ROUTES, type ModelRoute } from "../src/providers/llm";
import type { ProviderConfigRecord, ProviderConfigState, ProviderModelRole } from "../src/providers/config";
import {
  createInMemoryProviderConfigStore,
  type ProviderConfigStore,
} from "../src/providers/configStore";
import { buildConfiguredRouter } from "../src/providers/configBridge";
import type { SecretStore, SecretStoreResult } from "../src/security/secretStore";

const FIXED_TS = "2026-01-01T00:00:00.000Z";

/** A `fetch` that must never be reached in local mode. */
const exploding = (async () => {
  throw new Error("network must not be reached in local mode");
}) as unknown as typeof fetch;

/**
 * In-memory {@link SecretStore} double that *counts* every secret read, so the
 * test can assert local mode reads zero secrets.
 */
function createCountingSecretStore(initial: Record<string, string>): {
  store: SecretStore;
  counts: { getSecret: number; hasSecret: number };
} {
  const secrets = new Map<string, string>(Object.entries(initial));
  const counts = { getSecret: 0, hasSecret: 0 };
  const store: SecretStore = {
    async setSecret(providerId: string, value: string): Promise<SecretStoreResult<void>> {
      secrets.set(providerId, value);
      return { ok: true, value: undefined };
    },
    async getSecret(providerId: string): Promise<SecretStoreResult<string>> {
      counts.getSecret += 1;
      const value = secrets.get(providerId);
      return value === undefined
        ? { ok: false, error: `No secret stored for provider "${providerId}".` }
        : { ok: true, value };
    },
    async hasSecret(providerId: string): Promise<boolean> {
      counts.hasSecret += 1;
      return secrets.has(providerId);
    },
  };
  return { store, counts };
}

/**
 * Wrap a real {@link ProviderConfigStore} and *count* every `getState` read.
 * The wrapper delegates to a pre-seeded inner store so the configuration is
 * fully populated; seeding happens on the inner store directly so the counter
 * starts at zero.
 */
function createCountingConfigStore(inner: ProviderConfigStore): {
  store: ProviderConfigStore;
  counts: { getState: number };
} {
  const counts = { getState: 0 };
  const store: ProviderConfigStore = {
    async getState(): Promise<ProviderConfigState> {
      counts.getState += 1;
      return inner.getState();
    },
    upsertProvider: (rec) => inner.upsertProvider(rec),
    removeProvider: (id) => inner.removeProvider(id),
    setActiveRoute: (role, providerId) => inner.setActiveRoute(role, providerId),
  };
  return { store, counts };
}

/** A fully-configured, schema-valid `openai-compatible` record + its secret. */
function buildRecord(token: string): { record: ProviderConfigRecord; secretRef: string; secret: string } {
  const secretRef = `secret:oai:${token}`;
  const secret = `key-${token}-abcdefgh`;
  const record: ProviderConfigRecord = {
    id: `openai-compatible:${token}`,
    kind: "openai-compatible",
    label: `Label ${token}`,
    baseUrl: `https://${token}.proxy.example/v1`,
    model: `model-${token}`,
    secretRef,
    createdAt: FIXED_TS,
    updatedAt: FIXED_TS,
  };
  return { record, secretRef, secret };
}

// 0–3 distinct provider tokens: the store may be empty or richly populated; in
// every case local mode must read nothing and select the fake fallback.
const tokensArb = fc.uniqueArray(fc.integer({ min: 1, max: 1_000_000 }).map((n) => `t${n}`), {
  minLength: 0,
  maxLength: 3,
});
// A non-empty sequence of capabilities to select (including `undefined`, the
// "no explicit capability" case), so selection is exercised across every tier.
const capabilityArb: fc.Arbitrary<ModelRoute | undefined> = fc.constantFrom<ModelRoute | undefined>(
  ...MODEL_ROUTES,
  undefined,
);
const capabilitiesArb = fc.array(capabilityArb, { minLength: 1, maxLength: 6 });

describe("Config_Bridge — Property 33: local mode never consults the bridge and selects the fake fallback (Req 9.3, 5.6)", () => {
  it("reads zero config/secret state and selects the provider-free fallback for every request in local mode", async () => {
    await fc.assert(
      fc.asyncProperty(tokensArb, capabilitiesArb, async (tokens, capabilities) => {
        const built = tokens.map(buildRecord);

        // Seed the inner store + secret map *before* wrapping with counters, so
        // the configuration is fully present yet the read counters start at 0.
        const inner = createInMemoryProviderConfigStore();
        for (const { record } of built) {
          const result = await inner.upsertProvider(record);
          expect(result.ok).toBe(true);
        }
        // Designate Active_Route_Map roles when records exist, so an erroneous
        // bridge consultation would have a concrete external route to build.
        const roles: ProviderModelRole[] = ["flagship", "slm"];
        for (let i = 0; i < roles.length && built.length > 0; i += 1) {
          const designated = built[i % built.length];
          const routed = await inner.setActiveRoute(roles[i], designated.record.id);
          expect(routed.ok).toBe(true);
        }

        const secretMap = Object.fromEntries(built.map((entry) => [entry.secretRef, entry.secret]));
        const { store, counts: storeCounts } = createCountingConfigStore(inner);
        const { store: secrets, counts: secretCounts } = createCountingSecretStore(secretMap);

        // Build the router through the Config_Bridge in LOCAL mode.
        const router = await buildConfiguredRouter({
          store,
          secrets,
          mode: "local",
          baseEnv: {}, // isolate from any ambient process.env credentials
          enableNetwork: true, // even when network is permitted, local mode must stay inert
          fetchImpl: exploding,
        });

        // Req 9.3 / 5.6 — the bridge consulted neither store while building the
        // local router: zero config reads, zero secret reads of any kind.
        expect(storeCounts.getState).toBe(0);
        expect(secretCounts.getSecret).toBe(0);
        expect(secretCounts.hasSecret).toBe(0);

        // Req 5.6 — every selection resolves to the provider-free fallback,
        // regardless of the requested capability tier.
        for (const capability of capabilities) {
          const selection = router.select(capability === undefined ? {} : { capability });
          expect(selection.provider.metadata.id).toBe("fake");
        }

        // Selection performed no network call (the injected fetch never threw).
        // And selection still touched neither store.
        expect(storeCounts.getState).toBe(0);
        expect(secretCounts.getSecret).toBe(0);
        expect(secretCounts.hasSecret).toBe(0);
      }),
      { numRuns: 100 },
    );
  });
});
