/**
 * Task 13.1 — Cross-cutting secret-safety property test (ORN-56 → ORN-61).
 *
 * **Feature: byok-chat-ux-and-model-discovery, Property 14: No secret value crosses any boundary**
 * **Validates: Requirements 8.3, 18.2, 18.3, 23.3, 24.1, 28.1, 28.3**
 *
 * Property 14: *For any* discovery result, probe result, direct-answer fallback,
 * error message, or rendered config/candidate view that is derived from input
 * carrying a configured secret value, the produced output SHALL exclude that
 * secret value.
 *
 * This is the broad, cross-cutting secret-safety sibling of the boundary-specific
 * redaction tests. It drives every output boundary this effort introduces and, for
 * each one, embeds a fast-check-generated key-like secret (in a form the
 * Redaction_Layer in `src/security/redaction.ts` actually targets — a `Bearer`
 * header, an inline `api_key=`/`token=`/`secret=`/`password=` pair, a credential
 * URI, or a `Basic` header) into the data that crosses the boundary, then asserts
 * the secret substring is ABSENT from the serialized output:
 *
 *   1. **Discovery results/errors (Req 18.2, 18.3, 28.3).** The
 *      `Model_Discovery_Service` is driven end-to-end against a mocked `fetch`
 *      that fails with a body/error embedding the secret. The shipped adapters
 *      classify the failure to a fixed, secret-free category and the service
 *      routes every message through the Redaction_Layer, so the secret never
 *      survives into the returned `DiscoveryResult`.
 *   2. **Probe results (Req 23.3, 28.3).** `runConnectionTest` (the injectable
 *      core of `POST /api/setup/test-connection`) is run with the secret in a
 *      secret-named env var AND inside a thrown network error; the returned
 *      `TestConnectionResponse` carries only a classified, redacted message.
 *   3. **Direct-answer fallback (Req 8.3).** `runLiveDirectAnswer` is given an
 *      `slm`-role provider whose answer (success path) and whose thrown error
 *      (failure path) embed the secret; the assembled message is routed through
 *      `redactOutbound`, so neither the raw provider text nor the secret appears.
 *   4. **UI / config-view boundary (Req 24.1, 28.1).** A provider
 *      configuration/candidate view model carrying the secret (under a
 *      secret-named field and inside a redactable string) is routed through the
 *      Redaction_Layer the API/Setup_UI boundary applies, and the secret is gone.
 *
 * Everything is in-memory and mock-only: config/secret stores are in-memory
 * doubles, the discovery cache is the real in-memory cache, `fetch` is a local
 * mock, and the provider is a scripted `SpyLLMProvider`. No API key and ZERO real
 * provider/network calls occur, so every run is deterministic and hermetic
 * (Requirement 29).
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { runConnectionTest } from "../src/api/server";
import { createModelDiscoveryService } from "../src/providers/discovery/service";
import { createDiscoveryCache } from "../src/providers/discovery/cache";
import { createDefaultDiscoveryAdapterRegistry } from "../src/providers/discovery/adapters/registry";
import { DiscoveryResultSchema } from "../src/providers/discovery/types";
import { createInMemoryProviderConfigStore } from "../src/providers/configStore";
import {
  PROVIDER_CONFIG_VERSION,
  PROVIDER_KINDS,
  type ProviderConfigRecord,
  type ProviderKind,
} from "../src/providers/config";
import type { SecretStore } from "../src/security/secretStore";
import { redactSecrets } from "../src/security/redaction";
import { createFakePlan } from "../src/orchestration/planner";
import { reviewPlanWithSkeptic } from "../src/orchestration/skeptic";
import { arbitratePlanWithCrucible } from "../src/orchestration/crucible";
import {
  buildDeterministicDirectAnswer,
  type BrainstemSynthesisInput,
} from "../src/orchestration/synthesizer";
import { runLiveDirectAnswer } from "../src/orchestration/liveDirectAnswer";
import { TRIAGE_ROUTES, type TriageResult } from "../src/orchestration/triage";
import {
  DEFAULT_SPY_USAGE,
  SpyLLMProvider,
  arbKeyLikeSecret,
  arbPlannerInput,
  arbSecretChannelText,
  generousBudget,
  makeExternalRun,
} from "./support/byokArbitraries";

/** A fixed, schema-valid ISO timestamp for record metadata and the clock. */
const TS = "2026-01-01T00:00:00.000Z";

