/**
 * Connection-test endpoint property tests (ORN-32).
 *
 * Property 9: the connection test never performs a network call when the
 * resolved provider configuration is invalid — either because the requested
 * `providerId` is unsupported, or because a supported provider is missing the
 * credentials its `validateConfig()` requires. In both cases the service must
 * short-circuit BEFORE any provider network call, returning `ok:false`,
 * `networkAttempted:false`, and leaving the injected `fetch` double untouched.
 *
 * Everything here is zero-network and mock-only: the injected `fetchImpl`
 * counts its own calls and never reaches a real endpoint.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { runConnectionTest, SUPPORTED_PROVIDER_IDS } from "../src/api/server";
import { arbKeyLikeSecret, createFetchDouble } from "./support/byokArbitraries";

const SUPPORTED_ID_SET = new Set<string>(SUPPORTED_PROVIDER_IDS);

/**
 * Credential env keys that each supported provider's `validateConfig()` checks
 * first. Setting every one to an empty string guarantees that whichever
 * supported provider is selected fails config validation deterministically,
 * regardless of any ambient `process.env` value (the provider constructors use
 * `?? `, which does not fall through an explicit empty string).
 */
const REQUIRED_CREDENTIAL_KEYS = [
  "TOGETHER_API_KEY",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "AZURE_OPENAI_API_KEY",
] as const;

/** An env in which every supported provider is missing its required credentials. */
function emptyCredentialEnv(decoySecret?: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const key of REQUIRED_CREDENTIAL_KEYS) {
    env[key] = "";
  }
  // A key-like secret parked under an unrelated env name must not be picked up
  // as a credential nor trigger a network call.
  if (decoySecret !== undefined) {
    env.UNRELATED_DECOY_SECRET = decoySecret;
  }
  return env;
}

/**
 * Arbitrary NON-EMPTY string that is NOT one of the supported provider
 * identifiers. Property 9 targets *config-invalid* requests — an unsupported
 * provider id. The empty string is a malformed/empty request body, not an
 * unsupported provider id: the route layer rejects it up front via
 * `TestConnectionRequestSchema` (`providerId: z.string().min(1)`) with a 400,
 * so it is out of scope for this property and is excluded here.
 */
const arbUnsupportedProviderId = (): fc.Arbitrary<string> =>
  fc
    .oneof(
      fc.string({ minLength: 1, maxLength: 24 }),
      // Near-miss casings/typos that must still be rejected.
      fc.constantFrom("Together", "TOGETHER", "openai", "claude", "gpt-4", "azure", "cloudflare-ai")
    )
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && !SUPPORTED_ID_SET.has(value));

/** Arbitrary supported provider identifier. */
const arbSupportedProviderId = (): fc.Arbitrary<string> => fc.constantFrom(...SUPPORTED_PROVIDER_IDS);

describe("Property 9: connection test never calls network when config is invalid", () => {
  // Validates: Requirements 2.4 (unsupported providerId) and 2.2 (at most one
  // network call — here, zero).
  it("short-circuits an unsupported providerId without any network call", async () => {
    await fc.assert(
      fc.asyncProperty(arbUnsupportedProviderId(), arbKeyLikeSecret(), async (providerId, secret) => {
        const fetchDouble = createFetchDouble();
        const response = await runConnectionTest({
          providerId,
          env: emptyCredentialEnv(secret),
          fetchImpl: fetchDouble.fetchImpl,
        });

        expect(response.ok).toBe(false);
        expect(response.code).toBe("CONFIG_INVALID");
        expect(response.networkAttempted).toBe(false);
        expect(response.providerId).toBe(providerId);
        expect(response.model).toBeUndefined();
        // The decisive assertion: the injected fetch was never invoked.
        expect(fetchDouble.calls).toBe(0);
      }),
      { numRuns: 200 }
    );
  });

  // Validates: Requirements 2.1 (config-invalid short-circuit) and 2.2.
  it("short-circuits a supported provider with missing credentials without any network call", async () => {
    await fc.assert(
      fc.asyncProperty(arbSupportedProviderId(), arbKeyLikeSecret(), async (providerId, secret) => {
        const fetchDouble = createFetchDouble();
        const response = await runConnectionTest({
          providerId,
          env: emptyCredentialEnv(secret),
          fetchImpl: fetchDouble.fetchImpl,
        });

        expect(response.ok).toBe(false);
        expect(response.code).toBe("CONFIG_INVALID");
        expect(response.networkAttempted).toBe(false);
        expect(response.providerId).toBe(providerId);
        expect(response.model).toBeUndefined();
        expect(fetchDouble.calls).toBe(0);
      }),
      { numRuns: 200 }
    );
  });

  // The unified property exactly as stated in the design: for ANY unsupported
  // providerId OR ANY supported providerId with missing credentials, the result
  // is ok:false, networkAttempted:false, and the fetch double sees zero calls.
  // Validates: Requirements 2.1, 2.2, 2.4.
  it("never attempts the network for any config-invalid request", async () => {
    const arbConfigInvalidRequest = fc.oneof(
      arbUnsupportedProviderId().map((providerId) => ({ providerId, supported: false })),
      arbSupportedProviderId().map((providerId) => ({ providerId, supported: true }))
    );

    await fc.assert(
      fc.asyncProperty(arbConfigInvalidRequest, arbKeyLikeSecret(), async ({ providerId }, secret) => {
        const fetchDouble = createFetchDouble();
        const response = await runConnectionTest({
          providerId,
          env: emptyCredentialEnv(secret),
          fetchImpl: fetchDouble.fetchImpl,
        });

        expect(response.ok).toBe(false);
        expect(response.networkAttempted).toBe(false);
        expect(fetchDouble.calls).toBe(0);
      }),
      { numRuns: 200 }
    );
  });
});

