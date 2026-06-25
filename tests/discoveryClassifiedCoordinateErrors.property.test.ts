/**
 * Task 5.13 — Classified missing-coordinate discovery errors property test.
 *
 * **Feature: cloud-capable-transition, Property 10: Missing required coordinates produce the correct classified error**
 * **Validates: Requirements 2.10, 2.11**
 *
 * Property 10: For any dispatched discovery where the required credential is
 * absent (missing, empty, or whitespace-only) the result is a Discovery_Error
 * with category `auth_invalid` (Requirement 2.10); and where a required endpoint
 * or account coordinate is absent (missing, empty, or whitespace-only) the
 * result is a Discovery_Error with category `endpoint_invalid` (Requirement
 * 2.11). In both cases the adapter classifies the missing coordinate *before*
 * issuing any catalog request, so the injected `fetchImpl` is never called.
 *
 * The test exercises the real shipped adapters directly:
 *
 *   - **Credential absent** (Requirement 2.10) — Together, Cloudflare, and Azure
 *     each require a credential. With every required endpoint/account coordinate
 *     present but the transient secret absent, each adapter returns
 *     `auth_invalid` without touching `fetchImpl`.
 *   - **Coordinate absent** (Requirement 2.11) — Cloudflare (account id), Azure
 *     (endpoint), and the OpenAI-compatible adapter (base URL, no manual list)
 *     each require an endpoint/account coordinate. With a valid credential
 *     present but the coordinate absent, each adapter returns `endpoint_invalid`
 *     without touching `fetchImpl`.
 *
 * "Absent" is generated across the full missing/empty/whitespace space so the
 * classification holds for every blank form, not just `undefined`.
 *
 * There is ZERO disk, network, or provider I/O: the adapters receive a counting
 * `fetchImpl` double that is asserted to have run zero times, so each of the
 * ≥100 iterations is fully deterministic and hermetic.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { type ProviderConfigRecord, type ProviderKind } from "../src/providers/config";
import type {
  AdapterContext,
  AdapterResult,
  DiscoveryAdapter,
} from "../src/providers/discovery/adapters";
import { togetherDiscoveryAdapter } from "../src/providers/discovery/adapters/together";
import { cloudflareDiscoveryAdapter } from "../src/providers/discovery/adapters/cloudflare";
import { azureDiscoveryAdapter } from "../src/providers/discovery/adapters/azure";
import { openaiCompatibleDiscoveryAdapter } from "../src/providers/discovery/adapters/openaiCompatible";
import { arbKeyLikeSecret } from "./support/byokArbitraries";

/** A fixed, schema-valid ISO timestamp for record metadata. */
const TS = "2026-01-01T00:00:00.000Z";

/** The shipped Discovery_Adapter for each Provider_Kind under test. */
const ADAPTERS: Record<ProviderKind, DiscoveryAdapter> = {
  together: togetherDiscoveryAdapter,
  cloudflare: cloudflareDiscoveryAdapter,
  "azure-openai": azureDiscoveryAdapter,
  "openai-compatible": openaiCompatibleDiscoveryAdapter,
};

/**
 * The full "absent" space for a required coordinate or credential: missing,
 * empty, or whitespace-only. Every variant must classify identically (Req 2.10,
 * 2.11).
 */
const arbAbsent: fc.Arbitrary<string | undefined> = fc.constantFrom(
  undefined,
  "",
  " ",
  "   ",
  "\t",
  "\n",
  "  \t \n ",
);

/**
 * A counting `fetch` double. The classified-coordinate paths must short-circuit
 * before any catalog request, so this returning a value at all is itself a
 * failure the assertions catch via `calls() === 0`.
 */
