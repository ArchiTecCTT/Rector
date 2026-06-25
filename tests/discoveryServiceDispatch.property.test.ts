/**
 * Task 8.2 — Model_Discovery_Service adapter-dispatch property test.
 *
 * **Feature: byok-chat-ux-and-model-discovery, Property 7: Discovery dispatches to the adapter for the provider kind**
 * **Validates: Requirements 10.2**
 *
 * Property 7: For any configured `ProviderConfigRecord`, the
 * Model_Discovery_Service SHALL invoke exactly the Discovery_Adapter registered
 * for that record's `kind` — and no other adapter in the registry.
 *
 * The test seeds an in-memory `Provider_Config_Store` with a single arbitrary
 * record, builds a registry of one counting spy adapter per `ProviderKind`, and
 * asserts that a single `discover(record.id)` call invokes only the adapter
 * keyed by `record.kind` (exactly once), leaving every other adapter untouched.
 * It also confirms the dispatched adapter received the record it was selected
 * for. There is ZERO disk, network, or provider I/O: the config store and
 * secret store are in-memory doubles, the cache is the real in-memory cache, and
 * the adapters are local closures — so every run is fully deterministic and
 * hermetic (Requirement 29).
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { createModelDiscoveryService } from "../src/providers/discovery/service";
import { createDiscoveryCache } from "../src/providers/discovery/cache";
import type {
  AdapterContext,
  AdapterResult,
  DiscoveryAdapter,
  DiscoveryAdapterRegistry,
} from "../src/providers/discovery/adapters";
import { createInMemoryProviderConfigStore } from "../src/providers/configStore";
import { PROVIDER_KINDS, type ProviderConfigRecord, type ProviderKind } from "../src/providers/config";
import { PROVIDER_CONFIG_VERSION } from "../src/providers/config";
import type { SecretStore } from "../src/security/secretStore";

// A fixed, schema-valid ISO timestamp for record metadata. The dispatch path is
// independent of the actual timestamp, so it can stay constant.
const TS = "2026-01-01T00:00:00.000Z";

/** Arbitrary non-empty, trimmed string for ids/labels/refs. */
const arbNonEmpty = (max: number): fc.Arbitrary<string> =>
  fc
    .string({ minLength: 1, maxLength: max })
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

/**
 * Arbitrary, schema-valid {@link ProviderConfigRecord}. The `kind` is drawn from
 * the real {@link PROVIDER_KINDS}; only the fields the dispatch path reads
 * (`id`, `kind`, `secretRef`) need to vary, the rest are well-formed constants.
 */
const arbRecord: fc.Arbitrary<ProviderConfigRecord> = fc
  .record({
    id: arbNonEmpty(24),
    kind: fc.constantFrom(...PROVIDER_KINDS),
    label: arbNonEmpty(24),
    secretRef: arbNonEmpty(24),
  })
  .map(({ id, kind, label, secretRef }) => ({
    id,
    kind,
    label,
    secretRef,
    createdAt: TS,
    updatedAt: TS,
  }));

/**
 * A counting spy adapter for `kind`. It records every invocation and the last
 * context it received, then returns an empty successful result so the service
 * completes normally.
 */
interface SpyAdapter {
  adapter: DiscoveryAdapter;
  calls: () => number;
  lastContext: () => AdapterContext | undefined;
}

function spyAdapter(kind: ProviderKind): SpyAdapter {
  let calls = 0;
  let lastContext: AdapterContext | undefined;
  return {
    adapter: {
      kind,
      async discover(ctx: AdapterContext): Promise<AdapterResult> {
        calls += 1;
        lastContext = ctx;
        return { ok: true, candidates: [] };
      },
    },
    calls: () => calls,
    lastContext: () => lastContext,
  };
}

