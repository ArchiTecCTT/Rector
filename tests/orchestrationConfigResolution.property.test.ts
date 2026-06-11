/**
 * Task 2.2 — Configured-provider resolution property test.
 *
 * **Feature: cloud-capable-transition, Property 1: Configured-provider resolution is the union of env and stores**
 * **Validates: Requirements 1.1, 1.2, 1.3**
 *
 * Property 1: For any environment map and any Provider_Config_Store +
 * Secret_Store contents, resolving the Orchestration_Config in external mode
 * yields a configured-provider list that contains a provider id **iff** all of
 * that provider's required env keys are present and non-empty in the
 * environment (Requirement 1.3, env branch), **or** a Provider_Config_Record
 * exists whose required secret refs are all reported present by the Secret_Store
 * (Requirement 1.3, store branch). The resolver awaits both store reads before
 * returning (Requirements 1.1, 1.2).
 *
 * The test drives generation and the independent expectation from the real
 * {@link PROVIDER_DESCRIPTORS} table (the contract), then asserts the resolver's
 * union — including dedup of an env-configured preset and a store record that
 * share an id — equals that expectation.
 *
 * Hermeticity: the Provider_Config_Store is a local fake returning generated
 * state, and the Secret_Store is a presence-only double whose `getSecret` throws
 * — proving the resolver decides satisfaction purely from `hasSecret` presence
 * booleans and never reads a secret VALUE (Requirement 1.2). ZERO disk, network,
 * or clock I/O, so every run is deterministic.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  PROVIDER_DESCRIPTORS,
  resolveOrchestrationConfig,
} from "../src/providers/orchestrationConfig";
import { PROVIDER_KINDS, type ProviderConfigRecord } from "../src/providers/config";
import { emptyProviderConfigState, PROVIDER_CONFIG_VERSION } from "../src/providers/config";
import type { ProviderConfigStore } from "../src/providers/configStore";
import type { SecretStore } from "../src/security/secretStore";

// A fixed, schema-valid ISO timestamp for record metadata. The resolution path
// is independent of the actual timestamp, so it can stay constant.
const TS = "2026-01-01T00:00:00.000Z";

// Every env key any descriptor requires; the env generator fills exactly these.
const ENV_KEYS: readonly string[] = PROVIDER_DESCRIPTORS.flatMap(
  (descriptor) => descriptor.requiredEnvKeys,
);

/** Mirrors the resolver's `isNonEmpty`: defined and not blank/whitespace-only. */
function isNonEmpty(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

/** An arbitrary non-empty, trimmed string for ids/labels/refs. */
const arbNonEmpty = (max: number): fc.Arbitrary<string> =>
  fc
    .string({ minLength: 1, maxLength: max })
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

/**
 * An arbitrary env-key value: absent, empty, whitespace-only, or non-empty — so
 * the "all required keys present & non-empty" condition is exercised across
 * fully-, partially-, and un-satisfied providers.
 */
const arbEnvValue: fc.Arbitrary<string | undefined> = fc.oneof(
  fc.constant(undefined),
  fc.constant(""),
  fc.constant("   "),
  arbNonEmpty(8),
);

/** An env map covering every provider env key (ORCHESTRATOR_MODE added later). */
const arbEnv: fc.Arbitrary<Record<string, string | undefined>> = fc.record(
  Object.fromEntries(ENV_KEYS.map((key) => [key, arbEnvValue])),
);

/** Seed for one stored record plus whether its secret is reported present. */
interface RecordSeed {
  id: string;
  kind: (typeof PROVIDER_KINDS)[number];
  label: string;
  baseRef: string;
  present: boolean;
}

const arbRecordSeeds: fc.Arbitrary<RecordSeed[]> = fc.array(
  fc.record({
    id: arbNonEmpty(16),
    kind: fc.constantFrom(...PROVIDER_KINDS),
    label: arbNonEmpty(12),
    baseRef: arbNonEmpty(12),
    present: fc.boolean(),
  }),
  { maxLength: 6 },
);

/** A stored record paired with the presence decision for its secret ref. */
interface PreparedRecord {
  record: ProviderConfigRecord;
  present: boolean;
}

/**
 * Materialize seeds into records with a UNIQUE `secretRef` per record (suffixed
 * by index) so the Secret_Store presence decision is unambiguous even when two
 * seeds share a base ref or id.
 */
function prepareRecords(seeds: RecordSeed[]): PreparedRecord[] {
  return seeds.map((seed, index) => ({
    record: {
      id: seed.id,
      kind: seed.kind,
      label: seed.label,
      secretRef: `${seed.baseRef}#${index}`,
      createdAt: TS,
      updatedAt: TS,
    },
    present: seed.present,
  }));
}

/**
 * A local Provider_Config_Store double returning the generated records. Only
 * `getState` is consulted by the resolver; the mutators are inert.
 */
function fakeConfigStore(records: PreparedRecord[]): ProviderConfigStore {
  return {
    async getState() {
      return {
        ...emptyProviderConfigState(),
        version: PROVIDER_CONFIG_VERSION,
        providers: records.map((entry) => entry.record),
        activeRoutes: {},
      };
    },
    async upsertProvider(rec) {
      return { ok: true, value: rec };
    },
    async removeProvider() {
      return { ok: true, value: undefined };
    },
    async setActiveRoute() {
      return { ok: true, value: undefined };
    },
  };
}

/**
 * A presence-only Secret_Store double. `hasSecret` answers from `presentRefs`;
 * `getSecret` throws so any attempt to read a secret VALUE fails the test —
 * locking in the presence-only contract (Requirement 1.2).
 */
function fakeSecretStore(presentRefs: ReadonlySet<string>): SecretStore {
  return {
    async setSecret() {
      return { ok: true, value: undefined };
    },
    async getSecret() {
      throw new Error("getSecret must not be called: resolution is presence-only");
    },
    async hasSecret(ref: string) {
      return presentRefs.has(ref);
    },
  };
}

describe("Feature: cloud-capable-transition, Property 1: Configured-provider resolution is the union of env and stores", () => {
  // Validates: Requirements 1.1, 1.2, 1.3
  it("resolves the configured-provider list as the union of env-satisfied providers and store-satisfied records", async () => {
    await fc.assert(
      fc.asyncProperty(arbEnv, arbRecordSeeds, async (rawEnv, seeds) => {
        const env = { ...rawEnv, ORCHESTRATOR_MODE: "external" };
        const records = prepareRecords(seeds);
        const presentRefs = new Set(
          records.filter((entry) => entry.present).map((entry) => entry.record.secretRef),
        );

        const result = await resolveOrchestrationConfig({
          env,
          providerConfigStore: fakeConfigStore(records),
          secretStore: fakeSecretStore(presentRefs),
        });

        expect(result.mode).toBe("external");

        // Independently compute the expected union from the same descriptor
        // contract: env-satisfied descriptor ids ∪ store-satisfied record ids.
        const expected = new Set<string>();
        for (const descriptor of PROVIDER_DESCRIPTORS) {
          if (descriptor.requiredEnvKeys.every((key) => isNonEmpty(env[key]))) {
            expected.add(descriptor.envProviderId);
          }
        }
        for (const entry of records) {
          // Each record binds a single, unique secret ref, so "present" is
          // exactly "all required secret refs reported present".
          if (entry.present) expected.add(entry.record.id);
        }

        const actual = new Set(result.configuredProviders);
        // iff in both directions: the sets are equal.
        expect(actual).toEqual(expected);
        // The list is deduplicated (a shared env/record id appears once).
        expect(result.configuredProviders.length).toBe(actual.size);
      }),
      { numRuns: 200 },
    );
  });
});
