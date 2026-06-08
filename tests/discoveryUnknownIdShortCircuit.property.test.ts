/**
 * Task 8.3 — Model_Discovery_Service unknown-id short-circuit property test.
 *
 * **Feature: byok-chat-ux-and-model-discovery, Property 8: Unknown provider id short-circuits with no network call**
 * **Validates: Requirements 10.3, 17.4**
 *
 * Property 8: *For any* provider id that has no {@link ProviderConfigRecord} in
 * the Provider_Config_Store, {@link createModelDiscoveryService}'s `discover`
 * SHALL resolve to a classified `not_found` failure (Req 10.3, 17.4) WITHOUT
 * performing any network call and WITHOUT reading any secret. The unknown id is
 * resolved before the cache, the Secret_Store, and the adapter are ever
 * touched, so a spy `fetch`, a spy `SecretStore`, and spy adapters must all see
 * zero invocations.
 *
 * Every run is hermetic: discovery is driven entirely through injected
 * dependencies (an in-memory config store, a spy secret store, spy adapters,
 * and a spy `fetchImpl`); no real network or disk access occurs.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

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

const ISO = "2026-01-01T00:00:00.000Z";

/** A non-empty provider id (the schema only requires length >= 1). */
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
 * Return an id guaranteed absent from `existing` by extending a base until it
 * no longer collides, so the queried id is always genuinely unknown regardless
 * of what the generator produced for the store.
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

describe("Feature: byok-chat-ux-and-model-discovery, Property 8: Unknown provider id short-circuits with no network call", () => {
  // Validates: Requirements 10.3, 17.4
  it("returns a not_found result with zero network calls and zero secret reads for any unknown id", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbRecord, { minLength: 0, maxLength: 8 }),
        arbId,
        fc.boolean(),
        fc.boolean(),
        async (records, baseUnknownId, refresh, includeDeprecated) => {
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

          const result = await service.discover(unknownId, {
            refresh,
            includeDeprecated,
            fetchImpl: spyFetch(spies),
          });

          // The result is a well-formed, classified not_found failure (Req 10.3, 17.4).
          expect(DiscoveryResultSchema.safeParse(result).success).toBe(true);
          expect(result.ok).toBe(false);
          if (result.ok) {
            return;
          }
          expect(result.error.category).toBe("not_found");
          expect(result.providerId).toBe(unknownId);

          // No network call, no secret read, no adapter dispatch on the
          // short-circuit path (Req 10.3, 17.4).
          expect(spies.fetchCalls).toBe(0);
          expect(spies.secretCalls).toBe(0);
          expect(spies.adapterCalls).toBe(0);
        },
      ),
      { numRuns: 200 },
    );
  });
});
