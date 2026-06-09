/**
 * Task 2.4 — Invalid-mode halt property test.
 *
 * **Feature: cloud-capable-transition, Property 3: An invalid mode value halts startup with a redacted, named error**
 * **Validates: Requirements 1.6**
 *
 * Property 3: WHEN the resolved Orchestrator_Mode value does not exactly match
 * `local` or `external` (case-sensitive), resolving the Orchestration_Config
 * raises an {@link OrchestrationConfigError} (code `ORCHESTRATOR_MODE_INVALID`)
 * whose redacted message AND setup hint name the accepted values `local` and
 * `external`, and leak no secret (Requirement 1.6).
 *
 * The generator covers any non-empty `ORCHESTRATOR_MODE` value that is not
 * exactly `local`/`external`: free-form noise, deliberate case variants
 * (`Local`, `EXTERNAL`), and whitespace-padded near-misses (`local `,
 * `\texternal`) — every one of which must halt rather than resolve. A
 * whitespace-only value is explicitly excluded because it resolves to `local`
 * (Requirement 9.5), not an error. To prove the secret-confinement invariant,
 * each case can embed a key-like secret into the rejected value; the property
 * asserts neither the error message nor the setup hint contains that secret.
 *
 * The Provider_Config_Store and Secret_Store are counting doubles that record
 * every access. Because an invalid mode must halt BEFORE any store read, the
 * property also asserts both stores were never consulted. The test is fully
 * hermetic: zero disk, zero network, zero clock — only pure resolution logic.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { resolveOrchestrationConfig } from "../src/providers/orchestrationConfig";
import { OrchestrationConfigError } from "../src/deployment";
import { emptyProviderConfigState, type ProviderConfigState } from "../src/providers/config";
import type { ProviderConfigStore } from "../src/providers/configStore";
import type { SecretStore } from "../src/security/secretStore";
import { arbKeyLikeSecret } from "./support/byokArbitraries";

/**
 * Counting store doubles. An invalid mode must be rejected before either store
 * is touched, so these record access purely to prove the halt is short-circuit.
 */
function makeCountingStores(): {
  providerConfigStore: ProviderConfigStore;
  secretStore: SecretStore;
  counts: () => { getStateCalls: number; hasSecretCalls: number };
} {
  let getStateCalls = 0;
  let hasSecretCalls = 0;

  const providerConfigStore: ProviderConfigStore = {
    async getState(): Promise<ProviderConfigState> {
      getStateCalls += 1;
      return emptyProviderConfigState();
    },
    async upsertProvider() {
      throw new Error("upsertProvider must not be called during config resolution");
    },
    async removeProvider() {
      throw new Error("removeProvider must not be called during config resolution");
    },
    async setActiveRoute() {
      throw new Error("setActiveRoute must not be called during config resolution");
    },
  };

  const secretStore: SecretStore = {
    async hasSecret(): Promise<boolean> {
      hasSecretCalls += 1;
      return false;
    },
    async getSecret() {
      throw new Error("getSecret must not be called during config resolution");
    },
    async setSecret() {
      throw new Error("setSecret must not be called during config resolution");
    },
  };

  return {
    providerConfigStore,
    secretStore,
    counts: () => ({ getStateCalls, hasSecretCalls }),
  };
}

/**
 * A raw base value that is non-empty after trimming and is not exactly
 * `local`/`external`. Mixes free-form strings with deliberate case and
 * whitespace-padded near-misses so case-sensitivity (Requirement 1.6) is
 * exercised directly.
 */
const arbInvalidModeBase: fc.Arbitrary<string> = fc
  .oneof(
    fc.string({ minLength: 1, maxLength: 40 }),
    fc.constantFrom(
      "Local",
      "LOCAL",
      "lOcal",
      "External",
      "EXTERNAL",
      "eXternal",
      "local ",
      " local",
      "external ",
      " external",
      "\tlocal",
      "external\n",
      "loc",
      "ext",
      "locale",
      "externally",
      "locallocal",
      "remote",
      "prod",
      "default",
    ),
  )
  .filter((value) => value.trim().length > 0 && value !== "local" && value !== "external");

describe("Feature: cloud-capable-transition, Property 3: An invalid mode value halts startup with a redacted, named error", () => {
  // Validates: Requirements 1.6
  it("rejects any non-local/non-external mode with a named ORCHESTRATOR_MODE_INVALID error that leaks no secret", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbInvalidModeBase,
        arbKeyLikeSecret(),
        fc.boolean(),
        async (base, secret, embedSecret) => {
          // When embedding, the rejected value carries a secret; the result must
          // still be invalid (it can never equal "local"/"external").
          const mode = embedSecret ? `${base}${secret}` : base;

          const { providerConfigStore, secretStore, counts } = makeCountingStores();

          let thrown: unknown;
          try {
            await resolveOrchestrationConfig({
              env: { ORCHESTRATOR_MODE: mode },
              providerConfigStore,
              secretStore,
            });
          } catch (error) {
            thrown = error;
          }

          // (1) Resolution halts with the named config error.
          expect(thrown).toBeInstanceOf(OrchestrationConfigError);
          const err = thrown as OrchestrationConfigError;
          expect(err.code).toBe("ORCHESTRATOR_MODE_INVALID");

          // (2) Both the message and the setup hint name the accepted values.
          expect(err.message).toContain("local");
          expect(err.message).toContain("external");
          expect(err.setupHint).toContain("local");
          expect(err.setupHint).toContain("external");

          // (3) The redacted error leaks no secret value.
          expect(err.message).not.toContain(secret);
          expect(err.setupHint).not.toContain(secret);

          // (4) The halt short-circuits before any store is consulted.
          expect(counts()).toEqual({ getStateCalls: 0, hasSecretCalls: 0 });
        },
      ),
      { numRuns: 200 },
    );
  });
});
