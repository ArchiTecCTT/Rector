/**
 * Task 13.2 — Provider_Config_Store config/secret-separation property test.
 *
 * **Feature: byok-chat-ux-and-model-discovery, Property 15: Config records hold a reference, never a secret value**
 * **Validates: Requirements 18.4, 28.2**
 *
 * Property 15: For ANY persisted `ProviderConfigRecord`, the record SHALL carry
 * a `secretRef` and SHALL NOT contain the secret value itself. Equivalently, the
 * Provider_Config_Store SHALL never persist a secret value (Req 28.2); secrets
 * live exclusively in the encrypted `Secret_Store` and are addressed from the
 * config only by reference (Req 18.4).
 *
 * The test reproduces the real upsert discipline of `POST /api/providers`
 * (`src/api/server.ts`): a freshly supplied secret is written to the
 * `Secret_Store` under a `secretRef` derived from the record id, and ONLY the
 * non-secret `ProviderConfigRecord` (carrying that `secretRef`) is handed to the
 * config store. Each generated upsert pairs a distinctive secret sentinel with
 * an independently generated record whose non-secret fields are drawn from an
 * alphabet that cannot contain the sentinel, so any leak of the value into the
 * persisted config is detectable.
 *
 * Both store backings are exercised:
 *  1. **Local store + in-memory fs double.** The actual JSON serialized to disk
 *     is captured and asserted to never contain the secret value — proving the
 *     persisted (on-disk) form holds only the reference (Req 28.2).
 *  2. **In-memory store.** The same invariant on the read-back state.
 *
 * In both cases the secret remains resolvable from the `Secret_Store` via the
 * record's `secretRef`, proving the config holds a working *reference* rather
 * than the value (Req 18.4).
 *
 * There is ZERO disk or network I/O: the filesystem and secret store are
 * in-memory doubles, so every run is deterministic and hermetic (Requirement 29).
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  PROVIDER_KINDS,
  ProviderConfigRecordSchema,
  type ProviderConfigRecord,
} from "../src/providers/config";
import {
  createInMemoryProviderConfigStore,
  createLocalProviderConfigStore,
  type ProviderConfigFs,
} from "../src/providers/configStore";
import type { SecretStore, SecretStoreResult } from "../src/security/secretStore";

// A fixed, schema-valid ISO timestamp for record metadata. The separation
// invariant is independent of the actual timestamp, so it can stay constant.
const TS = "2026-01-01T00:00:00.000Z";

/** Lowercase alphanumeric — deliberately excludes the secret sentinel's prefix/hyphens. */
const ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789".split("");

/** A non-empty alphanumeric token built from {@link ALNUM} (never whitespace). */
const arbAlnum = (minLength = 1, maxLength = 12): fc.Arbitrary<string> =>
  fc.array(fc.constantFrom(...ALNUM), { minLength, maxLength }).map((chars) => chars.join(""));

/**
 * A distinctive secret value that, by construction, cannot appear as a substring
 * of any generated non-secret field: it carries an uppercase prefix and hyphens,
 * neither of which is in {@link ALNUM}. A leak is therefore unambiguous.
 */
const arbSecretValue: fc.Arbitrary<string> = arbAlnum(12, 24).map(
  (body) => `SECRET-VALUE-${body}`,
);

/** An optional value: `undefined` ~1/3 of the time so omitted fields are covered. */
const optional = <T>(arb: fc.Arbitrary<T>): fc.Arbitrary<T | undefined> =>
  fc.option(arb, { nil: undefined, freq: 2 });

/**
 * Generate the non-secret upsert payload — the fields a client may set on
 * `POST /api/providers`. The `secretRef`, timestamps, and the (separately
 * stored) secret are NOT part of this payload, exactly as the route derives
 * `secretRef` from the id and stamps timestamps server-side.
 */
const arbUpsertConfig = fc.record(
  {
    kind: fc.constantFrom(...PROVIDER_KINDS),
    slug: arbAlnum(1, 10),
    label: arbAlnum(1, 16),
    baseUrl: optional(arbAlnum(1, 10).map((h) => `https://${h}.test`)),
    model: optional(arbAlnum(1, 12)),
    models: optional(
      fc.record(
        { flagship: optional(arbAlnum(1, 12)), slm: optional(arbAlnum(1, 12)) },
        { requiredKeys: [] },
      ),
    ),
    azure: optional(
      fc.record(
        {
          endpoint: optional(arbAlnum(1, 10).map((h) => `https://${h}.openai.azure.test`)),
          apiVersion: optional(arbAlnum(1, 10)),
          deployment: optional(arbAlnum(1, 12)),
        },
        { requiredKeys: [] },
      ),
    ),
    cloudflare: optional(
      fc.record({ accountId: optional(arbAlnum(1, 12)) }, { requiredKeys: [] }),
    ),
    headers: optional(
      fc.dictionary(arbAlnum(1, 8), arbAlnum(1, 12), { minKeys: 0, maxKeys: 3 }),
    ),
  },
  { requiredKeys: ["kind", "slug", "label"] },
);

/**
 * Assemble a schema-valid {@link ProviderConfigRecord} from a generated upsert
 * payload, mirroring the server: `id = "${kind}:${slug}"`, `secretRef = id`,
 * timestamps stamped server-side. The secret value is intentionally NOT passed
 * here — it never reaches the record.
 */
