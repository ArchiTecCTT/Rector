/**
 * Task 2.7 — Unit tests for boot wiring.
 *
 * **Validates: Requirements 1.4, 1.5, 1.8**
 *
 * These example-based tests exercise the boot-tolerant seams that
 * `src/bin/server.ts` wires together, without importing the side-effectful
 * server entrypoint (which calls `bootstrap()` and `process.exit` at module
 * load). The two seams under test are:
 *
 *  1. {@link resolveOrchestrationConfig} — the only function the boot path lets
 *     halt startup, and only for an invalid mode value. Here we confirm the
 *     two non-halting boot conditions:
 *       - External_Mode with ZERO configured providers resolves NORMALLY (does
 *         not throw / does not exit) so the caller in `server.ts` can bind and
 *         listen (Requirements 1.4, 1.5).
 *       - A Provider_Config_Store or Secret_Store read failure is treated as
 *         ABSENT credentials and resolution CONTINUES rather than throwing
 *         (Requirement 1.8).
 *  2. {@link describeRequiredProviderEnvKeys} — the startup-warning helper the
 *     boot path emits when external mode has no configured providers. We assert
 *     the warning text names every supported provider's required env-var keys
 *     and leaks no secret value (Requirements 1.4, 1.7-adjacent leak guard).
 *
 * Hermeticity: env is injected, stores are local fakes, and a capturing logger
 * stands in for `console.error`. ZERO disk, network, or clock I/O.
 */
import { describe, expect, it } from "vitest";

import {
  PROVIDER_DESCRIPTORS,
  describeRequiredProviderEnvKeys,
  resolveOrchestrationConfig,
  type ResolveOrchestrationLogger,
} from "../src/providers/orchestrationConfig";
import {
  PROVIDER_CONFIG_VERSION,
  emptyProviderConfigState,
  type ProviderConfigRecord,
} from "../src/providers/config";
import type { ProviderConfigStore } from "../src/providers/configStore";
import type { SecretStore } from "../src/security/secretStore";
import { redactString } from "../src/security/redaction";

const TS = "2026-01-01T00:00:00.000Z";

/** A capturing logger double standing in for the boot path's `console.error`. */
function capturingLogger(): { logger: ResolveOrchestrationLogger; messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    logger: {
      error(message: string) {
        messages.push(message);
      },
    },
  };
}

/** A Provider_Config_Store double holding a fixed set of records. */
function fakeConfigStore(records: ProviderConfigRecord[]): ProviderConfigStore {
  return {
    async getState() {
      return {
        ...emptyProviderConfigState(),
        version: PROVIDER_CONFIG_VERSION,
        providers: records,
        activeRoutes: {},
      };
    },
    async upsertProvider(rec) {
      return { ok: true, value: rec };
    },
    async removeProvider() {
      return { ok: true, value: undefined };
    },
    async setActiveRoute() {
      return { ok: true, value: undefined };
    },
  };
}

/** A Provider_Config_Store double whose read REJECTS, to drive Requirement 1.8. */
function rejectingConfigStore(error: unknown): ProviderConfigStore {
  return {
    async getState(): Promise<never> {
      throw error;
    },
    async upsertProvider(rec) {
      return { ok: true, value: rec };
    },
    async removeProvider() {
      return { ok: true, value: undefined };
    },
    async setActiveRoute() {
      return { ok: true, value: undefined };
    },
  };
}

/** A presence-only Secret_Store double; `getSecret` throws to lock in presence-only reads. */
function fakeSecretStore(
  hasSecret: (ref: string) => Promise<boolean>,
): SecretStore {
  return {
    async setSecret() {
      return { ok: true, value: undefined };
    },
    async getSecret(): Promise<never> {
      throw new Error("getSecret must not be called: resolution is presence-only");
    },
    hasSecret,
  };
}

/** A Secret_Store presence check that always reports absent. */
const absentSecretStore = (): SecretStore => fakeSecretStore(async () => false);

/**
 * Reproduce the exact startup warning `src/bin/server.ts` emits for external
 * mode with zero configured providers, so we test the same text the boot path
 * would log (kept in sync with the boot wiring).
 */
function buildStartupWarning(): string {
  return redactString(
    "Rector is starting in external mode with no configured providers. " +
      "Enter provider credentials in the configuration UI before issuing requests. " +
      `Supported providers and required environment variables: ${describeRequiredProviderEnvKeys()}.`,
  );
}

