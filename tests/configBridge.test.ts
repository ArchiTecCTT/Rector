/**
 * Task 4.2 — Config_Bridge unit + property tests
 * (Requirements 13.4, 13.5, 13.6, 14.3, 14.4).
 *
 * The Config_Bridge (`src/providers/configBridge.ts`) is the single place where
 * persisted non-secret {@link ProviderConfigRecord}s and their `Secret_Store`
 * secrets are resolved into (a) the effective environment used to construct
 * providers and (b) the External_Mode {@link ModelRouter}. These tests drive
 * that real code path through deterministic doubles only — an in-memory
 * Provider_Config_Store and a fake {@link SecretStore} — with ZERO disk,
 * network, or live provider calls (every provider is built with
 * `enableNetwork: false`).
 *
 * They cover the design's Correctness Properties relevant to the bridge:
 *
 *   - Property 6 (Deterministic precedence, Req 13.4) — persisted UI config wins
 *     over `process.env` for every provider field, on every resolution.
 *
 *   - Property 1 (No secret egress, Req 13.6) — a secret value never appears in
 *     any surfaceable output a caller could log/serialize (the selection shape,
 *     the resolved provider's metadata). The effective env map is internal and
 *     deliberately carries the secret for provider construction only.
 *
 *   - Active_Route_Map honoring + fallback (Req 14.3, 14.4) — a designated,
 *     valid provider is selected for its role; a missing/invalid designation
 *     falls back to the capability-priority selection rather than failing.
 *
 *   - Property 8 (Sandbox secret isolation, Req 13.5) — the bridge produces a
 *     fresh effective env and never mutates the base environment the sandbox
 *     executor draws from, so a secret can never leak into the sandbox shape.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  type ProviderConfigRecord,
} from "../src/providers/config";
import {
  createInMemoryProviderConfigStore,
  type ProviderConfigStore,
} from "../src/providers/configStore";
import {
  buildConfiguredRouter,
  resolveProviderEnv,
  resolveTestProvider,
  type ProviderEnv,
} from "../src/providers/configBridge";
import type { ModelSelection } from "../src/providers/llm";
import type { SecretStore, SecretStoreResult } from "../src/security/secretStore";

const FIXED_TS = "2026-01-01T00:00:00.000Z";

/**
 * A deterministic in-memory {@link SecretStore} double. Holds secret values in
 * a closure map; never touches disk or the network. Mirrors the discriminated
 * `SecretStoreResult` contract so the bridge exercises the same read path it
 * would against the real encrypted store.
 */
function createFakeSecretStore(initial: Record<string, string> = {}): SecretStore {
  const secrets = new Map<string, string>(Object.entries(initial));
  return {
    async setSecret(providerId: string, value: string): Promise<SecretStoreResult<void>> {
      secrets.set(providerId, value);
      return { ok: true, value: undefined };
    },
    async getSecret(providerId: string): Promise<SecretStoreResult<string>> {
      const value = secrets.get(providerId);
      return value === undefined
        ? { ok: false, error: `No secret stored for provider "${providerId}".` }
        : { ok: true, value };
    },
    async hasSecret(providerId: string): Promise<boolean> {
      return secrets.has(providerId);
    },
  };
}

/** Build a minimal, schema-valid non-secret record. */
function makeRecord(overrides: Partial<ProviderConfigRecord> = {}): ProviderConfigRecord {
  return {
    id: "openai-compatible:proxy",
    kind: "openai-compatible",
    label: "Proxy",
    baseUrl: "https://proxy.example.com/v1",
    model: "model-default",
    secretRef: "secret:openai-compatible:proxy",
    createdAt: FIXED_TS,
    updatedAt: FIXED_TS,
    ...overrides,
  };
}

/** Seed an in-memory store with records (and optional active routes). */
async function seedStore(
  records: ProviderConfigRecord[],
  activeRoutes: Partial<Record<"flagship" | "slm", string>> = {},
): Promise<ProviderConfigStore> {
  const store = createInMemoryProviderConfigStore();
  for (const record of records) {
    const result = await store.upsertProvider(record);
    expect(result.ok).toBe(true);
  }
  for (const [role, id] of Object.entries(activeRoutes)) {
    await store.setActiveRoute(role as "flagship" | "slm", id ?? null);
  }
  return store;
}

/**
 * The *surfaceable* projection of a selection: exactly what a caller (trace,
 * API response, log) could observe without reaching into a provider's private
 * fields. The leak tests assert no secret appears here.
 */
function surfaceableSelection(selection: ModelSelection): unknown {
  return {
    providerId: selection.provider.metadata.id,
    displayName: selection.provider.metadata.displayName,
    models: selection.provider.metadata.models,
    routes: selection.provider.metadata.routes,
    modelRoute: selection.modelRoute,
    model: selection.model,
    reason: selection.reason,
  };
}

