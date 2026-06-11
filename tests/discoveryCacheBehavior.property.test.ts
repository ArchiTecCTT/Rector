/**
 * Task 6.3 — Discovery_Cache behavior property test.
 *
 * **Feature: byok-chat-ux-and-model-discovery, Property 13: Cache serves within TTL, invalidates on change, and refresh bypasses**
 * **Validates: Requirements 16.1, 16.2, 16.3, 16.4, 17.2**
 *
 * For any provider with a cached result:
 *
 *   - a discover within the TTL **without** `refresh` SHALL return the cached
 *     value with ZERO network calls (Req 16.1, 16.2, 17.2);
 *   - a config, secret, or scope change SHALL evict the entry, so the next read
 *     re-runs discovery (Req 16.3 — modeled here as `invalidate`, the narrow
 *     surface `configStore.ts` calls; the store→cache wiring itself is covered
 *     by `providerConfigStore.test.ts` and is deliberately NOT re-tested here);
 *   - a `refresh` SHALL always re-run discovery and overwrite the entry
 *     (Req 17.2);
 *   - an error/empty result SHALL be stored with a strictly shorter TTL than a
 *     successful result (Req 16.4).
 *
 * The test exercises the cache's own TTL/invalidate/refresh semantics through a
 * tiny read-through model — the exact get→(miss|refresh)→discover→set pattern
 * the Model_Discovery_Service uses — where "discovery" is a counted in-memory
 * function. There is ZERO disk, network, or provider I/O: the clock is the
 * explicit `now` the cache already takes, and discovery is a local closure, so
 * every run is fully deterministic and hermetic.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  createDiscoveryCache,
  ERROR_TTL_MS,
  SUCCESS_TTL_MS,
  ttlForResult,
  type DiscoveryCache,
} from "../src/providers/discovery/cache";
import type { DiscoveryResult, ModelCandidate } from "../src/providers/discovery/types";

// A fixed, schema-valid ISO timestamp for candidate/result metadata. The cache
// keys off the explicit `now` clock, never this string, so it can stay constant.
const TS = "2026-01-01T00:00:00.000Z";

const PROVIDER_KINDS = ["openai-compatible", "together", "cloudflare", "azure-openai"] as const;

/** Arbitrary non-empty provider id, shaped like the real `kind:label` ids. */
const arbProviderId = (): fc.Arbitrary<string> =>
  fc
    .tuple(
      fc.constantFrom(...PROVIDER_KINDS),
      fc.string({ minLength: 1, maxLength: 16 }).filter((s) => s.trim().length > 0),
    )
    .map(([kind, label]) => `${kind}:${label.trim()}`);

/** Arbitrary, schema-valid `ModelCandidate` for `providerId`. */
const arbCandidate = (providerId: string): fc.Arbitrary<ModelCandidate> =>
  fc
    .record({
      kind: fc.constantFrom(...PROVIDER_KINDS),
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
      kind: partial.kind,
      scope: {},
      displayName: partial.displayName.trim(),
      capabilities: partial.capabilities,
      requiresDeployment: partial.requiresDeployment,
      requiresRegion: partial.requiresRegion,
      source: partial.kind,
      lastRefreshedAt: TS,
    }));

/** Arbitrary successful, NON-EMPTY result (uses the full success TTL). */
const arbSuccessResult = (providerId: string): fc.Arbitrary<DiscoveryResult> =>
  fc
    .array(arbCandidate(providerId), { minLength: 1, maxLength: 4 })
    .map((candidates) => ({ ok: true as const, providerId, candidates, lastRefreshedAt: TS }));

/** Arbitrary error OR empty-success result (uses the strictly shorter error TTL). */
const arbErrorOrEmptyResult = (providerId: string): fc.Arbitrary<DiscoveryResult> =>
  fc.oneof(
    // Empty but "successful" catalog — treated as error/empty for TTL (Req 16.4).
    fc.constant<DiscoveryResult>({ ok: true, providerId, candidates: [], lastRefreshedAt: TS }),
    // Classified failure.
    fc
      .constantFrom(
        "not_found",
        "auth_invalid",
        "endpoint_invalid",
        "network_error",
        "rate_limited",
        "unknown",
      )
      .map<DiscoveryResult>((category) => ({
        ok: false,
        providerId,
        error: { category, message: "discovery failed" },
        lastRefreshedAt: TS,
      })),
  );