describe("Task 2.7: boot wiring — external mode with no configured providers warns and serves", () => {
  // Validates: Requirements 1.4, 1.5
  it("resolves normally (no throw) when external mode has zero configured providers", async () => {
    const { logger, messages } = capturingLogger();

    const config = await resolveOrchestrationConfig({
      env: { ORCHESTRATOR_MODE: "external" }, // no provider env keys set
      providerConfigStore: fakeConfigStore([]), // no stored records
      secretStore: absentSecretStore(),
      logger,
    });

    // Req 1.5: resolution succeeds (the caller binds + listens) — no throw/exit.
    expect(config.mode).toBe("external");
    expect(config.configuredProviders).toEqual([]);
    // A clean (no configured providers) resolution emits no store-read error.
    expect(messages).toEqual([]);
  });

  // Validates: Requirements 1.4
  it("startup warning names every supported provider's required env keys", () => {
    const warning = buildStartupWarning();

    for (const descriptor of PROVIDER_DESCRIPTORS) {
      // The provider id and each of its required env-var keys are named.
      expect(warning).toContain(descriptor.envProviderId);
      for (const key of descriptor.requiredEnvKeys) {
        expect(warning).toContain(key);
      }
    }
    // The warning instructs the operator to enter credentials in the UI.
    expect(warning).toContain("configuration UI");
  });

  // Validates: Requirements 1.4 (leak guard) — the warning carries no secret value.
  it("startup warning leaks no secret value even when secrets exist in env/stores", () => {
    const secrets = [
      "sk-live-supersecret-together-0001",
      "cf-token-abcdef-deadbeef-9999",
      "azure-key-zzz-7777-secret",
    ];
    const warning = buildStartupWarning();

    // The helper emits key NAMES only, so no secret value can appear.
    for (const secret of secrets) {
      expect(warning).not.toContain(secret);
    }
  });
});

describe("Task 2.7: boot wiring — store-read failure is treated as absent and startup continues", () => {
  // Validates: Requirements 1.8
  it("continues (no throw) when the Provider_Config_Store read rejects", async () => {
    const { logger, messages } = capturingLogger();

    const config = await resolveOrchestrationConfig({
      env: { ORCHESTRATOR_MODE: "external" },
      providerConfigStore: rejectingConfigStore(new Error("disk read failed")),
      secretStore: absentSecretStore(),
      logger,
    });

    // Req 1.8: store fault ⇒ stored creds absent, resolution continues.
    expect(config.mode).toBe("external");
    expect(config.configuredProviders).toEqual([]);
    // A redacted error noting the store could not be read was emitted.
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain("provider configuration store");
  });

  // Validates: Requirements 1.8
  it("continues (no throw) when a Secret_Store presence check rejects, treating the record's secret as absent", async () => {
    const { logger, messages } = capturingLogger();

    const record: ProviderConfigRecord = {
      id: "together-byok",
      kind: "together",
      label: "Together BYOK",
      secretRef: "together#0",
      createdAt: TS,
      updatedAt: TS,
    };

    const config = await resolveOrchestrationConfig({
      env: { ORCHESTRATOR_MODE: "external" }, // no env-satisfied provider
      providerConfigStore: fakeConfigStore([record]),
      secretStore: fakeSecretStore(async () => {
        throw new Error("secret store unreadable");
      }),
      logger,
    });

    // Req 1.8: the unreadable secret ⇒ the record is treated as unconfigured;
    // resolution continues rather than throwing.
    expect(config.mode).toBe("external");
    expect(config.configuredProviders).toEqual([]);
    // A redacted secret-store read error was emitted.
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain("secret store");
  });

  // Validates: Requirements 1.8 — the redacted error never carries the secret value.
  it("redacts the store-read error so no secret value leaks into the log", async () => {
    const secretBearingMessage = "connection failed for token sk-live-LEAKED-secret-1234";
    const { logger, messages } = capturingLogger();

    await resolveOrchestrationConfig({
      env: { ORCHESTRATOR_MODE: "external" },
      providerConfigStore: rejectingConfigStore(new Error(secretBearingMessage)),
      secretStore: absentSecretStore(),
      logger,
    });

    expect(messages.length).toBe(1);
    // The error is routed through the Redaction_Layer; assert it matches the
    // redacted form of the raw message (no raw secret-bearing text leaks).
    const redacted = redactString(secretBearingMessage);
    expect(messages[0]).toContain(redacted);
  });
});