describe("Config_Bridge — Property 6: deterministic precedence (Req 13.4)", () => {
  it("overlays persisted UI config + injected secret over process.env", async () => {
    const baseEnv: ProviderEnv = {
      TOGETHER_API_KEY: "env-key-should-lose",
      TOGETHER_BASE_URL: "https://env.together.example/v1",
      UNRELATED: "keep-me",
    };
    const store = await seedStore([
      makeRecord({
        id: "together:main",
        kind: "together",
        label: "Together",
        baseUrl: "https://ui.together.example/v1",
        model: undefined,
        secretRef: "secret:together:main",
      }),
    ]);
    const secrets = createFakeSecretStore({ "secret:together:main": "ui-secret-key" });

    const effective = await resolveProviderEnv(store, secrets, baseEnv);

    // Persisted UI config wins over the ambient env value.
    expect(effective.TOGETHER_BASE_URL).toBe("https://ui.together.example/v1");
    // The injected secret wins over the env-provided key.
    expect(effective.TOGETHER_API_KEY).toBe("ui-secret-key");
    // Untouched env entries pass through as the documented fallback.
    expect(effective.UNRELATED).toBe("keep-me");
  });

  it("falls back to process.env for any field the user did not set", async () => {
    const baseEnv: ProviderEnv = { TOGETHER_BASE_URL: "https://env.together.example/v1" };
    // Record with no baseUrl: env remains the fallback for that field.
    const store = await seedStore([
      makeRecord({ id: "together:main", kind: "together", baseUrl: undefined, model: undefined, secretRef: "secret:t" }),
    ]);
    const secrets = createFakeSecretStore({ "secret:t": "k" });

    const effective = await resolveProviderEnv(store, secrets, baseEnv);
    expect(effective.TOGETHER_BASE_URL).toBe("https://env.together.example/v1");
  });

  it("resolves identically on every resolution (determinism) and never mutates baseEnv", async () => {
    const baseEnv: ProviderEnv = { OPENAI_COMPATIBLE_BASE_URL: "https://env.example/v1" };
    const frozenSnapshot = { ...baseEnv };
    const store = await seedStore([
      makeRecord({ baseUrl: "https://ui.example/v1", model: "ui-model", secretRef: "secret:proxy" }),
    ]);
    const secrets = createFakeSecretStore({ "secret:proxy": "deadbeef-secret" });

    const first = await resolveProviderEnv(store, secrets, baseEnv);
    const second = await resolveProviderEnv(store, secrets, baseEnv);

    expect(first).toEqual(second);
    expect(first.OPENAI_COMPATIBLE_BASE_URL).toBe("https://ui.example/v1");
    expect(first.OPENAI_COMPATIBLE_MODEL).toBe("ui-model");
    // The caller's base environment is never mutated.
    expect(baseEnv).toEqual(frozenSnapshot);
    expect(first).not.toBe(baseEnv);
  });
});

describe("Config_Bridge — Active_Route_Map honoring + fallback (Req 14.3, 14.4)", () => {
  const oc1 = makeRecord({ id: "openai-compatible:one", label: "One", model: "model-one", secretRef: "secret:one" });
  const oc2 = makeRecord({ id: "openai-compatible:two", label: "Two", model: "model-two", secretRef: "secret:two" });

  function bothSecrets(): SecretStore {
    return createFakeSecretStore({ "secret:one": "key-one", "secret:two": "key-two" });
  }

  it("selects the provider designated for the flagship role", async () => {
    const store = await seedStore([oc1, oc2], { flagship: oc2.id });
    const router = await buildConfiguredRouter({
      store,
      secrets: bothSecrets(),
      baseEnv: {},
      enableNetwork: false,
    });

    const selection = router.select({ capability: "flagship" });

    // The designated record (oc2) controls the selection: its model id is served
    // and the reason records the active-route override by record id.
    expect(selection.model).toBe("model-two");
    expect(selection.reason).toContain("active route flagship");
    expect(selection.reason).toContain(oc2.id);
  });

  it("falls back to capability-priority selection when the designated id is unknown", async () => {
    const store = await seedStore([oc1, oc2], { flagship: "openai-compatible:does-not-exist" });
    const router = await buildConfiguredRouter({
      store,
      secrets: bothSecrets(),
      baseEnv: {},
      enableNetwork: false,
    });

    const selection = router.select({ capability: "flagship" });

    // No active-route override applied; the base capability-priority pick stands
    // (the first configured openai-compatible provider, oc1).
    expect(selection.reason).not.toContain("active route");
    expect(selection.model).toBe("model-one");
  });

  it("falls back when the designated provider is configured but invalid (missing secret)", async () => {
    const store = await seedStore([oc1, oc2], { flagship: oc2.id });
    // Only oc1 has a secret; oc2's key is absent so its validateConfig() fails.
    const secrets = createFakeSecretStore({ "secret:one": "key-one" });
    const router = await buildConfiguredRouter({ store, secrets, baseEnv: {}, enableNetwork: false });

    const selection = router.select({ capability: "flagship" });

    // The invalid designation is ignored; selection falls back to the valid oc1.
    expect(selection.reason).not.toContain("active route");
    expect(selection.model).toBe("model-one");
  });

  it("returns the unavailable provider when no configured provider is valid", async () => {
    const store = await seedStore([oc1], { flagship: oc1.id });
    // No secret for oc1: it is invalid, so the configured router yields a non-live unavailable fallback.
    const secrets = createFakeSecretStore({});
    const router = await buildConfiguredRouter({ store, secrets, baseEnv: {}, enableNetwork: false });

    const selection = router.select({ capability: "flagship" });

    expect(selection.provider.metadata.id).toBe("unavailable");
    expect(selection.reason).not.toContain("active route");
  });
});