/** Arbitrary result of any kind (success / empty / error). */
const arbDiscoveryResult = (providerId: string): fc.Arbitrary<DiscoveryResult> =>
  fc.oneof(arbSuccessResult(providerId), arbErrorOrEmptyResult(providerId));

/**
 * A counted "discovery" closure. `discover()` returns `result` and increments a
 * call counter, standing in for the network round-trip the cache exists to
 * avoid. No real I/O occurs.
 */
function countedDiscovery(result: DiscoveryResult): { discover: () => DiscoveryResult; calls: () => number } {
  let calls = 0;
  return {
    discover: () => {
      calls += 1;
      return result;
    },
    calls: () => calls,
  };
}

/**
 * The read-through pattern the Model_Discovery_Service uses: on a `refresh`, or
 * on a cache miss, run discovery and store it; otherwise serve the cached value.
 * Returns the value handed back to the caller.
 */
function readThrough(
  cache: DiscoveryCache,
  providerId: string,
  now: number,
  refresh: boolean,
  discover: () => DiscoveryResult,
): DiscoveryResult {
  if (!refresh) {
    const hit = cache.get(providerId, now);
    if (hit !== undefined) return hit;
  }
  const fresh = discover();
  cache.set(providerId, fresh, now);
  return fresh;
}

describe("Feature: byok-chat-ux-and-model-discovery, Property 13: Cache serves within TTL, invalidates on change, and refresh bypasses", () => {
  // Validates: Requirements 16.1, 16.2, 16.4, 17.2
  it("serves the cached value within its TTL without re-running discovery (zero network calls)", () => {
    fc.assert(
      fc.property(
        arbProviderId().chain((providerId) =>
          fc.record({
            providerId: fc.constant(providerId),
            result: arbDiscoveryResult(providerId),
            t0: fc.integer({ min: 0, max: 5_000_000 }),
            // A second offset into the live window, strictly before expiry.
            withinFraction: fc.double({ min: 0, max: 1, noNaN: true, maxExcluded: true }),
          }),
        ),
        ({ providerId, result, t0, withinFraction }) => {
          const cache = createDiscoveryCache();
          const { discover, calls } = countedDiscovery(result);

          // First read seeds the cache (exactly one discovery call).
          const seeded = readThrough(cache, providerId, t0, false, discover);
          expect(seeded).toBe(result);
          expect(calls()).toBe(1);

          // Any read strictly inside the TTL is served from cache: same value,
          // still ZERO additional discovery calls (Req 16.1, 16.2, 17.2).
          const ttl = ttlForResult(result);
          const within = t0 + Math.floor(withinFraction * ttl); // in [t0, t0 + ttl - 1]
          const served = readThrough(cache, providerId, within, false, discover);
          expect(served).toBe(result);
          expect(calls()).toBe(1);

          // The cache itself reports the same hit at that instant.
          expect(cache.get(providerId, within)).toBe(result);

          // At/after expiry the entry is a miss, so a read re-discovers.
          const reDiscover = countedDiscovery(result);
          readThrough(cache, providerId, t0 + ttl, false, reDiscover.discover);
          expect(reDiscover.calls()).toBe(1);
        },
      ),
      { numRuns: 200 },
    );
  });

  // Validates: Requirements 16.3
  it("evicts the entry on a config/secret/scope change so the next read re-discovers", () => {
    fc.assert(
      fc.property(
        arbProviderId().chain((providerId) =>
          fc.record({
            providerId: fc.constant(providerId),
            result: arbDiscoveryResult(providerId),
            t0: fc.integer({ min: 0, max: 5_000_000 }),
            dt: fc.integer({ min: 0, max: ERROR_TTL_MS - 1 }), // still within any TTL
          }),
        ),
        ({ providerId, result, t0, dt }) => {
          const cache = createDiscoveryCache();
          const { discover, calls } = countedDiscovery(result);

          readThrough(cache, providerId, t0, false, discover);
          expect(calls()).toBe(1);
          // Sanity: it WOULD be a hit at t0 + dt if not invalidated.
          expect(cache.get(providerId, t0 + dt)).toBe(result);

          // A config/secret/scope change evicts the entry (Req 16.3).
          cache.invalidate(providerId);

          // The evicted entry is a miss even though it is well within the TTL...
          expect(cache.get(providerId, t0 + dt)).toBeUndefined();
          // ...so the next read re-runs discovery.
          const after = countedDiscovery(result);
          readThrough(cache, providerId, t0 + dt, false, after.discover);
          expect(after.calls()).toBe(1);
        },
      ),
      { numRuns: 200 },
    );
  });

  // Validates: Requirements 17.2
  it("always re-runs discovery and overwrites the entry on refresh, even within the TTL", () => {
    fc.assert(
      fc.property(
        arbProviderId().chain((providerId) =>
          fc.record({
            providerId: fc.constant(providerId),
            first: arbDiscoveryResult(providerId),
            second: arbDiscoveryResult(providerId),
            t0: fc.integer({ min: 0, max: 5_000_000 }),
            dt: fc.integer({ min: 0, max: ERROR_TTL_MS - 1 }), // within any TTL
          }),
        ),
        ({ providerId, first, second, t0, dt }) => {
          const cache = createDiscoveryCache();

          const seed = countedDiscovery(first);
          readThrough(cache, providerId, t0, false, seed.discover);
          expect(seed.calls()).toBe(1);

          // A refresh inside the TTL bypasses the cache: discovery re-runs and
          // the entry is overwritten with the fresh result (Req 17.2).
          const refresh = countedDiscovery(second);
          const refreshed = readThrough(cache, providerId, t0 + dt, true, refresh.discover);
          expect(refresh.calls()).toBe(1);
          expect(refreshed).toBe(second);

          // The overwritten value is now what the cache serves, with its expiry
          // measured from the refresh instant (not the original seed).
          expect(cache.get(providerId, t0 + dt)).toBe(second);
          const secondTtl = ttlForResult(second);
          expect(cache.get(providerId, t0 + dt + secondTtl - 1)).toBe(second);
          expect(cache.get(providerId, t0 + dt + secondTtl)).toBeUndefined();
        },
      ),
      { numRuns: 200 },
    );
  });

  // Validates: Requirements 16.4
  it("stores an error/empty result with a strictly shorter TTL than a successful one", () => {
    // The bound itself is a fixed invariant of the cache.
    expect(ERROR_TTL_MS).toBeLessThan(SUCCESS_TTL_MS);

    fc.assert(
      fc.property(
        arbProviderId().chain((providerId) =>
          fc.record({
            providerId: fc.constant(providerId),
            success: arbSuccessResult(providerId),
            errorOrEmpty: arbErrorOrEmptyResult(providerId),
            t0: fc.integer({ min: 0, max: 5_000_000 }),
          }),
        ),
        ({ providerId, success, errorOrEmpty, t0 }) => {
          // The classifier assigns the correct TTL per result kind (Req 16.4).
          expect(ttlForResult(success)).toBe(SUCCESS_TTL_MS);
          expect(ttlForResult(errorOrEmpty)).toBe(ERROR_TTL_MS);

          // Expiry behavior follows the TTL: at t0 + ERROR_TTL_MS the error/empty
          // entry has already expired while the successful one is still served,
          // proving the error/empty TTL is strictly shorter.
          const errCache = createDiscoveryCache();
          errCache.set(providerId, errorOrEmpty, t0);
          expect(errCache.get(providerId, t0 + ERROR_TTL_MS - 1)).toBe(errorOrEmpty);
          expect(errCache.get(providerId, t0 + ERROR_TTL_MS)).toBeUndefined();

          const okCache = createDiscoveryCache();
          okCache.set(providerId, success, t0);
          expect(okCache.get(providerId, t0 + ERROR_TTL_MS)).toBe(success);
          expect(okCache.get(providerId, t0 + SUCCESS_TTL_MS - 1)).toBe(success);
          expect(okCache.get(providerId, t0 + SUCCESS_TTL_MS)).toBeUndefined();
        },
      ),
      { numRuns: 200 },
    );
  });
});