function countingFetch(): { impl: typeof fetch; calls: () => number } {
  let calls = 0;
  const impl = (async (): Promise<Response> => {
    calls += 1;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { impl, calls: () => calls };
}

/** A non-secret base Provider_Config_Record for `kind`. */
function baseRecord(kind: ProviderKind): ProviderConfigRecord {
  return {
    id: `${kind}:coord-test`,
    kind,
    label: "Coordinate Test",
    secretRef: "secret-ref",
    createdAt: TS,
    updatedAt: TS,
  };
}

/** One generated scenario: the adapter input plus the category it must classify to. */
interface Scenario {
  kind: ProviderKind;
  record: ProviderConfigRecord;
  secret: string | undefined;
  expected: "auth_invalid" | "endpoint_invalid";
}

/**
 * Credential-absent scenarios (Req 2.10): every required endpoint/account
 * coordinate is present, only the transient secret is absent. Together,
 * Cloudflare, and Azure each require a credential.
 */
const arbCredentialAbsentScenario: fc.Arbitrary<Scenario> = fc.oneof(
  arbAbsent.map((secret) => ({
    kind: "together" as const,
    record: { ...baseRecord("together"), baseUrl: "https://api.together.test" },
    secret,
    expected: "auth_invalid" as const,
  })),
  arbAbsent.map((secret) => ({
    kind: "cloudflare" as const,
    record: { ...baseRecord("cloudflare"), cloudflare: { accountId: "acct-123" } },
    secret,
    expected: "auth_invalid" as const,
  })),
  arbAbsent.map((secret) => ({
    kind: "azure-openai" as const,
    record: { ...baseRecord("azure-openai"), azure: { endpoint: "https://resource.openai.azure.test" } },
    secret,
    expected: "auth_invalid" as const,
  })),
);

/**
 * Coordinate-absent scenarios (Req 2.11): a valid credential is present, only
 * the required endpoint/account coordinate is absent. Cloudflare requires an
 * account id, Azure an endpoint, and the OpenAI-compatible adapter a base URL
 * (with no manual model list to fall back to).
 */
const arbCoordinateAbsentScenario: fc.Arbitrary<Scenario> = fc.oneof(
  fc.tuple(arbAbsent, arbKeyLikeSecret()).map(([accountId, secret]) => ({
    kind: "cloudflare" as const,
    // accountId absent; baseUrl present so only the account coordinate is missing.
    record: { ...baseRecord("cloudflare"), baseUrl: "https://api.cloudflare.test/client/v4", cloudflare: { accountId } },
    secret,
    expected: "endpoint_invalid" as const,
  })),
  fc.tuple(arbAbsent, arbAbsent, arbKeyLikeSecret()).map(([endpoint, baseUrl, secret]) => ({
    kind: "azure-openai" as const,
    // Both the azure endpoint and the fallback baseUrl are absent.
    record: { ...baseRecord("azure-openai"), baseUrl, azure: { endpoint } },
    secret,
    expected: "endpoint_invalid" as const,
  })),
  fc.tuple(arbAbsent, arbKeyLikeSecret()).map(([baseUrl, secret]) => ({
    kind: "openai-compatible" as const,
    // No base URL and no manual model list, so the endpoint coordinate is missing.
    record: { ...baseRecord("openai-compatible"), baseUrl },
    secret,
    expected: "endpoint_invalid" as const,
  })),
);

async function runScenario(scenario: Scenario): Promise<{ result: AdapterResult; fetchCalls: number }> {
  const fetchDouble = countingFetch();
  const ctx: AdapterContext = {
    record: scenario.record,
    secret: scenario.secret,
    fetchImpl: fetchDouble.impl,
    includeDeprecated: false,
  };
  const result = await ADAPTERS[scenario.kind].discover(ctx);
  return { result, fetchCalls: fetchDouble.calls() };
}

describe("Feature: cloud-capable-transition, Property 10: Missing required coordinates produce the correct classified error", () => {
  // Validates: Requirements 2.10
  it("classifies an absent credential as auth_invalid without issuing a request", async () => {
    await fc.assert(
      fc.asyncProperty(arbCredentialAbsentScenario, async (scenario) => {
        const { result, fetchCalls } = await runScenario(scenario);

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.category).toBe("auth_invalid");

        // The required credential is missing, so no catalog request is issued.
        expect(fetchCalls).toBe(0);
      }),
      { numRuns: 200 },
    );
  });

  // Validates: Requirements 2.11
  it("classifies an absent endpoint/account coordinate as endpoint_invalid without issuing a request", async () => {
    await fc.assert(
      fc.asyncProperty(arbCoordinateAbsentScenario, async (scenario) => {
        const { result, fetchCalls } = await runScenario(scenario);

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.category).toBe("endpoint_invalid");

        // The required endpoint/account coordinate is missing, so no catalog
        // request is issued.
        expect(fetchCalls).toBe(0);
      }),
      { numRuns: 200 },
    );
  });
});
