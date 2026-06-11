/**
 * Task 6.2 — Settings_API unknown-provider handling property test.
 *
 * **Feature: cloud-capable-transition, Property 16: An unknown provider id yields not_found**
 * **Validates: Requirements 4.2**
 *
 * Property 16: *For any* provider id that has no {@link ProviderConfigRecord} in
 * the Provider_Config_Store, the Settings_API discovery handler
 * ({@link runSettingsDiscovery}) in external mode resolves to a
 * `{ ok: false }` {@link DiscoveryResult} whose {@link DiscoveryError} category
 * is exactly `not_found`, preserving the requested provider id (Requirement
 * 4.2). The handler relays the {@link ModelDiscoveryService}'s classified
 * result without throwing and without ever touching the network.
 *
 * The test drives the REAL exported handler against the REAL
 * {@link createModelDiscoveryService}, backed by an in-memory
 * {@link ProviderConfigStore} seeded with an arbitrary set of records that is
 * guaranteed NOT to contain the queried id. The service's unknown-id
 * short-circuit (resolve record → `undefined` → `not_found`) is therefore the
 * real production path under test, surfaced through the Settings_API layer.
 *
 * Every dependency is a hermetic double:
 *
 *   - `mode: "external"` so the service is actually consulted (the local-mode
 *     short-circuit is covered by task 6.4);
 *   - a spy `fetchImpl`, spy `SecretStore`, and spy adapter registry that record
 *     every call — all three MUST see zero invocations because an unknown id is
 *     resolved before the cache, the secret read, and any adapter dispatch;
 *   - injected no-op timers so the 30 000 ms Settings_API deadline never fires
 *     (the service resolves immediately and wins the race), keeping the run
 *     instant.
 *
 * There is ZERO disk, network, or provider I/O.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { runSettingsDiscovery, SETTINGS_DISCOVERY_TIMEOUT_MS } from "../src/api/server";
import {
  PROVIDER_KINDS,
  type ProviderConfigRecord,
  type ProviderConfigState,
  type ProviderKind,
} from "../src/providers/config";
import { createInMemoryProviderConfigStore } from "../src/providers/configStore";
import { createDiscoveryCache } from "../src/providers/discovery/cache";
import type {
  AdapterContext,
  DiscoveryAdapter,
  DiscoveryAdapterRegistry,
} from "../src/providers/discovery/adapters/index";
import { createModelDiscoveryService } from "../src/providers/discovery/service";
import { DiscoveryResultSchema } from "../src/providers/discovery/types";
import type { SecretStore } from "../src/security/secretStore";

/** A fixed, schema-valid ISO timestamp for deterministic result metadata. */
const ISO = "2026-01-01T00:00:00.000Z";

/** A non-empty provider id (the config schema only requires length >= 1). */
const arbId: fc.Arbitrary<string> = fc.string({ minLength: 1, maxLength: 24 });

const arbKind: fc.Arbitrary<ProviderKind> = fc.constantFrom(...PROVIDER_KINDS);

/** Build a minimal, schema-valid non-secret config record. */
function makeRecord(id: string, kind: ProviderKind): ProviderConfigRecord {
  return {
    id,
    kind,
    label: `Provider ${id}`,
    secretRef: id,
    createdAt: ISO,
    updatedAt: ISO,
  };
}

const arbRecord: fc.Arbitrary<ProviderConfigRecord> = fc
  .record({ id: arbId, kind: arbKind })
  .map(({ id, kind }) => makeRecord(id, kind));

/**
 * Return an id guaranteed absent from `existing` by extending a base until it no
 * longer collides, so the queried id is always genuinely unknown regardless of
 * what the generator produced for the store.
 */
function uniqueAbsentId(existing: readonly string[], base: string): string {
  const taken = new Set(existing);
  let id = base.length > 0 ? base : "missing";
  while (taken.has(id)) {
    id += "_x";
  }
  return id;
}

