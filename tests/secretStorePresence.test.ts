// Feature: productization-alpha, Property 2: Secret presence is reported without value exposure
//
// Validates: Requirements 1.4, 7.5, 7.6
//
// For any provider id and any sequence of secret store operations, `hasSecret`
// reports presence as a boolean that is true EXACTLY when a secret value is
// currently stored, and no secret value ever surfaces through a presence /
// API-style response (only presence booleans). The store is exercised entirely
// over an injected in-memory `SecretFs` double, so this property makes ZERO
// network or provider calls and never touches disk.
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  createLocalSecretStore,
  type SecretFs,
} from "../src/security/secretStore";

// A deterministic 32-byte AES-256-GCM key. The value is irrelevant to the
// property (we never read the on-disk envelope here) but the store requires a
// valid key length to construct.
const ENCRYPTION_KEY = Buffer.alloc(32, 7);
const BACKING_PATH = ".rector-test/secrets.enc";

// A small, fixed pool of provider ids. These are short, human-readable
// identifiers that can never be a substring of the generated key-like secrets,
// so a leaked secret would be unambiguously detectable in any serialized
// presence response.
const PROVIDER_POOL = ["openai", "anthropic", "google", "mistral", "cohere"] as const;

// Key-like secrets: a recognizable prefix plus URL/JSON-safe alphanumerics, at
// least 24 chars, so any leaked substring is reliably searchable in serialized
// output without escaping concerns.
const SECRET_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".split("");
const SECRET_PREFIXES = ["sk-", "key-", "tok-", "secret-"] as const;
const arbKeyLikeSecret = (): fc.Arbitrary<string> =>
  fc
    .tuple(
      fc.constantFrom(...SECRET_PREFIXES),
      fc.array(fc.constantFrom(...SECRET_ALPHABET), { minLength: 24, maxLength: 48 })
    )
    .map(([prefix, chars]) => `${prefix}${chars.join("")}`);

// A single store operation: set the secret for one provider in the pool.
// `setSecret` is the only mutator on the interface (there is no delete), so a
// sequence of these grows the set of providers with a stored value.
interface SetOp {
  providerId: (typeof PROVIDER_POOL)[number];
  value: string;
}
const arbSetOp = (): fc.Arbitrary<SetOp> =>
  fc.record({
    providerId: fc.constantFrom(...PROVIDER_POOL),
    value: arbKeyLikeSecret(),
  });

/**
 * An in-memory `SecretFs` double. Mirrors the local backing's temp-file +
 * rename write path with no disk or network involved, so the property exercises
 * the real `createLocalSecretStore` code path deterministically.
 */
function createMemoryFs(): SecretFs {
  const files = new Map<string, string>();
  return {
    async readFile(path: string): Promise<string | undefined> {
      return files.get(path);
    },
    async writeFile(path: string, data: string): Promise<void> {
      files.set(path, data);
    },
    async rename(fromPath: string, toPath: string): Promise<void> {
      const data = files.get(fromPath);
      if (data === undefined) {
        throw new Error("rename: source path does not exist");
      }
      files.set(toPath, data);
      files.delete(fromPath);
    },
    async mkdir(): Promise<void> {
      // no-op: the in-memory map needs no directories
    },
  };
}

describe("SecretStore presence reporting (Property 2 — presence without value exposure)", () => {
  it("reports presence as a boolean that is true exactly when a value is stored, and never exposes a value", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbSetOp(), { maxLength: 12 }),
        async (operations) => {
          const store = createLocalSecretStore({
            filePath: BACKING_PATH,
            encryptionKey: ENCRYPTION_KEY,
            fsImpl: createMemoryFs(),
            now: () => "2026-01-01T00:00:00.000Z",
          });

          // Model the expected presence + the latest value per provider as the
          // sequence is applied. `setSecret` replaces any prior value.
          const expectedValues = new Map<string, string>();
          for (const op of operations) {
            const result = await store.setSecret(op.providerId, op.value);
            expect(result.ok).toBe(true);
            expectedValues.set(op.providerId, op.value);
          }

          // hasSecret reports presence EXACTLY: true for every provider with a
          // stored value, false for every provider that was never set. The
          // return value is always a boolean — never the secret string.
          for (const providerId of PROVIDER_POOL) {
            const present = await store.hasSecret(providerId);
            expect(typeof present).toBe("boolean");
            expect(present).toBe(expectedValues.has(providerId));
          }

          // A presence response is a booleans-only map (the shape the Setup_API
          // exposes as `secretPresence`). Build it solely from `hasSecret`.
          const presenceResponse: Record<string, boolean> = {};
          for (const providerId of PROVIDER_POOL) {
            presenceResponse[providerId] = await store.hasSecret(providerId);
          }
          for (const value of Object.values(presenceResponse)) {
            expect(typeof value).toBe("boolean");
          }

          // No secret value (nor any substring of one) appears anywhere in the
          // serialized presence response (Req 7.5, 7.6, 1.4).
          const serializedPresence = JSON.stringify(presenceResponse);
          for (const value of expectedValues.values()) {
            expect(serializedPresence).not.toContain(value);
          }

          // Binding presence to actual storage: where presence is true the value
          // is genuinely retrievable (it IS currently stored); where false the
          // store reports it absent rather than returning a value.
          for (const providerId of PROVIDER_POOL) {
            const retrieved = await store.getSecret(providerId);
            if (expectedValues.has(providerId)) {
              expect(retrieved.ok).toBe(true);
              if (retrieved.ok) {
                expect(retrieved.value).toBe(expectedValues.get(providerId));
              }
            } else {
              expect(retrieved.ok).toBe(false);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
