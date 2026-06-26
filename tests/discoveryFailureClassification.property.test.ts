/**
 * Task 8.4 — Model_Discovery_Service failure-classification property test.
 *
 * **Feature: byok-chat-ux-and-model-discovery, Property 12: Failures yield a classified category, never a raw body**
 * **Validates: Requirements 14.3, 17.3, 18.1, 23.1, 26.2**
 *
 * Property 12: For ANY discovery failure — a non-2xx provider response, a
 * non-JSON body, an unrecognizable payload, or a transport throw — the
 * Model_Discovery_Service SHALL return a classified `DiscoveryError` whose
 * `category` is one of the known {@link DiscoveryErrorCategorySchema} values and
 * whose `message` has been routed through the Redaction_Layer. The raw provider
 * response body and the provider secret SHALL NEVER survive into the returned
 * result (Req 14.3, 17.3, 18.1).
 *
 * Two complementary facets are exercised, both end-to-end through
 * {@link createModelDiscoveryService}:
 *
 *  1. **Real adapters + mocked `fetch`.** Every shipped adapter (Together,
 *     Cloudflare, Azure OpenAI, OpenAI-compatible) is wired through the service
 *     against a mocked `fetch` that returns arbitrary failure responses whose
 *     bodies embed a unique raw-body sentinel and the provider secret. The
 *     adapters classify each failure to a fixed, secret-free message, so neither
 *     sentinel ever appears in the result — proving raw bodies are never echoed
 *     (Req 14.3, 17.3).
 *  2. **Redaction layer + service catch path.** A registry whose adapter either
 *     returns an error message OR throws one — each embedding a secret in a
 *     redactable form — confirms the service routes both the adapter-returned
 *     and the thrown-error paths through the Redaction_Layer, yielding a
 *     classified, redacted result with no secret substring (Req 18.1).
 *
 * There is ZERO disk, network, or provider I/O: the config/secret stores are
 * in-memory doubles, the cache is the real in-memory cache, and `fetch` is a
 * local mock — so every run is fully deterministic and hermetic (Requirement 29).
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { createModelDiscoveryService } from "../src/providers/discovery/service";
import { createDiscoveryCache } from "../src/providers/discovery/cache";
import { createDefaultDiscoveryAdapterRegistry } from "../src/providers/discovery/adapters/registry";
import type {
  AdapterContext,
  AdapterResult,
  DiscoveryAdapter,
  DiscoveryAdapterRegistry,
} from "../src/providers/discovery/adapters";
import {
  DiscoveryErrorCategorySchema,
  DiscoveryResultSchema,
} from "../src/providers/discovery/types";
import { createInMemoryProviderConfigStore } from "../src/providers/configStore";
import {
  PROVIDER_CONFIG_VERSION,
  PROVIDER_KINDS,
  type ProviderConfigRecord,
  type ProviderKind,
} from "../src/providers/config";
import type { SecretStore } from "../src/security/secretStore";

// A fixed, schema-valid ISO timestamp for record metadata and the clock. The
// failure paths are independent of the actual timestamp, so it can stay constant.
const TS = "2026-01-01T00:00:00.000Z";

/** The known, classified discovery error categories (never a raw body). */
const CATEGORIES = DiscoveryErrorCategorySchema.options;
const CATEGORY_SET = new Set<string>(CATEGORIES);

/** Arbitrary alphanumeric sentinel with a recognizable prefix (never whitespace). */
const HEX_CHARS = "abcdef0123456789".split("");
const arbSentinel = (prefix: string): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom(...HEX_CHARS), { minLength: 8, maxLength: 16 })
    .map((chars) => `${prefix}${chars.join("")}`);

/**
 * A minimal in-memory {@link SecretStore} double that always returns
 * `secretValue` so the service proceeds to dispatch. Presence is irrelevant to
 * the failure paths and reported false.
 */
function inMemorySecretStore(secretValue: string): SecretStore {
  return {
    async setSecret() {
      return { ok: true, value: undefined };
    },
    async getSecret() {
      return { ok: true, value: secretValue };
    },
    async hasSecret() {
      return false;
    },
  };
}

/**
 * Build a schema-valid {@link ProviderConfigRecord} for `kind`, populated with
 * exactly the non-secret fields each adapter needs to reach its `fetch` call so
 * the failure originates from the mocked response rather than an early
 * configuration error.
 */
function recordForKind(kind: ProviderKind, secretRef: string): ProviderConfigRecord {
  const base = {
    id: `${kind}:fail-test`,
    kind,
    label: "Fail Test",
    secretRef,
    createdAt: TS,
    updatedAt: TS,
  } as const;
  switch (kind) {
    case "together":
      return { ...base, baseUrl: "https://api.together.test" };
    case "openai-compatible":
      return { ...base, baseUrl: "https://proxy.test/v1" };
    case "cloudflare":
      return { ...base, baseUrl: "https://api.cloudflare.test/client/v4", cloudflare: { accountId: "acct-123" } };
    case "azure-openai":
      return { ...base, azure: { endpoint: "https://resource.openai.azure.test" } };
  }
}

/** The arbitrary failure the mocked `fetch` injects. */
type FailureMode =
  | { type: "httpError"; status: number }
  | { type: "nonJson" }
  | { type: "unrecognizedJson" }
  | { type: "networkThrow" };

