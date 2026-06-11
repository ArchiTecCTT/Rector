/**
 * Task 2.3 — Default-local mode resolution property test.
 *
 * **Feature: cloud-capable-transition, Property 2: Empty or whitespace mode resolves to local**
 * **Validates: Requirements 9.5**
 *
 * Property 2: *For any* `ORCHESTRATOR_MODE` value that is unset, empty, or
 * composed entirely of whitespace, the resolved Orchestrator_Mode is `local`
 * with an empty configured-provider list (Requirement 9.5).
 *
 * The resolver short-circuits the local baseline before any store read: a blank
 * mode resolves to `{ mode: "local", configuredProviders: [] }` regardless of
 * what the environment or the stores would otherwise contribute. This test
 * proves that invariant across a wide blank-mode space while the environment AND
 * both stores are fully populated with credentials that *would* mark providers
 * configured in `external` mode — so an empty list is structural, not
 * coincidental.
 *
 * To make the "no store read" guarantee observable (and to keep the test
 * hermetic), the Provider_Config_Store and Secret_Store are counting doubles
 * that perform zero disk/network/clock I/O: the test asserts the resolved list
 * is empty AND that neither store was ever consulted.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  PROVIDER_DESCRIPTORS,
  resolveOrchestrationConfig,
  type ResolveOrchestrationDeps,
} from "../src/providers/orchestrationConfig";
import {
  ProviderConfigRecordSchema,
  emptyProviderConfigState,
  type ProviderConfigRecord,
  type ProviderConfigState,
} from "../src/providers/config";
import type { ProviderConfigStore } from "../src/providers/configStore";
import type { SecretStore } from "../src/security/secretStore";

const TS = "2026-01-01T00:00:00.000Z";

/** ASCII whitespace characters that `String.prototype.trim` definitely strips. */
const WHITESPACE_CHARS = [" ", "\t", "\n", "\r", "\f", "\v"] as const;

/** A non-empty string composed solely of whitespace characters. */
const arbWhitespaceOnly: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...WHITESPACE_CHARS), { minLength: 1, maxLength: 12 })
  .map((chars) => chars.join(""));

/** Unset (undefined), empty, or whitespace-only — the full "blank mode" space. */
const arbBlankMode: fc.Arbitrary<string | undefined> = fc.oneof(
  fc.constant<string | undefined>(undefined),
  fc.constant<string | undefined>(""),
  arbWhitespaceOnly,
);

/** Every provider env key the resolver inspects in external mode. */
const ALL_PROVIDER_ENV_KEYS: readonly string[] = PROVIDER_DESCRIPTORS.flatMap(
  (descriptor) => descriptor.requiredEnvKeys,
);

/**
 * An environment that, in `external` mode, would mark providers configured: a
 * blank `ORCHESTRATOR_MODE`, every provider credential present, plus arbitrary
 * unrelated keys. The blank mode must still win and yield `local` with an empty
 * provider list.
 */
const arbPopulatedEnv: fc.Arbitrary<Record<string, string | undefined>> = fc
  .record({
    mode: arbBlankMode,
    // Independently decide whether each provider env key is populated, so the
    // generator covers "no providers", "some providers", and "all providers"
    // configured — all of which must be ignored under a blank mode.
    populated: fc.dictionary(
      fc.constantFrom(...ALL_PROVIDER_ENV_KEYS),
      fc.string({ minLength: 1, maxLength: 24 }).filter((v) => v.trim().length > 0),
    ),
    extras: fc.dictionary(
      fc.string({ minLength: 1, maxLength: 8 }),
      fc.string({ maxLength: 16 }),
    ),
  })
  .map(({ mode, populated, extras }) => {
    const env: Record<string, string | undefined> = { ...extras, ...populated };
    // Apply ORCHESTRATOR_MODE last; `undefined` means "unset".
    if (mode === undefined) {
      delete env.ORCHESTRATOR_MODE;
    } else {
      env.ORCHESTRATOR_MODE = mode;
    }
    return env;
  });

/** A schema-valid Provider_Config_Record whose secrets a double reports present. */
function seededRecord(): ProviderConfigRecord {
  return ProviderConfigRecordSchema.parse({
    id: "together:seed",
    kind: "together",
    label: "seed provider",
    baseUrl: "https://seed.test",
    secretRef: "together:seed",
    createdAt: TS,
    updatedAt: TS,
  });
}

interface StoreCounters {
  configReads: number;
  secretReads: number;
}

/**
 * Build resolver deps backed by counting store doubles that perform zero I/O.
 * The Provider_Config_Store reports a fully-configured record and the
 * Secret_Store reports every secret present, so any store read would contribute
 * a provider — making an empty result meaningful.
 */
function makeDeps(
  env: Record<string, string | undefined>,
  counters: StoreCounters,
): ResolveOrchestrationDeps {
  const state: ProviderConfigState = {
    ...emptyProviderConfigState(),
    providers: [seededRecord()],
  };

  const providerConfigStore: ProviderConfigStore = {
    async getState() {
      counters.configReads += 1;
      return structuredClone(state);
    },
    async upsertProvider() {
      throw new Error("mutation must not be invoked during resolution");
    },
    async removeProvider() {
      throw new Error("mutation must not be invoked during resolution");
    },
    async setActiveRoute() {
      throw new Error("mutation must not be invoked during resolution");
    },
  };

  const secretStore: SecretStore = {
    async setSecret() {
      throw new Error("setSecret must not be invoked during resolution");
    },
    async getSecret() {
      throw new Error("getSecret (secret VALUE) must never be invoked during resolution");
    },
    async hasSecret() {
      counters.secretReads += 1;
      return true;
    },
  };

  return {
    env,
    providerConfigStore,
    secretStore,
    // A no-op logger keeps the test free of console noise and stays hermetic.
    logger: { error() {} },
  };
}

describe("Feature: cloud-capable-transition, Property 2: Empty or whitespace mode resolves to local", () => {
  // Validates: Requirements 9.5
  it("resolves any unset/empty/whitespace ORCHESTRATOR_MODE to local with an empty provider list", async () => {
    await fc.assert(
      fc.asyncProperty(arbPopulatedEnv, async (env) => {
        const counters: StoreCounters = { configReads: 0, secretReads: 0 };
        const config = await resolveOrchestrationConfig(makeDeps(env, counters));

        // Core invariant (Requirement 9.5): blank mode resolves to local with an
        // empty configured-provider list.
        expect(config.mode).toBe("local");
        expect(config.configuredProviders).toEqual([]);

        // The empty list is structural: local mode never consults either store,
        // even though both would otherwise contribute a configured provider.
        expect(counters.configReads).toBe(0);
        expect(counters.secretReads).toBe(0);
      }),
      { numRuns: 200 },
    );
  });
});
