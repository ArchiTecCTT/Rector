/**
 * Feature: cloud-capable-transition, Property 19: A valid designated route
 * resolves to that provider and model.
 *
 * Validates: Requirements 5.2, 5.3
 *
 *   5.2 "WHEN the Active_Route_Map designates a Provider_Config_Record for the
 *        `flagship` role, that record exists with its required credentials and
 *        endpoint coordinates present in the stores, and that record designates
 *        a non-empty model identifier for the `flagship` role, THE Model_Router
 *        SHALL route `flagship`-tier requests to the designated model on that
 *        provider."
 *   5.3 "WHEN the Active_Route_Map designates a Provider_Config_Record for the
 *        `slm` role ... THE Model_Router SHALL route `slm`-tier requests to the
 *        designated model on that provider."
 *
 * The property is observed through the real `buildConfiguredRouter` selection
 * path in External_Mode. Several valid `openai-compatible` records are
 * configured (each with a distinct, recognizable model id so a designated
 * provider is uniquely identifiable), one is designated for the role under
 * test via the Active_Route_Map, and a request for that role's capability is
 * selected. The selection MUST resolve to the designated record's provider
 * (proven by the secret-free `active route <role> -> <recordId>` substitution
 * marker) and to that record's designated model id.
 *
 * Hermetic: an in-memory Provider_Config_Store, a fake SecretStore, and an
 * injected `fetch` that throws if ever reached (selection performs no network
 * call). ZERO real disk, network, or live provider access.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import type { ProviderConfigRecord, ProviderModelRole } from "../src/providers/config";
import {
  createInMemoryProviderConfigStore,
  type ProviderConfigStore,
} from "../src/providers/configStore";
import { buildConfiguredRouter } from "../src/providers/configBridge";
import type { ModelRoute } from "../src/providers/llm";
import type { SecretStore, SecretStoreResult } from "../src/security/secretStore";

const FIXED_TS = "2026-01-01T00:00:00.000Z";

/** Deterministic in-memory {@link SecretStore} double — no disk, no network. */
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

/** A `fetch` that must never be reached during pure route selection. */
const exploding = (async () => {
  throw new Error("network must not be reached during route selection");
}) as unknown as typeof fetch;

/**
 * Build a fully-configured, schema-valid `openai-compatible` record (its secret
 * present in the Secret_Store) whose designated model id is `model-<token>`.
 * The OpenAI-compatible provider exposes that model on every route, so it is
 * the designated model for both the `flagship` and `slm` roles.
 */
function buildRecord(token: string): { record: ProviderConfigRecord; secretRef: string; secret: string; model: string } {
  const secretRef = `secret:oai:${token}`;
  const secret = `key-${token}-abcdefgh`;
  const model = `model-${token}`;
  const record: ProviderConfigRecord = {
    id: `openai-compatible:${token}`,
    kind: "openai-compatible",
    label: `Label ${token}`,
    baseUrl: `https://${token}.proxy.example/v1`,
    model,
    secretRef,
    createdAt: FIXED_TS,
    updatedAt: FIXED_TS,
  };
  return { record, secretRef, secret, model };
}

/** Seed an in-memory store with all records and designate one for the role. */
async function seedStore(
  records: ProviderConfigRecord[],
  role: ProviderModelRole,
  designatedId: string,
): Promise<ProviderConfigStore> {
  const store = createInMemoryProviderConfigStore();
  for (const record of records) {
    const result = await store.upsertProvider(record);
    expect(result.ok).toBe(true);
  }
  const routed = await store.setActiveRoute(role, designatedId);
  expect(routed.ok).toBe(true);
  return store;
}

/** The router capability that exercises each Active_Route_Map role. */
const CAPABILITY_FOR_ROLE: Record<ProviderModelRole, ModelRoute> = {
  flagship: "flagship",
  slm: "fast",
};

const roleArb = fc.constantFrom<ProviderModelRole>("flagship", "slm");
// 1–3 distinct provider tokens so the designated provider is uniquely
// identifiable by its model id among the configured candidates.
const tokensArb = fc.uniqueArray(fc.integer({ min: 1, max: 1_000_000 }).map((n) => `t${n}`), {
  minLength: 1,
  maxLength: 3,
});

describe("Config_Bridge — Property 19: a valid designated route resolves to that provider and model (Req 5.2, 5.3)", () => {
  it("routes a designated role to the designated provider's model in External_Mode", async () => {
    await fc.assert(
      fc.asyncProperty(roleArb, tokensArb, fc.nat(), async (role, tokens, pick) => {
        const built = tokens.map(buildRecord);
        const records = built.map((entry) => entry.record);
        const secretMap = Object.fromEntries(built.map((entry) => [entry.secretRef, entry.secret]));

        const designated = built[pick % built.length];
        const store = await seedStore(records, role, designated.record.id);
        const secrets = createFakeSecretStore(secretMap);

        const router = await buildConfiguredRouter({
          store,
          secrets,
          baseEnv: {}, // isolate from any ambient process.env credentials
          enableNetwork: true,
          fetchImpl: exploding,
        });

        const selection = router.select({ capability: CAPABILITY_FOR_ROLE[role] });

        // Resolves to the designated provider: the bridge records the
        // secret-free substitution-free marker naming exactly the role and the
        // designated record id.
        expect(selection.reason).toBe(`active route ${role} -> ${designated.record.id}`);
        // Resolves to that provider's designated model on the requested tier.
        expect(selection.provider.metadata.id).toBe("openai-compatible");
        expect(selection.model).toBe(designated.model);
        expect(selection.modelRoute).toBe(CAPABILITY_FOR_ROLE[role]);
        // The marker must never leak the secret value.
        expect(selection.reason).not.toContain(designated.secret);
      }),
      { numRuns: 100 },
    );
  });
});
