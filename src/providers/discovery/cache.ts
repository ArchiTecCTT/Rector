import type { DiscoveryResult } from "./types";

/**
 * Discovery_Cache (design section C — Discovery cache and invalidation).
 *
 * An in-memory, per-provider TTL cache for {@link DiscoveryResult}s produced by
 * the Model_Discovery_Service. It exists so repeated reads of a provider's model
 * catalog are served without re-calling the provider (Requirement 16.1, 16.2),
 * while a configuration, secret, or scope change can evict a provider's entry so
 * the next read re-discovers (Requirement 16.3, wired in `configStore.ts`).
 *
 * Two time-to-live bounds are applied:
 *
 * - A **successful, non-empty** result is cached for {@link SUCCESS_TTL_MS}.
 * - An **error or empty** result is cached for {@link ERROR_TTL_MS}, which is
 *   strictly shorter than {@link SUCCESS_TTL_MS} so a transient failure or an
 *   empty catalog is retried sooner than a good result is refreshed
 *   (Requirement 16.4).
 *
 * The cache holds no secret material: a {@link DiscoveryResult} carries only the
 * non-secret, redacted shapes defined in `discovery/types.ts`. Time is passed in
 * explicitly (`now`) rather than read from `Date.now()` so callers and tests
 * stay deterministic.
 */

/** Time-to-live for a successful, non-empty discovery result (5 minutes). */
export const SUCCESS_TTL_MS = 5 * 60 * 1000;

/**
 * Time-to-live for an error or empty discovery result (30 seconds). This is
 * strictly shorter than {@link SUCCESS_TTL_MS} (Requirement 16.4).
 */
export const ERROR_TTL_MS = 30 * 1000;

/**
 * The TTL-bounded, per-provider cache of discovery results. All time inputs are
 * epoch milliseconds supplied by the caller.
 */
export interface DiscoveryCache {
  /**
   * Return the cached result for `providerId` when an entry exists and has not
   * expired at `now`; otherwise return `undefined`. An expired entry is treated
   * as a miss (Requirement 16.2).
   */
  get(providerId: string, now: number): DiscoveryResult | undefined;
  /**
   * Store `result` for `providerId`, computing its expiry from `now` plus the
   * success or error TTL (Requirement 16.1, 16.4). Overwrites any prior entry.
   */
  set(providerId: string, result: DiscoveryResult, now: number): void;
  /** Evict any cached entry for `providerId` (Requirement 16.3). */
  invalidate(providerId: string): void;
}

interface DiscoveryCacheEntry {
  result: DiscoveryResult;
  expiresAt: number;
}

/**
 * Whether a result should use the shorter error/empty TTL. A failed result, or
 * a successful result with no candidates, is considered error/empty
 * (Requirement 16.4).
 */
function isErrorOrEmpty(result: DiscoveryResult): boolean {
  return !result.ok || result.candidates.length === 0;
}

/** The TTL to apply to `result`, in milliseconds (Requirement 16.1, 16.4). */
export function ttlForResult(result: DiscoveryResult): number {
  return isErrorOrEmpty(result) ? ERROR_TTL_MS : SUCCESS_TTL_MS;
}

/**
 * Create an in-memory {@link DiscoveryCache}. The returned cache is independent
 * of any global state, so each service instance (and each test) gets its own
 * isolated store.
 */
export function createDiscoveryCache(): DiscoveryCache {
  const entries = new Map<string, DiscoveryCacheEntry>();

  return {
    get(providerId, now) {
      const entry = entries.get(providerId);
      if (!entry) {
        return undefined;
      }
      if (now >= entry.expiresAt) {
        // Expired: drop it and report a miss so the next read re-discovers.
        entries.delete(providerId);
        return undefined;
      }
      return entry.result;
    },
    set(providerId, result, now) {
      entries.set(providerId, {
        result,
        expiresAt: now + ttlForResult(result),
      });
    },
    invalidate(providerId) {
      entries.delete(providerId);
    },
  };
}
