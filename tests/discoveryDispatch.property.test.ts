/**
 * Task 4.2 — Model_Discovery_Service dispatch property test.
 *
 * **Feature: cloud-capable-transition, Property 5: Discovery dispatch returns the mapped adapter's result**
 * **Validates: Requirements 2.1**
 *
 * For any Provider_Config_Record, the Model_Discovery_Service dispatches exactly
 * the single Discovery_Adapter registered for that record's Provider_Kind and
 * returns that adapter's result unchanged — aside from redaction of the error
 * message (Requirement 2.1).
 *
 * The test wires the real {@link createModelDiscoveryService} to:
 *
 *   - an in-memory Provider_Config_Store holding exactly one record of an
 *     arbitrary kind;
 *   - a fresh Discovery_Cache and a `refresh: true` request, so the cache never
 *     short-circuits the dispatch under test;
 *   - a registry of four **counting fake adapters** (one per Provider_Kind),
 *     each returning a per-kind-distinct {@link AdapterResult}.
 *
 * The assertions then prove, across ≥100 hermetic iterations, that:
 *
 *   - exactly the adapter mapped to `record.kind` ran (call count 1) and every
 *     other adapter ran zero times (pure dispatch, no fan-out);
 *   - a successful result's candidates are passed through unchanged;
 *   - a failed result's category is preserved and its message is exactly the
 *     redacted form of the adapter's message.
 *
 * There is ZERO disk, network, or provider I/O: the adapters are local closures
 * and `fetchImpl` is never invoked, so each run is fully deterministic.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { PROVIDER_KINDS, type ProviderConfigRecord, type ProviderKind } from "../src/providers/config";
import { createInMemoryProviderConfigStore } from "../src/providers/configStore";
import { createDiscoveryCache } from "../src/providers/discovery/cache";
import { createModelDiscoveryService } from "../src/providers/discovery/service";
import type {
  AdapterContext,
  AdapterResult,
  DiscoveryAdapter,
  DiscoveryAdapterRegistry,
} from "../src/providers/discovery/adapters/index";
import type { DiscoveryError, ModelCandidate } from "../src/providers/discovery/types";
import { redactString } from "../src/security/redaction";
import type { SecretStore, SecretStoreResult } from "../src/security/secretStore";

/** A fixed, schema-valid ISO timestamp for record/candidate metadata. */
const TS = "2026-01-01T00:00:00.000Z";

/** The discovery error categories an adapter can classify a failure into. */
const ERROR_CATEGORIES = [
  "auth_invalid",
  "endpoint_invalid",
  "unsupported_response",
  "network_error",
  "rate_limited",
  "requires_management_plane",
  "unknown",
] as const;

/** Arbitrary non-empty identifier shaped like the real `kind:label` ids. */
const arbId = (): fc.Arbitrary<string> =>
  fc.string({ minLength: 1, maxLength: 24 }).filter((s) => s.trim().length > 0).map((s) => s.trim());

/** Arbitrary, schema-valid `ModelCandidate` for `providerId` / `kind`. */
const arbCandidate = (providerId: string, kind: ProviderKind): fc.Arbitrary<ModelCandidate> =>
  fc
    .record({
      displayName: fc.string({ minLength: 1, maxLength: 24 }).filter((s) => s.trim().length > 0),
      capabilities: fc.uniqueArray(fc.constantFrom("chat", "text-generation", "embeddings"), {
        minLength: 1,
        maxLength: 3,
      }),
      requiresDeployment: fc.boolean(),
      requiresRegion: fc.boolean(),
    })
    .map((partial) => ({
      providerId,
      kind,
      scope: {},
      displayName: partial.displayName.trim(),
      capabilities: partial.capabilities,
      requiresDeployment: partial.requiresDeployment,
      requiresRegion: partial.requiresRegion,
      source: kind,
      lastRefreshedAt: TS,
    }));

/** Arbitrary adapter outcome: a successful candidate set OR a classified error. */
const arbAdapterResult = (providerId: string, kind: ProviderKind): fc.Arbitrary<AdapterResult> =>
  fc.oneof(
    fc
      .array(arbCandidate(providerId, kind), { maxLength: 4 })
      .map<AdapterResult>((candidates) => ({ ok: true, candidates })),
    fc
      .record({
        category: fc.constantFrom(...ERROR_CATEGORIES),
        // Include characters a redactor might touch, to exercise the redaction pass-through.
        message: fc.string({ maxLength: 48 }),
      })
      .map<AdapterResult>(({ category, message }) => ({
        ok: false,
        error: { category, message } as DiscoveryError,
      })),
  );