/** Assert that `secret` (and any residual `Bearer <secret>`) is absent from `serialized`. */
function expectNoSecret(serialized: string, secret: string, where: string): void {
  expect(serialized, `secret leaked into ${where}`).not.toContain(secret);
  expect(serialized, `unredacted bearer/credential in ${where}`).not.toMatch(/Bearer\s+sk-/);
}

// ---------------------------------------------------------------------------
// Shared discovery doubles (mirroring discoveryFailureClassification.property)
// ---------------------------------------------------------------------------

/**
 * A minimal in-memory {@link SecretStore} double that always returns
 * `secretValue` so the service proceeds to dispatch into the adapter.
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
 * Build a schema-valid {@link ProviderConfigRecord} for `kind` with exactly the
 * non-secret fields each adapter needs to reach its `fetch` call, so the failure
 * originates from the mocked response rather than an early configuration error.
 */
function recordForKind(kind: ProviderKind, secretRef: string): ProviderConfigRecord {
  const base = {
    id: `${kind}:secret-test`,
    kind,
    label: "Secret Test",
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

/** The way the mocked `fetch` surfaces the secret-carrying failure to the adapter. */
type LeakMode = "httpErrorBody" | "networkThrow";
const arbLeakMode: fc.Arbitrary<LeakMode> = fc.constantFrom("httpErrorBody", "networkThrow");

/**
 * A mocked `fetch` whose failure embeds `leak` (a redactable secret carrier) in
 * either a non-2xx JSON body or a thrown transport error. The adapters must
 * classify the failure rather than echo this content.
 */
function makeLeakyFetch(mode: LeakMode, leak: string): typeof fetch {
  const impl = async (): Promise<Response> => {
    if (mode === "networkThrow") {
      throw new Error(`connection failed: ${leak}`);
    }
    return new Response(JSON.stringify({ error: leak }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  };
  return impl as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Direct-answer input (mirroring directAnswerExternalFallback.property)
// ---------------------------------------------------------------------------

/**
 * Arbitrary, internally-consistent `BrainstemSynthesisInput` pinned to the
 * `DIRECT_ANSWER` route so the live direct-answer path is exercised.
 */
const arbDirectAnswerInput = (): fc.Arbitrary<BrainstemSynthesisInput> =>
  arbPlannerInput().map((plannerInput) => {
    const plannerOutput = createFakePlan(plannerInput);
    const skepticReview = reviewPlanWithSkeptic(plannerOutput, plannerInput.contextPack);
    const crucibleDecision = arbitratePlanWithCrucible({
      plannerOutput,
      skepticReview,
      now: () => TS,
    });
    const triage: TriageResult = { ...plannerInput.triage, route: TRIAGE_ROUTES.DIRECT_ANSWER };
    return {
      traceId: "trace-secret-boundary",
      triage,
      contextPack: plannerInput.contextPack,
      plannerOutput,
      skepticReview,
      crucibleDecision,
    };
  });

describe("Feature: byok-chat-ux-and-model-discovery, Property 14: No secret value crosses any boundary", () => {
  // (1) Discovery results/errors — Req 18.2, 18.3, 28.3
  it("never lets a secret cross the Model_Discovery_Service boundary", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...PROVIDER_KINDS),
        arbLeakMode,
        arbKeyLikeSecret(),
        async (kind, mode, secret) => {
          const record = recordForKind(kind, "secret-ref");
          const configStore = createInMemoryProviderConfigStore({
            version: PROVIDER_CONFIG_VERSION,
            providers: [record],
            activeRoutes: {},
          });
          const service = createModelDiscoveryService({
            configStore,
            // The live key the service reads transiently; it must never be returned (Req 18.3).
            secrets: inMemorySecretStore(secret),
            cache: createDiscoveryCache(),
            adapters: createDefaultDiscoveryAdapterRegistry(),
            clock: () => Date.parse(TS),
          });

          // The provider failure carries the secret in a redactable form.
          const leak = `Authorization: Bearer ${secret}`;
          const fetchImpl = makeLeakyFetch(mode, leak);
          const result = await service.discover(record.id, { fetchImpl });

          // The result is a well-formed, classified failure (never throws).
          expect(DiscoveryResultSchema.safeParse(result).success).toBe(true);
          expect(result.ok).toBe(false);

          // Neither the live secret nor the redactable carrier survives (Req 18.2, 18.3).
          expectNoSecret(JSON.stringify(result), secret, "discovery result");
        },
      ),
      { numRuns: 200 },
    );
  });

  // (2) Probe results — Req 23.3, 28.3
  it("never lets a secret cross the Connection_Test_Service / Model_Probe boundary", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbKeyLikeSecret().chain((secret) =>
          arbSecretChannelText(secret).map((leak) => ({ secret, leak })),
        ),
        async ({ secret, leak }) => {
          // The secret lives under a secret-named env key (redactSecrets territory) AND inside a
          // thrown network error (redactString territory). The mocked fetch guarantees no real call.
          const env: Record<string, string | undefined> = {
            TOGETHER_API_KEY: secret,
            TOGETHER_BASE_URL: "https://api.together.test/v1",
          };
          const fetchImpl = (async () => {
            throw new Error(`connect failed (${leak})`);
          }) as unknown as typeof fetch;

          const response = await runConnectionTest({ providerId: "together", env, fetchImpl });

          // A network failure is reported as a safe, redacted, classified response (never throws).
          expect(response.ok).toBe(false);
          expect(response.networkAttempted).toBe(true);
          expectNoSecret(JSON.stringify(response), secret, "connection-test response");
        },
      ),
      { numRuns: 200 },
    );
  });

  // (3) Direct-answer fallback — Req 8.3
  it("never lets a secret cross the External_Mode direct-answer boundary", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbDirectAnswerInput(),
        fc.constantFrom<"success" | "provider_error">("success", "provider_error"),
        arbKeyLikeSecret(),
        async (input, outcome, secret) => {
          // Both paths carry the secret in raw provider text that crosses the boundary: the
          // success path through `response.content`, the failure path through a thrown error.
          const carrier = `Here is the answer. Authorization: Bearer ${secret} api_key=${secret}`;
          const provider =
            outcome === "success"
              ? new SpyLLMProvider({ estimate: DEFAULT_SPY_USAGE, responses: [carrier] })
              : new SpyLLMProvider({ estimate: DEFAULT_SPY_USAGE, responses: [{ error: new Error(carrier) }] });

          const result = await runLiveDirectAnswer(input, {
            provider,
            run: makeExternalRun(generousBudget()),
          });

          if (outcome === "provider_error") {
            // Req 8.1/8.3: the provider error falls back to deterministic local text, zero calls,
            // and the raw provider body never reaches the result.
            expect(result.response).toBe(buildDeterministicDirectAnswer(input));
            expect(result.providerCalls).toBe(0);
          }
          // Req 8.3: the assembled message is redacted, so the secret never appears either way.
          expectNoSecret(JSON.stringify(result), secret, `direct-answer (${outcome}) result`);
        },
      ),
      { numRuns: 200 },
    );
  });

  // (4) UI / config-view boundary — Req 24.1, 28.1
  it("never lets a secret cross the Setup_UI / config-view Redaction_Layer boundary", () => {
    fc.assert(
      fc.property(
        arbKeyLikeSecret(),
        arbKeyLikeSecret().chain((s) => arbSecretChannelText(s).map((text) => ({ s, text }))),
        (apiKey, { s, text }) => {
          // A representative provider configuration / candidate view model the Setup_UI would
          // render. The secret appears under a secret-named field (redactSecrets removes the value)
          // and inside a free-text note in a redactable form (redactString removes the substring).
          const viewModel = {
            providerId: "together:main",
            kind: "together",
            label: "My Together provider",
            // Secret-named field: redactSecrets replaces the value wholesale (Req 24.1, 28.1).
            apiKey,
            secretPresent: true,
            candidates: [
              {
                displayName: "llama-3.1-70b",
                capabilities: ["chat", "text-generation"],
                // A free-text field that accidentally carries a secret in a redactable form.
                note: `connection log: ${text}`,
              },
            ],
          };

          const redacted = redactSecrets(viewModel);
          const serialized = JSON.stringify(redacted);

          expectNoSecret(serialized, apiKey, "config-view (secret field)");
          expectNoSecret(serialized, s, "config-view (free-text note)");
        },
      ),
      { numRuns: 200 },
    );
  });
});
