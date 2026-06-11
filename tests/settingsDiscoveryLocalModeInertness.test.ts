/**
 * Task 6.4 — Settings_API local-mode inertness unit test.
 *
 * **Validates: Requirements 4.3, 4.7**
 *
 * A discovery request issued while the Orchestrator_Mode is `local` must short-circuit
 * BEFORE the Model_Discovery_Service is consulted: the handler ({@link runSettingsDiscovery})
 * returns the classified "model discovery is unavailable in local mode" Discovery_Error
 * (Requirement 4.7) and the injected {@link ModelDiscoveryService} is provably never invoked,
 * guaranteeing zero discovery network calls in local mode (Requirement 4.3).
 *
 * The test drives the real exported handler with:
 *   - `mode: "local"`;
 *   - a **counting double** {@link ModelDiscoveryService} whose `discover` records how many
 *     times it ran and would fail the test if it were ever called;
 *   - a `fetchImpl` double that records calls — the handler must touch no network in local mode;
 *   - injected no-op timers so the 30 000 ms Settings_API deadline is never armed.
 *
 * There is ZERO disk, network, or provider I/O: the service double is a local closure that is
 * never called, `fetchImpl` is never invoked, and the timers are no-ops.
 */
import { describe, expect, it } from "vitest";

import { runSettingsDiscovery, SETTINGS_DISCOVERY_TIMEOUT_MS } from "../src/api/server";
import type { DiscoveryResult } from "../src/providers/discovery/types";
import type {
  DiscoverOptions,
  ModelDiscoveryService,
} from "../src/providers/discovery/service";
import { redactString } from "../src/security/redaction";

/** A fixed, schema-valid ISO timestamp for the handler's result metadata. */
const TS = "2026-01-01T00:00:00.000Z";

/** The exact, redacted message the handler emits when discovery is requested in local mode. */
const LOCAL_MODE_MESSAGE = redactString("Model discovery is unavailable in local mode.");

/**
 * A counting double {@link ModelDiscoveryService}. In local mode the handler must never call
 * `discover`; the counter lets the test prove the service was provably untouched.
 */
function makeCountingService(): { service: ModelDiscoveryService; calls: () => number } {
  let calls = 0;
  return {
    service: {
      async discover(providerId: string, _options?: DiscoverOptions): Promise<DiscoveryResult> {
        calls += 1;
        // A reachable success result; reaching it at all is the bug this test guards against.
        return { ok: true, providerId, candidates: [], lastRefreshedAt: TS };
      },
    },
    calls: () => calls,
  };
}

describe("Task 6.4: Settings_API discovery is inert in local mode", () => {
  // Validates: Requirements 4.3, 4.7
  it("returns the discovery-unavailable error and never invokes the service or the network", async () => {
    const { service, calls } = makeCountingService();

    // A network touch here is a bug: local-mode discovery must perform zero network calls.
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      throw new Error("network access is forbidden in local mode");
    }) as unknown as typeof fetch;

    // No-op timers: the Settings_API deadline must never be armed on the local-mode path.
    let timerArmed = 0;
    const setTimeoutImpl = (() => {
      timerArmed += 1;
      return 0 as unknown;
    }) as (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
    const clearTimeoutImpl = (() => {}) as (
      handle: ReturnType<typeof setTimeout>,
    ) => void;

    const result = await runSettingsDiscovery({
      mode: "local",
      service,
      providerId: "together:my-provider",
      refresh: true,
      fetchImpl,
      timeoutMs: SETTINGS_DISCOVERY_TIMEOUT_MS,
      now: () => new Date(TS),
      setTimeoutImpl,
      clearTimeoutImpl,
    });

    // (Req 4.3) The service was never consulted and no discovery network call was made.
    expect(calls()).toBe(0);
    expect(fetchCalls).toBe(0);
    // The 30 000 ms race is not entered on the short-circuit path.
    expect(timerArmed).toBe(0);

    // (Req 4.7) The handler returns the classified "unavailable in local mode" Discovery_Error.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.providerId).toBe("together:my-provider");
      expect(result.error.category).toBe("unknown");
      expect(result.error.message).toBe(LOCAL_MODE_MESSAGE);
      expect(result.error.message.toLowerCase()).toContain("local mode");
      expect(result.lastRefreshedAt).toBe(TS);
    }
  });
});
