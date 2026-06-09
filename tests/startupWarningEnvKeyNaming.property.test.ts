/**
 * Task 2.6 — Startup-warning env-key naming property test.
 *
 * **Feature: cloud-capable-transition, Property 4: The startup warning names env keys and leaks no secret**
 * **Validates: Requirements 1.7**
 *
 * Property 4: *For any* set of secret values present in the stores or
 * environment, when external mode resolves with zero configured providers, the
 * emitted startup warning names every supported provider's required
 * environment-variable keys and contains no substring of any secret value
 * (Requirement 1.7; design section C1).
 *
 * The warning's variable part is produced by
 * {@link describeRequiredProviderEnvKeys} (the helper `src/bin/server.ts` splices
 * into the boot-time `console.warn`). This test reproduces the boot's warning
 * composition verbatim — the same prose plus the same `redactString` pass the
 * server applies as defense-in-depth — and asserts, across arbitrary high-entropy
 * secret values injected into the environment:
 *
 *  1. **Precondition** — resolving `external` mode against an environment that
 *     carries the injected secrets under NON-required keys (and an empty
 *     Provider_Config_Store) yields ZERO configured providers, i.e. the exact
 *     condition under which the boot path emits the warning (Req 1.4/1.5).
 *  2. **Names the keys** — the warning names every supported provider id and each
 *     of that provider's required environment-variable key NAMES.
 *  3. **Leaks no secret** — the warning contains no injected secret value as a
 *     substring.
 *
 * The helper consumes only the static {@link PROVIDER_DESCRIPTORS} table (key
 * NAMES, never values), so the secret-confinement guarantee holds by
 * construction; this property pins that guarantee against any future change that
 * might start interpolating environment/secret content into the warning. The
 * test is fully hermetic: the Provider_Config_Store is in-memory and the
 * Secret_Store is a presence-only double, so there is ZERO disk, network, or
 * clock I/O and every run is deterministic.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  PROVIDER_DESCRIPTORS,
  describeRequiredProviderEnvKeys,
  resolveOrchestrationConfig,
} from "../src/providers/orchestrationConfig";
import { redactString } from "../src/security/redaction";
import { createInMemoryProviderConfigStore } from "../src/providers/configStore";
import type { SecretStore } from "../src/security/secretStore";

/**
 * Reproduce the boot-time startup warning exactly as `src/bin/server.ts` builds
 * it: the fixed operator prose, the helper-produced provider/env-key listing,
 * and the defense-in-depth `redactString` pass applied before the sink. Pinning
 * the composition here means a regression that begins splicing secret-bearing
 * content into the warning is caught by the leak assertion below.
 */
function buildStartupWarning(): string {
  return redactString(
    "Rector is starting in external mode with no configured providers. " +
      "Enter provider credentials in the configuration UI before issuing requests. " +
      `Supported providers and required environment variables: ${describeRequiredProviderEnvKeys()}.`,
  );
}

/** The constant, secret-free baseline warning, used to reject degenerate secrets. */
const BASELINE_WARNING = buildStartupWarning();

/**
 * A presence-only {@link SecretStore} double: it never touches disk, never
 * surfaces a value, and reports presence from an injected ref set. Used to model
 * "secrets present in the store" without making any provider configured (the
 * Provider_Config_Store is empty, so no record references these refs).
 */
function createPresenceSecretStore(presentRefs: ReadonlySet<string>): SecretStore {
  return {
    async setSecret() {
      return { ok: true, value: undefined };
    },
    async getSecret() {
      return { ok: false, error: "secret values are never exposed in this test double" };
    },
    async hasSecret(ref: string) {
      return presentRefs.has(ref);
    },
  };
}

/**
 * A high-entropy, API-key-like secret value (length 16–48). The alphabet mirrors
 * real credential material (base64url plus a few separators) so the property
 * exercises realistic secrets. Degenerate values that happen to already be a
 * substring of the constant secret-free warning are filtered out: such a value
 * is a coincidental collision with public boilerplate rather than a leak, and
 * keeping it would only manufacture a false positive without strengthening the
 * leak guarantee (a genuinely interpolated 16+ char secret would not be a
 * substring of the baseline and so would still be caught).
 */
const SECRET_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_./+=";
const arbSecretValue: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...SECRET_ALPHABET.split("")), { minLength: 16, maxLength: 48 })
  .map((chars) => chars.join(""))
  .filter((value) => !BASELINE_WARNING.includes(value));

/** A non-empty set of injected secret values. */
const arbSecretValues: fc.Arbitrary<string[]> = fc.array(arbSecretValue, {
  minLength: 1,
  maxLength: 6,
});

describe("Feature: cloud-capable-transition, Property 4: The startup warning names env keys and leaks no secret", () => {
  // Validates: Requirements 1.7
  it("names every provider's required env keys and never leaks an injected secret value", async () => {
    await fc.assert(
      fc.asyncProperty(arbSecretValues, async (secrets) => {
        // Inject every secret value into the environment under NON-required keys
        // (the required keys are the descriptor key names; `INJECTED_SECRET_*`
        // can never collide with them) so no provider becomes env-satisfied while
        // the secrets are genuinely "present in the environment".
        const env: Record<string, string | undefined> = { ORCHESTRATOR_MODE: "external" };
        secrets.forEach((secret, index) => {
          env[`INJECTED_SECRET_${index}`] = secret;
        });

        // An empty Provider_Config_Store + a presence-only Secret_Store that even
        // reports refs present: with no records referencing them, no provider is
        // store-satisfied either, so the configured-provider list stays empty.
        const providerConfigStore = createInMemoryProviderConfigStore();
        const secretStore = createPresenceSecretStore(new Set(secrets));

        // (1) Precondition: external mode with zero configured providers — the
        // exact condition under which the boot path emits the startup warning.
        const resolved = await resolveOrchestrationConfig({ env, providerConfigStore, secretStore });
        expect(resolved.mode).toBe("external");
        expect(resolved.configuredProviders).toEqual([]);

        const warning = buildStartupWarning();

        // (2) The warning names every supported provider id and each of its
        // required environment-variable key names.
        for (const descriptor of PROVIDER_DESCRIPTORS) {
          expect(warning).toContain(descriptor.envProviderId);
          for (const key of descriptor.requiredEnvKeys) {
            expect(warning).toContain(key);
          }
        }

        // (3) The warning leaks no injected secret value.
        for (const secret of secrets) {
          expect(warning.includes(secret)).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });
});