/**
 * Connection-test endpoint example/unit tests (ORN-32, Task 5.4).
 *
 * These complement Property 9 with concrete examples covering the full
 * `runConnectionTest` decision tree: an unsupported `providerId`, the
 * `CONFIG_INVALID` short-circuit (no fetch), a successful ping, HTTP and
 * network-error mapping, and redaction of a secret embedded in a provider
 * error message (Requirements 2.3, 2.5, 2.6). Everything is mock-only: the
 * injected `fetchImpl` counts its own calls and never reaches a real endpoint.
 */
describe("runConnectionTest unit tests (ORN-32)", () => {
  // Dummy Together credentials that satisfy validateConfig() without being a
  // real key. The default Together base URL is absolute http(s), but we pin an
  // explicit test URL so config validation never depends on ambient env.
  const togetherEnv = (
    overrides: Record<string, string | undefined> = {}
  ): Record<string, string | undefined> => ({
    TOGETHER_API_KEY: "dummy-together-key-not-real",
    TOGETHER_BASE_URL: "https://api.together.test/v1",
    ...overrides,
  });

  // (1) Unsupported providerId is rejected as CONFIG_INVALID before any
  // provider is built or any network call is attempted (Requirement 2.4).
  it("rejects an unsupported providerId with CONFIG_INVALID and no network call", async () => {
    const fetchDouble = createFetchDouble();

    const response = await runConnectionTest({
      providerId: "openai",
      env: {},
      fetchImpl: fetchDouble.fetchImpl,
    });

    expect(response.ok).toBe(false);
    expect(response.code).toBe("CONFIG_INVALID");
    expect(response.networkAttempted).toBe(false);
    expect(response.providerId).toBe("openai");
    expect(response.model).toBeUndefined();
    expect(fetchDouble.calls).toBe(0);
  });

  // (2) A supported provider whose validateConfig() fails short-circuits with
  // CONFIG_INVALID and networkAttempted:false, before any ping (Requirement 2.1).
  it("short-circuits a supported provider with missing credentials before any network call", async () => {
    const fetchDouble = createFetchDouble();

    const response = await runConnectionTest({
      providerId: "together",
      env: { TOGETHER_API_KEY: "" },
      fetchImpl: fetchDouble.fetchImpl,
    });

    expect(response.ok).toBe(false);
    expect(response.code).toBe("CONFIG_INVALID");
    expect(response.networkAttempted).toBe(false);
    expect(response.providerId).toBe("together");
    expect(response.model).toBeUndefined();
    expect(fetchDouble.calls).toBe(0);
  });

  // (3) Valid config + a mocked 200 ping returns ok:true, the echoed
  // providerId, the resolved model, and networkAttempted:true with exactly one
  // network call (Requirements 2.5, 2.2).
  it("returns ok with the resolved model on a successful ping (one network call)", async () => {
    const fetchDouble = createFetchDouble({ status: 200, model: "together-model-xyz", content: "pong" });

    const response = await runConnectionTest({
      providerId: "together",
      env: togetherEnv(),
      fetchImpl: fetchDouble.fetchImpl,
    });

    expect(response.ok).toBe(true);
    expect(response.providerId).toBe("together");
    expect(response.model).toBe("together-model-xyz");
    expect(response.networkAttempted).toBe(true);
    expect(response.code).toBeUndefined();
    expect(response.error).toBeUndefined();
    expect(fetchDouble.calls).toBe(1);
  });

  // (4a) A provider HTTP failure maps to the provider error code with
  // networkAttempted:true, after the single ping (Requirement 2.6).
  it("maps an HTTP failure to PROVIDER_HTTP_ERROR with networkAttempted true", async () => {
    const fetchDouble = createFetchDouble({ status: 401 });

    const response = await runConnectionTest({
      providerId: "together",
      env: togetherEnv(),
      fetchImpl: fetchDouble.fetchImpl,
    });

    expect(response.ok).toBe(false);
    expect(response.code).toBe("PROVIDER_HTTP_ERROR");
    expect(response.networkAttempted).toBe(true);
    expect(response.model).toBeUndefined();
    expect(fetchDouble.calls).toBe(1);
  });

  // (4b) A thrown (non-ProviderError) network failure maps to the generic
  // PROVIDER_ERROR code, still with networkAttempted:true (Requirement 2.6).
  it("maps a thrown network error to PROVIDER_ERROR with networkAttempted true", async () => {
    const fetchDouble = createFetchDouble({ throwError: new Error("ECONNREFUSED: upstream unreachable") });

    const response = await runConnectionTest({
      providerId: "together",
      env: togetherEnv(),
      fetchImpl: fetchDouble.fetchImpl,
    });

    expect(response.ok).toBe(false);
    expect(response.code).toBe("PROVIDER_ERROR");
    expect(response.networkAttempted).toBe(true);
    expect(fetchDouble.calls).toBe(1);
  });

  // (5) A secret-like string carried in a provider error message must be
  // redacted out of the returned `error` field, never echoed raw (Requirement 2.3).
  it("redacts a secret-like string embedded in a provider error message", async () => {
    const secret = "sk-SECRET-LEAK-9f8e7d6c5b4a3210";
    const fetchDouble = createFetchDouble({
      throwError: new Error(`upstream rejected request with Authorization: Bearer ${secret}`),
    });

    const response = await runConnectionTest({
      providerId: "together",
      env: togetherEnv(),
      fetchImpl: fetchDouble.fetchImpl,
    });

    expect(response.ok).toBe(false);
    expect(response.networkAttempted).toBe(true);
    expect(response.error).toBeDefined();
    // The raw secret must NOT survive into the response; it is replaced.
    expect(response.error).not.toContain(secret);
    expect(response.error).toContain("[REDACTED]");
  });
});
