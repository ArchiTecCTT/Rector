/**
 * Feature: cloud-capable-transition, Property 20: An invalid designation falls
 * back and records a secret-free substitution.
 *
 * Validates: Requirements 5.4, 5.5
 *
 *   5.4 "IF a designated Provider_Config_Record is absent, is missing its
 *        required credentials or endpoint coordinates, designates no model
 *        identifier for the requested role, or raises an error when serving the
 *        route, THEN THE Model_Router SHALL select the next provider in the
 *        capability-priority fallback order rather than failing the run."
 *
 *   5.5 "WHEN the Model_Router substitutes a fallback provider for a designated
 *        route, THE Model_Router SHALL record an indication of the substitution
 *        in the run trace without including any secret value."
 *
 * The property drives the real `buildConfiguredRouter` selection path in
 * External_Mode through deterministic doubles only — an in-memory
 * Provider_Config_Store and a fake {@link SecretStore} — with ZERO disk,
 * network, or live provider access (every provider is built with
 * `enableNetwork: false`).
 *
 * For *any* Active_Route_Map whose designation for a role is invalid (the id is
 * unknown, the designated record is missing its credential, or the designated
 * provider cannot serve the route's tier), the router:
 *   (a) never fails the run — it returns a selection backed by a valid,
 *       non-fake, capability-priority provider, and
 *   (b) records a substitution marker in the selection reason (the run-trace
 *       indication) that contains NO substring of any secret value.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import type { ProviderConfigRecord } from "../src/providers/config";
import {
  createInMemoryProviderConfigStore,
  type ProviderConfigStore,
} from "../src/providers/configStore";
import { buildConfiguredRouter } from "../src/providers/configBridge";
import type { ModelSelection } from "../src/providers/llm";
import type { SecretStore, SecretStoreResult } from "../src/security/secretStore";

const FIXED_TS = "2026-01-01T00:00:00.000Z";

/** Deterministic in-memory {@link SecretStore} double — no disk, no network. */
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

/** Seed an in-memory store with records and an Active_Route_Map. */
async function seedStore(
  records: ProviderConfigRecord[],
  activeRoutes: Partial<Record<"flagship" | "slm", string>>,
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

/** A schema-valid, fully-configured openai-compatible record (supports every tier). */
function ocRecord(token: string): ProviderConfigRecord {
  return {
    id: `openai-compatible:${token}`,
    kind: "openai-compatible",
    label: `OC ${token}`,
    baseUrl: `https://${token}.proxy.example/v1`,
    model: `model-${token}`,
    secretRef: `secret:oc:${token}`,
    createdAt: FIXED_TS,
    updatedAt: FIXED_TS,
  };
}

/** A schema-valid, fully-configured cloudflare record (serves only cheap/fast). */
function cloudflareRecord(token: string): ProviderConfigRecord {
  return {
    id: `cloudflare:${token}`,
    kind: "cloudflare",
    label: `CF ${token}`,
    baseUrl: `https://${token}.cloudflare.example/client/v4`,
    cloudflare: { accountId: token },
    secretRef: `secret:cf:${token}`,
    createdAt: FIXED_TS,
    updatedAt: FIXED_TS,
  };
}

/** The surfaceable projection of a selection — exactly what a trace/log/API could observe. */
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

const tokenArb = fc.integer({ min: 1, max: 1_000_000 }).map((n) => `t${n}`);
const secretArb = fc.string({ minLength: 24, maxLength: 200 }).filter((value) => value.trim().length >= 24);

// The role under test and the capability that resolves to it: capability
// "flagship" -> route "flagship" -> role "flagship"; capability "fast" ->
// route "fast" -> role "slm".
const roleArb = fc.constantFrom(
  { role: "flagship" as const, capability: "flagship" as const, route: "flagship" as const },
  { role: "slm" as const, capability: "fast" as const, route: "fast" as const },
);

// The way the designation is made invalid. "wrong-route" (a cloudflare provider
// designated for flagship, which cloudflare cannot serve) only applies to the
// flagship role, since every kind serves the "fast"/slm tier.
const invalidVariantArb = fc.constantFrom("unknown", "missing-secret", "wrong-route");

describe("Config_Bridge — Property 20: invalid designation falls back with a secret-free substitution (Req 5.4, 5.5)", () => {
  it("never fails the run and records a secret-free substitution marker for any invalid designation", async () => {
    await fc.assert(
      fc.asyncProperty(
        roleArb,
        invalidVariantArb,
        fc.uniqueArray(tokenArb, { minLength: 3, maxLength: 3 }),
        secretArb,
        secretArb,
        async ({ role, capability, route }, rawVariant, tokens, secretA, secretB) => {
          // "wrong-route" only invalidates the flagship role; for slm fall back
          // to a "missing-secret" invalidation (the run still asserts fallback).
          const variant = rawVariant === "wrong-route" && role !== "flagship" ? "missing-secret" : rawVariant;

          const [tokA, tokB, tokBad] = tokens;
          // Two fully-valid openai-compatible providers guarantee a valid,
          // non-fake capability-priority pick for both flagship and fast tiers.
          const validA = ocRecord(tokA);
          const validB = ocRecord(tokB);

          const secretMap: Record<string, string> = {
            [validA.secretRef]: secretA,
            [validB.secretRef]: secretB,
          };
          const records: ProviderConfigRecord[] = [validA, validB];
          let designatedId: string;

          if (variant === "unknown") {
            // The designated record id matches no persisted record.
            designatedId = `openai-compatible:missing-${tokBad}`;
          } else if (variant === "missing-secret") {
            // A persisted record whose required credential is absent: it is
            // configured but invalid, so it cannot be selected.
            const broken = ocRecord(tokBad);
            records.push(broken);
            designatedId = broken.id; // no entry added to secretMap
          } else {
            // A valid cloudflare provider designated for flagship — it serves
            // only the cheap/fast tier and cannot serve the flagship route.
            const cf = cloudflareRecord(tokBad);
            records.push(cf);
            secretMap[cf.secretRef] = secretA;
            designatedId = cf.id;
          }

          const store = await seedStore(records, { [role]: designatedId });
          const secrets = createFakeSecretStore(secretMap);

          const router = await buildConfiguredRouter({
            store,
            secrets,
            baseEnv: {}, // isolate from any ambient process.env credentials
            enableNetwork: false,
          });

          // (a) The run never fails: a valid, non-fake provider is selected via
          // the capability-priority fallback order for the requested tier.
          const selection = router.select({ capability });
          expect(selection.provider.metadata.id).not.toBe("fake");
          expect(selection.modelRoute).toBe(route);
          expect(selection.provider.metadata.routes).toContain(route);
          // The fallback pick is one of the two fully-valid openai-compatible
          // providers, never the invalid designation.
          expect(selection.provider.metadata.id).toBe("openai-compatible");
          expect([validA.model, validB.model]).toContain(selection.model);

          // The substitution was recorded as a trace indication, and it did not
          // honor the invalid designation as an active route.
          expect(selection.reason).toContain("fallback substitution");
          expect(selection.reason).toContain(designatedId);
          expect(selection.reason).not.toContain("active route");

          // (b) The recorded indication leaks no secret. No surfaceable output —
          // the reason marker or the whole selection projection — may contain a
          // substring of any secret value.
          const allSecrets = Object.values(secretMap);
          for (const secret of allSecrets) {
            expect(selection.reason.includes(secret)).toBe(false);
          }
          const surfaced = JSON.stringify(surfaceableSelection(selection));
          for (const secret of allSecrets) {
            expect(surfaced.includes(secret)).toBe(false);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
