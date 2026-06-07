import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { computeSetupStatus } from "../src/setupStatus";
import type { SecretStore, SecretStoreResult } from "../src/security/secretStore";

/**
 * Task 2.2 — Setup status mode derivation property test.
 *
 * **Property 3: Setup status mode derivation**
 * **Validates: Requirements 1.1**
 *
 * For any environment map, `computeSetupStatus().mode` is `external` when
 * `ORCHESTRATOR_MODE` equals exactly the string `"external"`, and `local`
 * otherwise (including when the variable is unset, empty, differently-cased,
 * whitespace-padded, or any other value).
 *
 * The composer is pure: it is exercised over a generated `env` map plus an
 * in-memory {@link SecretStore} double, so the property runs with zero network
 * and zero provider calls. The double's `getSecret`/`setSecret` throw if ever
 * touched, asserting the mode path never reaches a secret-value boundary.
 */

/**
 * An in-memory {@link SecretStore} double. Only `hasSecret` is a legitimate
 * (presence-only) call for the composer; `getSecret`/`setSecret` throw so any
 * attempt to read or write a secret value during mode derivation fails loudly.
 * No method performs network or provider I/O.
 */
function fakeSecretStore(presentProviderIds: readonly string[] = []): SecretStore {
  const present = new Set(presentProviderIds);
  return {
    async setSecret(): Promise<SecretStoreResult<void>> {
      throw new Error("setSecret must not be called during mode derivation");
    },
    async getSecret(): Promise<SecretStoreResult<string>> {
      throw new Error("getSecret must not be called during mode derivation");
    },
    async hasSecret(providerId: string): Promise<boolean> {
      return present.has(providerId);
    },
  };
}

/**
 * Candidate ORCHESTRATOR_MODE values that intelligently cover the input space:
 * the exact trigger value, near-misses (case, whitespace, prefixes), unrelated
 * values, and the empty string. `undefined` (the unset case) is mixed in by the
 * arbitrary below.
 */
const orchestratorModeArb: fc.Arbitrary<string> = fc.oneof(
  fc.constant("external"),
  fc.constantFrom("local", "External", "EXTERNAL", " external", "external ", "externalx", "x", ""),
  fc.string(),
);

/** Arbitrary env keys that are NOT ORCHESTRATOR_MODE, to confirm they never affect mode. */
const otherEnvKeyArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 12 })
  .filter((key) => key !== "ORCHESTRATOR_MODE");

/**
 * Generates an env map: an optional ORCHESTRATOR_MODE entry combined with a
 * dictionary of arbitrary unrelated keys/values.
 */
const envArb: fc.Arbitrary<Record<string, string | undefined>> = fc
  .record({
    mode: fc.option(orchestratorModeArb, { nil: undefined }),
    others: fc.dictionary(otherEnvKeyArb, fc.string(), { maxKeys: 5 }),
  })
  .map(({ mode, others }) => {
    const env: Record<string, string | undefined> = { ...others };
    if (mode !== undefined) {
      env.ORCHESTRATOR_MODE = mode;
    }
    return env;
  });

describe("setup status mode derivation (Property 3)", () => {
  // Feature: productization-alpha, Property 3: Setup status mode derivation
  it("derives external mode iff ORCHESTRATOR_MODE equals exactly 'external', otherwise local", async () => {
    await fc.assert(
      fc.asyncProperty(envArb, async (env) => {
        const status = await computeSetupStatus(env, fakeSecretStore());

        const expected = env.ORCHESTRATOR_MODE === "external" ? "external" : "local";
        expect(status.mode).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });
});
