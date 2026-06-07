import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { computeSetupStatus, type SetupCategory } from "../src/setupStatus";
import type { SecretStore, SecretStoreResult } from "../src/security/secretStore";

/**
 * Task 2.3 — Well-formed readiness property test.
 *
 * **Property 4: Setup status readiness is well-formed**
 * **Validates: Requirements 1.2**
 *
 * For any environment map, the setup status response contains exactly one
 * readiness entry per category (provider, persistence, workspace, budget) with
 * no duplicate categories, and each entry's status is exactly one member of
 * {Ready, Incomplete, Error}.
 *
 * The composer is the pure `computeSetupStatus`. It is exercised over an
 * injected env map and an in-memory {@link SecretStore} double, so every run
 * makes zero network and zero provider calls (the double only answers a
 * presence boolean and never reaches a provider).
 */

/** The closed set of categories that must each appear exactly once (Requirement 1.2). */
const ALL_CATEGORIES: readonly SetupCategory[] = ["provider", "persistence", "workspace", "budget"];

/** The closed set of valid readiness statuses (Requirement 1.2). */
const VALID_STATUSES = ["Ready", "Incomplete", "Error"] as const;

/** Provider ids the composer reports presence for. */
const PROVIDER_IDS = ["together", "cloudflare", "azure-openai"] as const;

/**
 * An in-memory {@link SecretStore} double seeded with the provider ids that
 * currently have a stored secret. Only `hasSecret` is consulted by the composer
 * (presence only); `getSecret`/`setSecret` satisfy the interface but never reach
 * a provider, keeping the property network-free.
 */
function fakeSecretStore(presentProviderIds: readonly string[] = []): SecretStore {
  const present = new Set(presentProviderIds);
  return {
    async setSecret(): Promise<SecretStoreResult<void>> {
      return { ok: true, value: undefined };
    },
    async getSecret(): Promise<SecretStoreResult<string>> {
      return { ok: false, error: "not used in this property" };
    },
    async hasSecret(providerId: string): Promise<boolean> {
      return present.has(providerId);
    },
  };
}

/**
 * A smart generator for environment maps that constrains to the composer's
 * actual input space: it biases toward the keys that drive readiness
 * (ORCHESTRATOR_MODE, RECTOR_PERSISTENCE, SANDBOX_RUNTIME, the TiDB fields, and
 * DEPOT_API_KEY / provider keys) while also mixing in arbitrary noise keys so
 * the property holds for any environment, not just well-known shapes.
 */
const envArbitrary = (): fc.Arbitrary<Record<string, string | undefined>> => {
  // A value that is sometimes a meaningful enum, sometimes garbage, sometimes
  // undefined (to exercise the "missing key" and Error branches).
  const modeValue = fc.oneof(
    fc.constantFrom("local", "external", "External", "LOCAL", ""),
    fc.string()
  );
  const persistenceValue = fc.oneof(
    fc.constantFrom("memory", "sqlite", "tidb", "bogus", ""),
    fc.string()
  );
  const sandboxValue = fc.oneof(fc.constantFrom("local", "depot", "weird", ""), fc.string());
  const maybe = <T>(arb: fc.Arbitrary<T>) => fc.option(arb, { nil: undefined });

  const knownKeys = fc.record(
    {
      ORCHESTRATOR_MODE: maybe(modeValue),
      RECTOR_PERSISTENCE: maybe(persistenceValue),
      SANDBOX_RUNTIME: maybe(sandboxValue),
      DEPOT_API_KEY: maybe(fc.string()),
      TIDB_HOST: maybe(fc.string()),
      TIDB_PORT: maybe(fc.string()),
      TIDB_USER: maybe(fc.string()),
      TIDB_PASSWORD: maybe(fc.string()),
      TIDB_DATABASE: maybe(fc.string()),
      TOGETHER_API_KEY: maybe(fc.string()),
      CLOUDFLARE_ACCOUNT_ID: maybe(fc.string()),
      CLOUDFLARE_API_TOKEN: maybe(fc.string()),
      AZURE_OPENAI_API_KEY: maybe(fc.string()),
      AZURE_OPENAI_ENDPOINT: maybe(fc.string()),
      AZURE_OPENAI_DEPLOYMENT: maybe(fc.string()),
    },
    { requiredKeys: [] }
  );

  // Arbitrary unrelated keys to confirm the composer ignores noise.
  const noiseKeys = fc.dictionary(fc.string(), fc.string(), { maxKeys: 5 });

  return fc.tuple(knownKeys, noiseKeys).map(([known, noise]) => ({ ...noise, ...known }));
};

/** Generator for the subset of providers that have a stored secret. */
const presentProvidersArbitrary = (): fc.Arbitrary<string[]> =>
  fc.subarray([...PROVIDER_IDS]);

describe("setup status readiness is well-formed (Property 4)", () => {
  // Feature: productization-alpha, Property 4: Setup status readiness is well-formed
  it("returns exactly one valid readiness entry per category for any environment", async () => {
    await fc.assert(
      fc.asyncProperty(envArbitrary(), presentProvidersArbitrary(), async (env, presentProviders) => {
        const status = await computeSetupStatus(env, fakeSecretStore(presentProviders));

        // Exactly one entry per category (no missing categories, no duplicates).
        expect(status.categories).toHaveLength(ALL_CATEGORIES.length);
        const seen = status.categories.map((entry) => entry.category);
        expect(new Set(seen).size).toBe(ALL_CATEGORIES.length);
        expect([...seen].sort()).toEqual([...ALL_CATEGORIES].sort());

        // Each entry's status is exactly one member of the closed set.
        for (const entry of status.categories) {
          expect(VALID_STATUSES).toContain(entry.status);
        }
      }),
      { numRuns: 100 }
    );
  });
});
