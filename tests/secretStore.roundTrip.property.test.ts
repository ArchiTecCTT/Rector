import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  createLocalSecretStore,
  type SecretFs,
} from "../src/security/secretStore";

/**
 * Task 1.2 — Secret store restart round-trip property test.
 *
 * **Property 10: Secret store persists across restart (round-trip)**
 * **Validates: Requirements 7.2**
 *
 * For any provider id and secret value, storing the value and then constructing
 * a FRESH secret store over the SAME backing and retrieving it returns the
 * original value. The "fresh store over the same backing" is how we model an
 * application restart: a brand-new `createLocalSecretStore` instance reads the
 * bytes left behind by the previous instance.
 *
 * The backing is an injectable in-memory {@link SecretFs} double (a path -> data
 * Map). It exercises the real `setSecret`/`getSecret` code path — including the
 * AES-256-GCM seal/open and the atomic temp-file + rename write — without
 * touching disk, the network, or any provider.
 */

/**
 * In-memory {@link SecretFs} double. A single backing `Map` survives across
 * multiple store instances, which is exactly what makes a "restart" round-trip
 * observable: the second store reads what the first store wrote.
 */
function createInMemorySecretFs(): SecretFs {
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
        throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
      }
      files.set(toPath, data);
      files.delete(fromPath);
    },
    async mkdir(): Promise<void> {
      // No directories to track in the in-memory double.
    },
  };
}

describe("secret store restart round-trip (Property 10)", () => {
  // Feature: productization-alpha, Property 10: Secret store persists across restart (round-trip)
  it("returns the original secret from a fresh store over the same backing", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }),
        fc.string(),
        async (providerId, secretValue) => {
          // A single shared backing models persistent local storage that
          // survives a restart.
          const fsImpl = createInMemorySecretFs();
          // A locally derived key is stable across restarts; reuse it for both
          // store instances.
          const encryptionKey = Buffer.alloc(32, 7);
          const filePath = ".rector/secrets.enc";

          // First "session": store the secret.
          const writer = createLocalSecretStore({ fsImpl, encryptionKey, filePath });
          const setResult = await writer.setSecret(providerId, secretValue);
          expect(setResult.ok).toBe(true);

          // "Restart": a brand-new store instance over the same backing bytes.
          const reader = createLocalSecretStore({ fsImpl, encryptionKey, filePath });
          const presentAfterRestart = await reader.hasSecret(providerId);
          expect(presentAfterRestart).toBe(true);

          const getResult = await reader.getSecret(providerId);
          expect(getResult.ok).toBe(true);
          if (getResult.ok) {
            expect(getResult.value).toBe(secretValue);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