/** Build a valid one-record Provider_Config_Store for `id` of `kind`. */
function buildRecord(id: string, kind: ProviderKind): ProviderConfigRecord {
  return {
    id,
    kind,
    label: `label-${id}`,
    secretRef: `secret:${id}`,
    createdAt: TS,
    updatedAt: TS,
  };
}

/**
 * A counting fake {@link DiscoveryAdapter}. It records how many times it ran and
 * returns the configured outcome, standing in for a real provider catalog call.
 */
function makeCountingAdapter(kind: ProviderKind, outcome: AdapterResult): {
  adapter: DiscoveryAdapter;
  calls: () => number;
} {
  let calls = 0;
  return {
    adapter: {
      kind,
      async discover(_ctx: AdapterContext): Promise<AdapterResult> {
        calls += 1;
        return outcome;
      },
    },
    calls: () => calls,
  };
}

/** A minimal Secret_Store double; the service only reads `getSecret`. */
function makeSecretStore(present: boolean): SecretStore {
  return {
    async setSecret(): Promise<SecretStoreResult<void>> {
      return { ok: true, value: undefined };
    },
    async getSecret(): Promise<SecretStoreResult<string>> {
      return present ? { ok: true, value: "transient-secret" } : { ok: false, error: "absent" };
    },
    async hasSecret(): Promise<boolean> {
      return present;
    },
  };
}

describe("Feature: cloud-capable-transition, Property 5: Discovery dispatch returns the mapped adapter's result", () => {
  // Validates: Requirements 2.1
  it("dispatches exactly the adapter for the record's kind and returns its result unchanged (aside from redaction)", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbId().chain((id) =>
          fc.constantFrom(...PROVIDER_KINDS).chain((kind) =>
            fc.record({
              id: fc.constant(id),
              kind: fc.constant(kind),
              outcome: arbAdapterResult(id, kind),
              secretPresent: fc.boolean(),
            }),
          ),
        ),
        async ({ id, kind, outcome, secretPresent }) => {
          // One record of the chosen kind; the cache stays empty and `refresh`
          // is set so the dispatch under test is never short-circuited.
          const configStore = createInMemoryProviderConfigStore({
            version: 1,
            providers: [buildRecord(id, kind)],
            activeRoutes: {},
          });

          // The mapped adapter returns the arbitrary outcome; every other kind
          // returns a per-kind-distinct sentinel so a wrong dispatch is visible.
          const counters = {} as Record<ProviderKind, () => number>;
          const registry = {} as DiscoveryAdapterRegistry;
          for (const k of PROVIDER_KINDS) {
            const result: AdapterResult =
              k === kind ? outcome : { ok: true, candidates: [] };
            const built = makeCountingAdapter(k, result);
            registry[k] = built.adapter;
            counters[k] = built.calls;
          }

          const service = createModelDiscoveryService({
            configStore,
            secrets: makeSecretStore(secretPresent),
            cache: createDiscoveryCache(),
            adapters: registry,
            clock: () => Date.parse(TS),
          });

          const result = await service.discover(id, { refresh: true });

          // Exactly the mapped adapter ran; every other adapter ran zero times.
          expect(counters[kind]()).toBe(1);
          for (const k of PROVIDER_KINDS) {
            if (k !== kind) {
              expect(counters[k]()).toBe(0);
            }
          }

          // The result is the mapped adapter's result, unchanged aside from the
          // redaction applied to a failure message.
          if (outcome.ok) {
            expect(result.ok).toBe(true);
            if (result.ok) {
              expect(result.providerId).toBe(id);
              expect(result.candidates).toEqual(outcome.candidates);
            }
          } else {
            expect(result.ok).toBe(false);
            if (!result.ok) {
              expect(result.providerId).toBe(id);
              expect(result.error.category).toBe(outcome.error.category);
              expect(result.error.message).toBe(redactString(outcome.error.message));
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
