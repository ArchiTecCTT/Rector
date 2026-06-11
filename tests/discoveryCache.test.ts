/**
 * Task 6.1 — Discovery_Cache unit tests (Requirements 16.1, 16.2, 16.4).
 *
 * These exercise the in-memory, per-provider TTL cache directly with an
 * explicit `now` clock so every assertion is deterministic with ZERO disk,
 * network, or provider calls:
 *
 *   - `set`/`get` round-trip within the TTL (Req 16.1, 16.2).
 *   - an entry read at or after its expiry is a miss (Req 16.2).
 *   - `invalidate` evicts an entry (supports Req 16.3 wiring).
 *   - a successful, non-empty result uses the full success TTL while an error
 *     or empty result uses the strictly shorter error TTL (Req 16.4).
 *
 * The exhaustive cross-input behavior is covered by the Property 13 test
 * (task 6.3); these are targeted examples and edge cases.
 */
import { describe, expect, it } from "vitest";

import {
  createDiscoveryCache,
  ERROR_TTL_MS,
  SUCCESS_TTL_MS,
  ttlForResult,
} from "../src/providers/discovery/cache";
import type { DiscoveryResult, ModelCandidate } from "../src/providers/discovery/types";

const TS = "2026-01-01T00:00:00.000Z";
const PROVIDER_ID = "openai-compatible:my-proxy";

function makeCandidate(overrides: Partial<ModelCandidate> = {}): ModelCandidate {
  return {
    providerId: PROVIDER_ID,
    kind: "openai-compatible",
    scope: {},
    displayName: "GPT-4o mini",
    capabilities: ["chat"],
    requiresDeployment: false,
    requiresRegion: false,
    source: "openai-compatible",
    lastRefreshedAt: TS,
    ...overrides,
  };
}

function successResult(candidates: ModelCandidate[] = [makeCandidate()]): DiscoveryResult {
  return { ok: true, providerId: PROVIDER_ID, candidates, lastRefreshedAt: TS };
}

function errorResult(): DiscoveryResult {
  return {
    ok: false,
    providerId: PROVIDER_ID,
    error: { category: "network_error", message: "discovery failed" },
    lastRefreshedAt: TS,
  };
}

describe("Discovery_Cache", () => {
  it("serves a stored result within its TTL (Req 16.1, 16.2)", () => {
    const cache = createDiscoveryCache();
    const result = successResult();

    cache.set(PROVIDER_ID, result, 0);

    expect(cache.get(PROVIDER_ID, 0)).toBe(result);
    expect(cache.get(PROVIDER_ID, SUCCESS_TTL_MS - 1)).toBe(result);
  });

  it("treats an entry at or after expiry as a miss (Req 16.2)", () => {
    const cache = createDiscoveryCache();
    cache.set(PROVIDER_ID, successResult(), 0);

    expect(cache.get(PROVIDER_ID, SUCCESS_TTL_MS)).toBeUndefined();
    expect(cache.get(PROVIDER_ID, SUCCESS_TTL_MS + 1_000)).toBeUndefined();
  });

  it("returns undefined for an unknown provider id", () => {
    const cache = createDiscoveryCache();
    expect(cache.get("unconfigured:nope", 0)).toBeUndefined();
  });

  it("evicts an entry on invalidate (Req 16.3 wiring)", () => {
    const cache = createDiscoveryCache();
    cache.set(PROVIDER_ID, successResult(), 0);

    cache.invalidate(PROVIDER_ID);

    expect(cache.get(PROVIDER_ID, 0)).toBeUndefined();
  });

  it("overwrites a prior entry and resets its expiry", () => {
    const cache = createDiscoveryCache();
    cache.set(PROVIDER_ID, successResult(), 0);

    const refreshed = successResult([makeCandidate({ displayName: "Refreshed" })]);
    cache.set(PROVIDER_ID, refreshed, 10_000);

    expect(cache.get(PROVIDER_ID, 10_000)).toBe(refreshed);
    // Expiry is measured from the second `set`, not the first.
    expect(cache.get(PROVIDER_ID, 10_000 + SUCCESS_TTL_MS - 1)).toBe(refreshed);
    expect(cache.get(PROVIDER_ID, 10_000 + SUCCESS_TTL_MS)).toBeUndefined();
  });

  it("uses a strictly shorter TTL for error and empty results (Req 16.4)", () => {
    expect(ERROR_TTL_MS).toBeLessThan(SUCCESS_TTL_MS);
    expect(ttlForResult(successResult())).toBe(SUCCESS_TTL_MS);
    expect(ttlForResult(successResult([]))).toBe(ERROR_TTL_MS);
    expect(ttlForResult(errorResult())).toBe(ERROR_TTL_MS);
  });

  it("expires an error result sooner than a successful one (Req 16.4)", () => {
    const cache = createDiscoveryCache();
    cache.set(PROVIDER_ID, errorResult(), 0);

    expect(cache.get(PROVIDER_ID, ERROR_TTL_MS - 1)).toBeDefined();
    expect(cache.get(PROVIDER_ID, ERROR_TTL_MS)).toBeUndefined();
  });
});