/** Build a registry of one spy adapter per provider kind. */
function buildRegistry(): {
  registry: DiscoveryAdapterRegistry;
  spies: Record<ProviderKind, SpyAdapter>;
} {
  const spies = {} as Record<ProviderKind, SpyAdapter>;
  const registry = {} as DiscoveryAdapterRegistry;
  for (const kind of PROVIDER_KINDS) {
    const spy = spyAdapter(kind);
    spies[kind] = spy;
    registry[kind] = spy.adapter;
  }
  return { registry, spies };
}

/**
 * A minimal in-memory {@link SecretStore} double. `getSecret` always succeeds so
 * the service proceeds to dispatch; presence is reported false (irrelevant to
 * dispatch). No value derived from this ever leaves the test.
 */
function inMemorySecretStore(): SecretStore {
  return {
    async setSecret() {
      return { ok: true, value: undefined };
    },
    async getSecret() {
      return { ok: true, value: "transient-secret" };
    },
    async hasSecret() {
      return false;
    },
  };
}

describe("Feature: byok-chat-ux-and-model-discovery, Property 7: Discovery dispatches to the adapter for the provider kind", () => {
  // Validates: Requirements 10.2
  it("invokes exactly the adapter registered for the record's kind, and no other", async () => {
    await fc.assert(
      fc.asyncProperty(arbRecord, async (record) => {
        const configStore = createInMemoryProviderConfigStore({
          version: PROVIDER_CONFIG_VERSION,
          providers: [record],
          activeRoutes: {},
        });
        const { registry, spies } = buildRegistry();
        const service = createModelDiscoveryService({
          configStore,
          secrets: inMemorySecretStore(),
          cache: createDiscoveryCache(),
          adapters: registry,
          clock: () => Date.parse(TS),
        });

        const result = await service.discover(record.id);

        // The result is for the requested provider and completed successfully.
        expect(result.providerId).toBe(record.id);
        expect(result.ok).toBe(true);

        // The adapter for the record's kind was invoked exactly once...
        expect(spies[record.kind].calls()).toBe(1);
        // ...and it received the very record it was selected for (Req 10.2).
        expect(spies[record.kind].lastContext()?.record.id).toBe(record.id);
        expect(spies[record.kind].lastContext()?.record.kind).toBe(record.kind);

        // Every other adapter in the registry stayed untouched.
        for (const kind of PROVIDER_KINDS) {
          if (kind === record.kind) continue;
          expect(spies[kind].calls()).toBe(0);
        }
      }),
      { numRuns: 200 },
    );
  });

  // Validates: Requirements 10.2
  it("dispatches by kind even when several providers of different kinds are configured", async () => {
    await fc.assert(
      fc.asyncProperty(arbRecord, async (target) => {
        // Configure one provider of EVERY kind, each with a distinct id, so the
        // service must select purely by the requested record's kind. The target
        // record fixes which provider id we discover.
        const providers: ProviderConfigRecord[] = PROVIDER_KINDS.map((kind, index) => ({
          id: kind === target.kind ? target.id : `${target.id}-${index}-${kind}`,
          kind,
          label: `${target.label}-${kind}`,
          secretRef: `${target.secretRef}-${kind}`,
          createdAt: TS,
          updatedAt: TS,
        }));

        const configStore = createInMemoryProviderConfigStore({
          version: PROVIDER_CONFIG_VERSION,
          providers,
          activeRoutes: {},
        });
        const { registry, spies } = buildRegistry();
        const service = createModelDiscoveryService({
          configStore,
          secrets: inMemorySecretStore(),
          cache: createDiscoveryCache(),
          adapters: registry,
          clock: () => Date.parse(TS),
        });

        await service.discover(target.id);

        // Only the adapter for the target record's kind ran, exactly once.
        expect(spies[target.kind].calls()).toBe(1);
        for (const kind of PROVIDER_KINDS) {
          if (kind === target.kind) continue;
          expect(spies[kind].calls()).toBe(0);
        }
      }),
      { numRuns: 200 },
    );
  });
});