describe("Config_Bridge — resolveTestProvider (Req 13.2 / 14)", () => {
  it("builds exactly one non-networked provider from the persisted record", async () => {
    const store = await seedStore([makeRecord({ id: "openai-compatible:proxy", model: "m" })]);
    const secrets = createFakeSecretStore({ "secret:openai-compatible:proxy": "key" });

    const provider = await resolveTestProvider("openai-compatible:proxy", store, secrets, {
      enableNetwork: false,
    });

    expect(provider).toBeDefined();
    expect(provider?.metadata.id).toBe("openai-compatible");
    // The constructed provider validates from the resolved record + secret.
    expect(() => provider?.validateConfig()).not.toThrow();
  });

  it("returns undefined for an unknown provider id so the caller can reject pre-build", async () => {
    const store = await seedStore([makeRecord()]);
    const secrets = createFakeSecretStore({});
    expect(await resolveTestProvider("nope", store, secrets, { enableNetwork: false })).toBeUndefined();
  });
});

describe("Config_Bridge — Property 1: no secret egress in surfaceable output (Req 13.6)", () => {
  it("never exposes the secret in the selection shape a caller could surface", async () => {
    const secret = "sk-LIVE-DEADBEEF-supersecret-value";
    const store = await seedStore(
      [makeRecord({ id: "openai-compatible:proxy", model: "model-x", secretRef: "secret:proxy" })],
      { flagship: "openai-compatible:proxy" },
    );
    const secrets = createFakeSecretStore({ "secret:proxy": secret });
    const router = await buildConfiguredRouter({ store, secrets, baseEnv: {}, enableNetwork: false });

    const selection = router.select({ capability: "flagship" });
    const surfaced = JSON.stringify(surfaceableSelection(selection));
    expect(surfaced.includes(secret)).toBe(false);

    // The resolved test provider's metadata (its surfaceable shape) is also clean.
    const provider = await resolveTestProvider("openai-compatible:proxy", store, secrets, { enableNetwork: false });
    expect(JSON.stringify(provider?.metadata).includes(secret)).toBe(false);
  });

  it("keeps generated secrets out of every surfaceable bridge output (property)", async () => {
    // Long, high-entropy secrets so a coincidental match is implausible.
    const secretArb = fc.string({ minLength: 24, maxLength: 200 }).filter((s) => s.trim().length >= 24);

    await fc.assert(
      fc.asyncProperty(secretArb, async (secret) => {
        const record = makeRecord({
          id: "openai-compatible:gen",
          model: "gen-model",
          secretRef: "secret:gen",
        });
        const store = await seedStore([record], { flagship: record.id });
        const secrets = createFakeSecretStore({ "secret:gen": secret });

        const router = await buildConfiguredRouter({ store, secrets, baseEnv: {}, enableNetwork: false });
        const selection = router.select({ capability: "flagship" });
        const provider = await resolveTestProvider(record.id, store, secrets, { enableNetwork: false });

        // No surfaceable output (selection projection or provider metadata) may
        // contain the secret value.
        expect(JSON.stringify(surfaceableSelection(selection)).includes(secret)).toBe(false);
        expect((JSON.stringify(provider?.metadata) ?? "").includes(secret)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});

describe("Config_Bridge — Property 8: sandbox secret isolation (Req 13.5)", () => {
  it("never mutates the base environment the sandbox executor draws from", async () => {
    // Model the environment the sandbox executor would inherit. The bridge must
    // overlay secrets onto a *copy* only, leaving this base shape secret-free.
    const sandboxBaseEnv: ProviderEnv = { PATH: "/usr/bin", HOME: "/home/rector" };
    const baseSnapshot = { ...sandboxBaseEnv };
    const secret = "sandbox-must-never-see-this-secret";
    const store = await seedStore([
      makeRecord({ id: "together:main", kind: "together", baseUrl: "https://ui.together/v1", model: undefined, secretRef: "secret:t" }),
    ]);
    const secrets = createFakeSecretStore({ "secret:t": secret });

    const effective = await resolveProviderEnv(store, secrets, sandboxBaseEnv);

    // The injected secret lives only in the fresh effective env (for provider
    // construction) — never in the base env the sandbox inherits.
    expect(effective.TOGETHER_API_KEY).toBe(secret);
    expect(effective).not.toBe(sandboxBaseEnv);
    expect(sandboxBaseEnv).toEqual(baseSnapshot);
    expect(JSON.stringify(sandboxBaseEnv).includes(secret)).toBe(false);

    // Conceptually: a sandbox env derived from the base shape carries no secret.
    const sandboxEnv = { ...sandboxBaseEnv };
    expect(Object.values(sandboxEnv).some((value) => value === secret)).toBe(false);
  });
});
