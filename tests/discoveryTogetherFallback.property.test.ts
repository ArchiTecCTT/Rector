/**
 * Task 5.2 — Together_Discovery_Adapter native/fallback property test.
 *
 * **Feature: cloud-capable-transition, Property 6: Together falls back to /v1/models only on HTTP 404**
 * **Validates: Requirements 2.2**
 *
 * Property 6: For any first-response HTTP status from the Together native
 * `GET {baseUrl}/models` request, the Together_Discovery_Adapter issues the
 * `GET {baseUrl}/v1/models` fallback request **iff** that first status is 404,
 * and issues no fallback for any other status.
 *
 * The test drives the adapter through an injected counting `fetchImpl` double
 * that:
 *   - always answers the native `{baseUrl}/models` request with an arbitrary,
 *     fast-check-generated HTTP status, and
 *   - answers the `{baseUrl}/v1/models` fallback request with a valid catalog,
 * while tallying how many times each URL was requested and in what order.
 *
 * The property then asserts the adapter (a) always requests `{baseUrl}/models`
 * first exactly once, (b) requests `{baseUrl}/v1/models` exactly once when —
 * and only when — the native status was 404, and (c) never touches any other
 * URL. There is ZERO real network: every request flows through the injected
 * double, so the run is fully hermetic (Requirement 29).
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import type { ProviderConfigRecord } from "../src/providers/config";
import type { AdapterContext } from "../src/providers/discovery/adapters";
import { togetherDiscoveryAdapter } from "../src/providers/discovery/adapters/together";

const TIMESTAMPS = { createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };

/** The adapter's default base URL when a record omits `baseUrl`. */
const DEFAULT_BASE_URL = "https://api.together.xyz";

/** A JSON catalog response in the OpenAI-compatible `{ data: [...] }` shape. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A counting `fetch` double. It records every requested URL in order, answers
 * the native list with `firstStatus`, and answers the fallback list with a
 * valid catalog. Any other URL is counted as `other` and 500'd so a stray
 * request is observable.
 */
function countingFetch(baseUrl: string, firstStatus: number): {
  fetchImpl: typeof fetch;
  calls: { native: number; fallback: number; other: number; order: string[] };
} {
  const calls = { native: 0, fallback: 0, other: 0, order: [] as string[] };
  const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.order.push(url);
    if (url === `${baseUrl}/models`) {
      calls.native += 1;
      // A 2xx native response carries a valid (empty) catalog; any other status
      // is returned as a bodiless HTTP response for classification.
      return firstStatus >= 200 && firstStatus < 300
        ? jsonResponse({ object: "list", data: [] })
        : new Response(null, { status: firstStatus });
    }
    if (url === `${baseUrl}/v1/models`) {
      calls.fallback += 1;
      return jsonResponse({ object: "list", data: [{ id: "Qwen/Qwen2-72B" }] });
    }
    calls.other += 1;
    return new Response(null, { status: 500 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/**
 * Arbitrary HTTP status the native request answers with. Weighted so the 404
 * fallback branch and the no-fallback branch are both exercised heavily. The
 * range is constrained to 200–599 because the `Response` constructor rejects
 * 1xx init statuses.
 */
const arbStatus: fc.Arbitrary<number> = fc.oneof(
  { weight: 4, arbitrary: fc.constant(404) },
  { weight: 6, arbitrary: fc.integer({ min: 200, max: 599 }).filter((s) => s !== 404) },
);

/**
 * Arbitrary base URL: either an explicit origin (with or without a trailing
 * slash, which the adapter tolerates) or `undefined` to exercise the default.
 */
const arbBaseUrl: fc.Arbitrary<string | undefined> = fc.oneof(
  fc.constant(undefined),
  fc.constantFrom(
    "https://api.together.xyz",
    "https://together.example.com",
    "https://proxy.internal/together",
    "https://api.together.xyz/",
  ),
);

/** A non-empty, trimmed credential so the adapter never short-circuits as auth_invalid. */
const arbSecret: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 32 })
  .map((s) => `key-${s.replace(/\s+/g, "")}`)
  .filter((s) => s.trim().length > 0);

function buildRecord(baseUrl: string | undefined): ProviderConfigRecord {
  return {
    id: "together:main",
    kind: "together",
    label: "Together",
    ...(baseUrl === undefined ? {} : { baseUrl }),
    secretRef: "together:main",
    ...TIMESTAMPS,
  };
}

describe("Feature: cloud-capable-transition, Property 6: Together falls back to /v1/models only on HTTP 404", () => {
  // Validates: Requirements 2.2
  it("requests {baseUrl}/models first and the /v1/models fallback iff the native status is 404", async () => {
    await fc.assert(
      fc.asyncProperty(arbBaseUrl, arbStatus, arbSecret, async (configuredBaseUrl, firstStatus, secret) => {
        // The adapter trims trailing slashes off the base before joining paths.
        const effectiveBase = (configuredBaseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
        const { fetchImpl, calls } = countingFetch(effectiveBase, firstStatus);

        const ctx: AdapterContext = {
          record: buildRecord(configuredBaseUrl),
          secret,
          fetchImpl,
          includeDeprecated: false,
        };

        await togetherDiscoveryAdapter.discover(ctx);

        // (a) The native list is always requested first, exactly once.
        expect(calls.native).toBe(1);
        expect(calls.order[0]).toBe(`${effectiveBase}/models`);

        // (c) No request ever escapes to an unexpected URL.
        expect(calls.other).toBe(0);

        // (b) The fallback is issued exactly once iff the native status was 404,
        // and never for any other status.
        if (firstStatus === 404) {
          expect(calls.fallback).toBe(1);
          expect(calls.order).toContain(`${effectiveBase}/v1/models`);
          expect(calls.order).toHaveLength(2);
        } else {
          expect(calls.fallback).toBe(0);
          expect(calls.order).toHaveLength(1);
        }
      }),
      { numRuns: 200 },
    );
  });
});
