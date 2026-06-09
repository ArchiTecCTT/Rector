/**
 * Task 6.3 — Settings_API discovery error-relay property test.
 *
 * **Feature: cloud-capable-transition, Property 17: The Settings_API relays any Discovery_Error category without throwing**
 * **Validates: Requirements 4.5**
 *
 * For any Discovery_Error category the injected {@link ModelDiscoveryService}
 * returns, the Settings_API discovery handler ({@link runSettingsDiscovery})
 * relays that classified error to the caller WITHOUT throwing: it resolves to a
 * `{ ok: false }` {@link DiscoveryResult} that preserves the provider id and the
 * exact category/message the service produced (Requirement 4.5). The relayed
 * result also passes cleanly through the route's outbound redaction boundary
 * ({@link redactOutbound}), modelling the `sendRedacted` serialization the
 * Express route applies before the payload leaves the process (Requirement 4.4).
 *
 * The test drives the real exported handler with:
 *
 *   - `mode: "external"` so the service is actually consulted (the local-mode
 *     short-circuit is covered by task 6.4);
 *   - a **counting fake** {@link ModelDiscoveryService} whose `discover` returns
 *     a `{ ok: false }` result of an arbitrary category and message, recording
 *     how many times it ran;
 *   - a `fetchImpl` double that records calls — the handler must never touch the
 *     network itself, it only relays the service result;
 *   - injected no-op timers so the 30 000 ms Settings_API deadline never fires
 *     and the run stays hermetic and instant (the service resolves immediately,
 *     winning the race before any timer would).
 *
 * Across ≥100 hermetic iterations the assertions prove, for every category, that
 * the handler did not throw, invoked the service exactly once, made zero network
 * calls, and relayed the classified error unchanged through the redaction
 * boundary.
 *
 * There is ZERO disk, network, or provider I/O: the service is a local closure,
 * `fetchImpl` is never invoked, and timers are no-ops.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { runSettingsDiscovery, SETTINGS_DISCOVERY_TIMEOUT_MS } from "../src/api/server";
import {
  DiscoveryErrorCategorySchema,
  type DiscoveryError,
  type DiscoveryResult,
} from "../src/providers/discovery/types";
import type {
  DiscoverOptions,
  ModelDiscoveryService,
} from "../src/providers/discovery/service";
import { redactOutbound } from "../src/security/redaction";

/** A fixed, schema-valid ISO timestamp for the service result metadata. */
const TS = "2026-01-01T00:00:00.000Z";

/** Every classified Discovery_Error category the service can return. */
const ERROR_CATEGORIES = DiscoveryErrorCategorySchema.options;

/** Arbitrary non-empty provider id, shaped like the real `kind:label` ids. */
const arbProviderId = (): fc.Arbitrary<string> =>
  fc
    .string({ minLength: 1, maxLength: 24 })
    .filter((s) => s.trim().length > 0)
    .map((s) => s.trim());

/**
 * A counting fake {@link ModelDiscoveryService} that always returns a classified
 * error result of the given `category`/`message`, recording how many times its
 * `discover` ran so the relay path is provably exercised.
 */
function makeErrorService(
  category: DiscoveryError["category"],
  message: string,
): { service: ModelDiscoveryService; calls: () => number } {
  let calls = 0;
  return {
    service: {
      async discover(providerId: string, _options?: DiscoverOptions): Promise<DiscoveryResult> {
        calls += 1;
        return {
          ok: false,
          providerId,
          error: { category, message },
          lastRefreshedAt: TS,
        };
      },
    },
    calls: () => calls,
  };
}

describe("Feature: cloud-capable-transition, Property 17: The Settings_API relays any Discovery_Error category without throwing", () => {
  // Validates: Requirements 4.5
  it("relays any classified Discovery_Error from the service unchanged, without throwing or touching the network", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          providerId: arbProviderId(),
          category: fc.constantFrom(...ERROR_CATEGORIES),
          // Arbitrary message, including characters the redactor might touch, to
          // exercise the route's outbound redaction boundary on the relayed value.
          message: fc.string({ maxLength: 64 }),
          refresh: fc.boolean(),
        }),
        async ({ providerId, category, message, refresh }) => {
          const { service, calls } = makeErrorService(category, message);

          // The handler must never hit the network itself; a call here is a bug.
          let fetchCalls = 0;
          const fetchImpl = (async () => {
            fetchCalls += 1;
            throw new Error("network access is forbidden in this hermetic test");
          }) as unknown as typeof fetch;

          // No-op timers: the Settings_API deadline must never fire because the
          // service resolves immediately and wins the race. Keeps the run instant.
          const setTimeoutImpl = (() => 0 as unknown) as (
            handler: () => void,
            ms: number,
          ) => ReturnType<typeof setTimeout>;
          const clearTimeoutImpl = (() => {}) as (
            handle: ReturnType<typeof setTimeout>,
          ) => void;

          // The handler must not throw for ANY category.
          const result = await runSettingsDiscovery({
            mode: "external",
            service,
            providerId,
            refresh,
            fetchImpl,
            timeoutMs: SETTINGS_DISCOVERY_TIMEOUT_MS,
            now: () => new Date(TS),
            setTimeoutImpl,
            clearTimeoutImpl,
          });

          // The service was consulted exactly once and no network call was made.
          expect(calls()).toBe(1);
          expect(fetchCalls).toBe(0);

          // The classified error is relayed unchanged: same provider id, same
          // category, same message — the handler does not swallow or re-classify.
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.providerId).toBe(providerId);
            expect(result.error.category).toBe(category);
            expect(result.error.message).toBe(message);
          }

          // The relayed result passes cleanly through the route's outbound
          // redaction boundary (sendRedacted), preserving the classification.
          const outbound = redactOutbound(result);
          expect(outbound.ok).toBe(true);
          if (outbound.ok) {
            const redacted = outbound.value;
            expect(redacted.ok).toBe(false);
            if (!redacted.ok) {
              expect(redacted.providerId).toBe(providerId);
              expect(redacted.error.category).toBe(category);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
