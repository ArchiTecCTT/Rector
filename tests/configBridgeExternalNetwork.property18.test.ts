/**
 * Feature: cloud-capable-transition, Property 18: External selection constructs
 * providers with network enabled.
 *
 * Validates: Requirements 5.1
 *
 *   "WHERE a provider of any Provider_Kind is selected in External_Mode, THE
 *    Config_Bridge SHALL construct that provider with network access enabled."
 *
 * The `enableNetwork` flag is private on every {@link LLMProvider}, so the
 * property is observed *behaviorally*: a provider constructed with network
 * access enabled reaches its (injected) `fetch` when invoked, whereas a
 * provider built with network disabled throws a `NETWORK_DISABLED`
 * {@link ProviderError} *before* any fetch. This test drives the real
 * `buildConfiguredRouter` path in External_Mode (`enableNetwork: true`) for
 * every Provider_Kind, through deterministic doubles only — an in-memory
 * Provider_Config_Store and a fake {@link SecretStore} with an injected
 * counting `fetch`. There is ZERO real disk, network, or live provider access:
 * the injected `fetch` simply counts calls and returns a canned, schema-shaped
 * response, so the "construct with network enabled" guarantee is directly
 * observable without ever leaving the process.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { PROVIDER_KINDS, type ProviderConfigRecord, type ProviderKind } from "../src/providers/config";
import {
  createInMemoryProviderConfigStore,
  type ProviderConfigStore,
} from "../src/providers/configStore";
import { buildConfiguredRouter } from "../src/providers/configBridge";
import { ProviderError } from "../src/providers/llm";
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

/** Seed an in-memory store with a single record. */
async function seedStore(record: ProviderConfigRecord): Promise<ProviderConfigStore> {
  const store = createInMemoryProviderConfigStore();
  const result = await store.upsertProvider(record);
  expect(result.ok).toBe(true);
  return store;
}

/**
 * Build a schema-valid, *fully-configured* record for the given kind plus its
 * secret map, so the constructed provider passes `validateConfig()` and is a
 * selectable candidate for the shared `fast` route. Every kind supports `fast`
 * (together: cheap/fast/flagship/research; cloudflare: cheap/fast; azure:
 * fast/flagship; openai-compatible: cheap/fast/flagship/research), so a single
 * capability exercises all four kinds uniformly.
 */
function buildValidRecord(
  kind: ProviderKind,
  token: string,
  secret: string,
): { record: ProviderConfigRecord; secrets: Record<string, string> } {
  const secretRef = `secret:${kind}:${token}`;
  const base = {
    id: `${kind}:${token}`,
    kind,
    label: `Label ${token}`,
    secretRef,
    createdAt: FIXED_TS,
    updatedAt: FIXED_TS,
  } as const;
  const secrets = { [secretRef]: secret };

  switch (kind) {
    case "together":
      return { record: { ...base, baseUrl: `https://${token}.together.example/v1` }, secrets };
    case "cloudflare":
      return {
        record: { ...base, baseUrl: `https://${token}.cloudflare.example/client/v4`, cloudflare: { accountId: token } },
        secrets,
      };
    case "azure-openai":
      return {
        record: {
          ...base,
          baseUrl: `https://${token}.azure.example`,
          model: `deployment-${token}`,
          azure: { endpoint: `https://${token}.azure.example`, deployment: `deployment-${token}` },
        },
        secrets,
      };
    case "openai-compatible":
      return {
        record: { ...base, baseUrl: `https://${token}.proxy.example/v1`, model: `model-${token}` },
        secrets,
      };
  }
}

/**
 * A canned response that satisfies every provider's response parser
 * (`choices[*].message.content` for OpenAI-style kinds, `result.response` for
 * Cloudflare). Parsing success is incidental — the property only needs the
 * injected `fetch` to be *reached*, proving network access was enabled at
 * construction.
 */
function cannedResponse(): Response {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        result: { response: "ok" },
        success: true,
        model: "canned-model",
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    },
  } as unknown as Response;
}

const tokenArb = fc.integer({ min: 1, max: 1_000_000 }).map((n) => `t${n}`);
const secretArb = fc.string({ minLength: 8, maxLength: 64 }).filter((value) => value.trim().length >= 8);

describe("Config_Bridge — Property 18: external selection constructs providers with network enabled (Req 5.1)", () => {
  it("selects a network-enabled provider for every Provider_Kind in External_Mode", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...PROVIDER_KINDS),
        tokenArb,
        secretArb,
        async (kind, token, secret) => {
          const { record, secrets: secretMap } = buildValidRecord(kind, token, secret);
          const store = await seedStore(record);
          const secrets = createFakeSecretStore(secretMap);

          let fetchCount = 0;
          const fetchImpl = (async () => {
            fetchCount += 1;
            return cannedResponse();
          }) as unknown as typeof fetch;

          // External_Mode with network access requested (the live external path).
          const router = await buildConfiguredRouter({
            store,
            secrets,
            baseEnv: {}, // isolate from any ambient process.env credentials
            enableNetwork: true,
            fetchImpl,
          });

          // The configured provider of this kind must win selection over the
          // provider-free fallback — otherwise there is nothing to construct
          // with network enabled.
          const selection = router.select({ capability: "fast" });
          expect(selection.provider.metadata.id).not.toBe("fake");

          // The selected provider must have been constructed with network
          // enabled: invoking it reaches the injected fetch instead of
          // throwing NETWORK_DISABLED before any network call.
          let networkDisabled = false;
          try {
            await selection.provider.invoke({
              messages: [{ role: "user", content: "hi" }],
              modelRoute: selection.modelRoute,
              model: selection.model,
            });
          } catch (error) {
            if (error instanceof ProviderError && error.code === "NETWORK_DISABLED") {
              networkDisabled = true;
            }
            // Any other error (e.g. a response-parse error) still proves the
            // network boundary was reached, which is what the property asserts.
          }

          expect(networkDisabled).toBe(false);
          expect(fetchCount).toBeGreaterThanOrEqual(1);
        },
      ),
      { numRuns: 100 },
    );
  });
});