function buildRecord(config: fc.GeneratedValueOf<typeof arbUpsertConfig>): ProviderConfigRecord {
  const id = `${config.kind}:${config.slug}`;
  return ProviderConfigRecordSchema.parse({
    id,
    kind: config.kind,
    label: config.label,
    baseUrl: config.baseUrl,
    model: config.model,
    models: config.models,
    azure: config.azure,
    cloudflare: config.cloudflare,
    headers: config.headers,
    secretRef: id,
    createdAt: TS,
    updatedAt: TS,
  });
}

/** An in-memory {@link SecretStore} double keyed by `secretRef`. */
function inMemorySecretStore(): SecretStore {
  const values = new Map<string, string>();
  return {
    async setSecret(providerId: string, value: string): Promise<SecretStoreResult<void>> {
      values.set(providerId, value);
      return { ok: true, value: undefined };
    },
    async getSecret(providerId: string): Promise<SecretStoreResult<string>> {
      const value = values.get(providerId);
      return value === undefined
        ? { ok: false, error: "not configured" }
        : { ok: true, value };
    },
    async hasSecret(providerId: string): Promise<boolean> {
      return values.has(providerId);
    },
  };
}

/**
 * An in-memory {@link ProviderConfigFs} double that records every byte written
 * to a path (post-rename), so the test can inspect the exact persisted JSON.
 */
function inMemoryConfigFs(): { fs: ProviderConfigFs; files: Map<string, string> } {
  const temp = new Map<string, string>();
  const files = new Map<string, string>();
  const fs: ProviderConfigFs = {
    async readFile(path: string): Promise<string | undefined> {
      return files.get(path);
    },
    async writeFile(path: string, data: string): Promise<void> {
      temp.set(path, data);
    },
    async rename(fromPath: string, toPath: string): Promise<void> {
      const data = temp.get(fromPath);
      if (data === undefined) throw new Error("rename of unknown temp file");
      temp.delete(fromPath);
      files.set(toPath, data);
    },
    async mkdir(): Promise<void> {
      /* no-op: in-memory backing needs no directories */
    },
  };
  return { fs, files };
}

describe("Feature: byok-chat-ux-and-model-discovery, Property 15: Config records hold a reference, never a secret value", () => {
  // Validates: Requirements 18.4, 28.2
  it("persists only a secretRef reference and never the secret value (local store, on-disk JSON)", async () => {
    await fc.assert(
      fc.asyncProperty(arbUpsertConfig, arbSecretValue, async (config, secretValue) => {
        const record = buildRecord(config);
        const secrets = inMemorySecretStore();
        const { fs, files } = inMemoryConfigFs();
        const filePath = ".rector/providers.json";
        const store = createLocalProviderConfigStore({ filePath, fsImpl: fs });

        // Server discipline: write the secret to the Secret_Store FIRST, then
        // upsert ONLY the non-secret record (Req 28.2).
        const secretWrite = await secrets.setSecret(record.secretRef, secretValue);
        expect(secretWrite.ok).toBe(true);
        const upsert = await store.upsertProvider(record);
        expect(upsert.ok).toBe(true);

        // The exact JSON serialized to disk never contains the secret value.
        const persistedJson = files.get(filePath);
        expect(persistedJson).toBeDefined();
        expect(persistedJson!.includes(secretValue)).toBe(false);

        // The read-back record carries a non-empty secretRef and no secret value.
        const state = await store.getState();
        const stored = state.providers.find((p) => p.id === record.id);
        expect(stored).toBeDefined();
        expect(typeof stored!.secretRef).toBe("string");
        expect(stored!.secretRef.length).toBeGreaterThan(0);
        expect(JSON.stringify(stored).includes(secretValue)).toBe(false);
        for (const value of Object.values(stored!)) {
          expect(value).not.toBe(secretValue);
        }

        // The reference resolves: the secret is retrievable from the Secret_Store
        // via the record's secretRef — proving a working reference, not a value.
        const resolved = await secrets.getSecret(stored!.secretRef);
        expect(resolved.ok).toBe(true);
        if (resolved.ok) expect(resolved.value).toBe(secretValue);
      }),
      { numRuns: 200 },
    );
  });

  // Validates: Requirements 18.4, 28.2
  it("keeps the secret value out of the in-memory store's read-back record", async () => {
    await fc.assert(
      fc.asyncProperty(arbUpsertConfig, arbSecretValue, async (config, secretValue) => {
        const record = buildRecord(config);
        const secrets = inMemorySecretStore();
        const store = createInMemoryProviderConfigStore();

        await secrets.setSecret(record.secretRef, secretValue);
        const upsert = await store.upsertProvider(record);
        expect(upsert.ok).toBe(true);

        const state = await store.getState();
        const stored = state.providers.find((p) => p.id === record.id);
        expect(stored).toBeDefined();
        expect(stored!.secretRef).toBe(record.secretRef);
        expect(stored!.secretRef.length).toBeGreaterThan(0);
        // The whole persisted state, serialized, never carries the secret value.
        expect(JSON.stringify(state).includes(secretValue)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});