const arbFailureMode: fc.Arbitrary<FailureMode> = fc.oneof(
  fc
    .constantFrom(400, 401, 403, 404, 408, 409, 422, 429, 500, 502, 503, 504)
    .map((status) => ({ type: "httpError" as const, status })),
  fc.constant({ type: "nonJson" as const }),
  fc.constant({ type: "unrecognizedJson" as const }),
  fc.constant({ type: "networkThrow" as const }),
);

/**
 * A mocked `fetch` that injects `mode`. Every body embeds both the raw-body
 * sentinel and the secret sentinel, so a leak of either into the result is
 * detectable. The adapters must classify each case to a fixed, secret-free
 * message instead of echoing this content.
 */
function makeFetch(mode: FailureMode, bodySentinel: string, secretSentinel: string): typeof fetch {
  const leak = `${bodySentinel} leaked-secret=${secretSentinel}`;
  const impl = async (): Promise<Response> => {
    switch (mode.type) {
      case "networkThrow":
        throw new Error(`connection failed: ${leak}`);
      case "httpError":
        return new Response(`{"error":"${leak}"}`, {
          status: mode.status,
          headers: { "content-type": "application/json" },
        });
      case "nonJson":
        return new Response(`<<not json>> ${leak}`, {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      case "unrecognizedJson":
        return new Response(JSON.stringify({ unexpected: leak }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
    }
  };
  return impl as unknown as typeof fetch;
}

describe("Feature: byok-chat-ux-and-model-discovery, Property 12: Failures yield a classified category, never a raw body", () => {
  // Validates: Requirements 14.3, 17.3, 18.1
  it("classifies every adapter/HTTP failure and never leaks the raw response body or secret", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...PROVIDER_KINDS),
        arbFailureMode,
        arbSentinel("BODY"),
        arbSentinel("SEC"),
        async (kind, mode, bodySentinel, secretSentinel) => {
          const secretRef = "secret-ref";
          const record = recordForKind(kind, secretRef);
          const configStore = createInMemoryProviderConfigStore({
            version: PROVIDER_CONFIG_VERSION,
            providers: [record],
            activeRoutes: {},
          });
          const secretValue = `live-key-${secretSentinel}`;
          const service = createModelDiscoveryService({
            configStore,
            secrets: inMemorySecretStore(secretValue),
            cache: createDiscoveryCache(),
            adapters: createDefaultDiscoveryAdapterRegistry(),
            clock: () => Date.parse(TS),
          });

          const fetchImpl = makeFetch(mode, bodySentinel, secretSentinel);
          const result = await service.discover(record.id, { fetchImpl });

          // The result is a well-formed, classified failure for this provider.
          const parsed = DiscoveryResultSchema.safeParse(result);
          expect(parsed.success).toBe(true);
          expect(result.ok).toBe(false);
          expect(result.providerId).toBe(record.id);
          if (result.ok) return;

          // The category is one of the known classified values (Req 14.3, 17.3).
          expect(CATEGORY_SET.has(result.error.category)).toBe(true);
          expect(typeof result.error.message).toBe("string");

          // Neither the raw response body nor the secret survives anywhere in
          // the returned result (Req 18.1) — adapters classify, never echo.
          const serialized = JSON.stringify(result);
          expect(serialized.includes(bodySentinel)).toBe(false);
          expect(serialized.includes(secretSentinel)).toBe(false);
          expect(serialized.includes(secretValue)).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  // Validates: Requirements 18.1, 17.3
  it("routes both adapter-returned and thrown error messages through the Redaction_Layer", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...PROVIDER_KINDS),
        fc.constantFrom("return", "throw"),
        fc.constantFrom(...CATEGORIES),
        arbSentinel("TKN"),
        async (kind, behavior, category, token) => {
          // The adapter for `kind` surfaces a message that embeds the secret in
          // two redactable forms; nothing else carries the token.
          const message = `discovery failed; Authorization: Bearer ${token} and api_key=${token}`;
          const failingAdapter: DiscoveryAdapter = {
            kind,
            async discover(_ctx: AdapterContext): Promise<AdapterResult> {
              if (behavior === "throw") {
                throw new Error(message);
              }
              return { ok: false, error: { category, message } };
            },
          };

          // Start from the real registry, override only the target kind so the
          // service dispatches into the failing adapter.
          const registry: DiscoveryAdapterRegistry = createDefaultDiscoveryAdapterRegistry();
          registry[kind] = failingAdapter;

          const record = recordForKind(kind, "secret-ref");
          const configStore = createInMemoryProviderConfigStore({
            version: PROVIDER_CONFIG_VERSION,
            providers: [record],
            activeRoutes: {},
          });
          const service = createModelDiscoveryService({
            configStore,
            secrets: inMemorySecretStore("unused-secret"),
            cache: createDiscoveryCache(),
            adapters: registry,
            clock: () => Date.parse(TS),
          });

          const result = await service.discover(record.id);

          const parsed = DiscoveryResultSchema.safeParse(result);
          expect(parsed.success).toBe(true);
          expect(result.ok).toBe(false);
          if (result.ok) return;

          // Classified: a thrown error degrades to `unknown`; a returned error
          // keeps its category (Req 18.1).
          expect(CATEGORY_SET.has(result.error.category)).toBe(true);
          if (behavior === "throw") {
            expect(result.error.category).toBe("unknown");
          } else {
            expect(result.error.category).toBe(category);
          }

          // The redactable secret was redacted out of the message (Req 18.1).
          const serialized = JSON.stringify(result);
          expect(serialized.includes(token)).toBe(false);
          expect(result.error.message.includes("[REDACTED]")).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });
});