interface Spies {
  fetchCalls: number;
  secretCalls: number;
  adapterCalls: number;
}

/** A spy `fetch` that records every call; it must never fire on this path. */
function spyFetch(spies: Spies): typeof fetch {
  return (async () => {
    spies.fetchCalls += 1;
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

/** A spy Secret_Store that records every secret read; it must never be read. */
function spySecrets(spies: Spies): SecretStore {
  return {
    async getSecret() {
      spies.secretCalls += 1;
      return { ok: false, error: "no secret" };
    },
    async setSecret() {
      return { ok: true, value: undefined };
    },
    async hasSecret() {
      return false;
    },
  };
}

/** A spy adapter registry whose `discover` records every dispatch. */
function spyAdapters(spies: Spies): DiscoveryAdapterRegistry {
  const registry = {} as Record<ProviderKind, DiscoveryAdapter>;
  for (const kind of PROVIDER_KINDS) {
    const adapter: DiscoveryAdapter = {
      kind,
      async discover(ctx: AdapterContext) {
        spies.adapterCalls += 1;
        // If ever (wrongly) dispatched, still flow through the injected fetch so
        // the network-call spy also trips — defense in depth for the assertion.
        await ctx.fetchImpl("https://example.invalid/models");
        return { ok: true, candidates: [] };
      },
    };
    registry[kind] = adapter;
  }
  return registry;
}

describe("Feature: cloud-capable-transition, Property 16: An unknown provider id yields not_found", () => {
  // Validates: Requirements 4.2
  it("returns a not_found Discovery_Error for any unknown provider id in external mode, with no network or secret access", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbRecord, { minLength: 0, maxLength: 8 }),
        arbId,
        fc.boolean(),
        async (records, baseUnknownId, refresh) => {
          const unknownId = uniqueAbsentId(
            records.map((record) => record.id),
            baseUnknownId,
          );

          const state: ProviderConfigState = {
            version: 1,
            providers: records,
            activeRoutes: {},
          };
          const configStore = createInMemoryProviderConfigStore(state);

          const spies: Spies = { fetchCalls: 0, secretCalls: 0, adapterCalls: 0 };
          const service = createModelDiscoveryService({
            configStore,
            secrets: spySecrets(spies),
            cache: createDiscoveryCache(),
            adapters: spyAdapters(spies),
            clock: () => Date.parse(ISO),
          });

          // No-op timers: the Settings_API deadline must never fire because the
          // service resolves immediately and wins the race. Keeps the run instant.
          const setTimeoutImpl = (() => 0 as unknown) as (
            handler: () => void,
            ms: number,
          ) => ReturnType<typeof setTimeout>;
          const clearTimeoutImpl = (() => {}) as (
            handle: ReturnType<typeof setTimeout>,
          ) => void;

          // The handler must not throw for an unknown id.
          const result = await runSettingsDiscovery({
            mode: "external",
            service,
            providerId: unknownId,
            refresh,
            fetchImpl: spyFetch(spies),
            timeoutMs: SETTINGS_DISCOVERY_TIMEOUT_MS,
            now: () => new Date(ISO),
            setTimeoutImpl,
            clearTimeoutImpl,
          });

          // The relayed result is a well-formed, classified `not_found` failure
          // that preserves the requested provider id (Requirement 4.2).
          expect(DiscoveryResultSchema.safeParse(result).success).toBe(true);
          expect(result.ok).toBe(false);
          if (result.ok) {
            return;
          }
          expect(result.error.category).toBe("not_found");
          expect(result.providerId).toBe(unknownId);

          // An unknown id short-circuits before the cache, the Secret_Store, and
          // any adapter, so no network call, no secret read, no adapter dispatch.
          expect(spies.fetchCalls).toBe(0);
          expect(spies.secretCalls).toBe(0);
          expect(spies.adapterCalls).toBe(0);
        },
      ),
      { numRuns: 200 },
    );
  });
});
