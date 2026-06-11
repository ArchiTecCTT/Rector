// Feature: productization-alpha, Property 11: Secret store representation is non-plaintext
//
// Validates: Requirements 7.4
//
// For any secret value, the persisted stored representation SHALL NOT contain the
// plaintext value as a substring and SHALL NOT be parseable as plain (unencoded) JSON
// that exposes the value.
//
// This exercises `createLocalSecretStore` over an in-memory `SecretFs` double, so the
// property runs with zero network/provider calls and zero disk access — the store seals
// values with AES-256-GCM (nonce + ciphertext + tag) and only `node:crypto` is touched.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { randomBytes } from "node:crypto";

import { createLocalSecretStore, type SecretFs } from "../src/security/secretStore";

/**
 * An in-memory {@link SecretFs} double that records the bytes the store persists.
 *
 * Mirrors the real adapter's contract: `readFile` returns `undefined` for an absent
 * file, writes land in a path→contents map, and `rename` moves the temp file over the
 * target. After a `setSecret`, `files.get(filePath)` is the exact stored representation.
 */
function createInMemorySecretFs(): SecretFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async readFile(path: string): Promise<string | undefined> {
      return files.get(path);
    },
    async writeFile(path: string, data: string): Promise<void> {
      files.set(path, data);
    },
    async rename(fromPath: string, toPath: string): Promise<void> {
      const data = files.get(fromPath);
      if (data === undefined) {
        throw new Error("rename source missing");
      }
      files.set(toPath, data);
      files.delete(fromPath);
    },
    async mkdir(): Promise<void> {
      // No directories in an in-memory map.
    },
  };
}

/** Recursively collect every string leaf in a parsed JSON value. */
function collectStrings(value: unknown, acc: string[]): void {
  if (typeof value === "string") {
    acc.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, acc);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, acc);
  }
}

// Secret values are generated with enough length/entropy that a coincidental substring
// match inside random base64 ciphertext is astronomically unlikely; this keeps the
// "no plaintext substring" assertion meaningful (real provider keys are long secrets).
const providerIdArb = fc.string({ minLength: 1, maxLength: 12 }).filter((s) => s.trim().length > 0);
const secretValueArb = fc.string({ minLength: 16, maxLength: 256 });

const FILE_PATH = ".rector/secrets.enc";
const FIXED_NOW = "2026-01-01T00:00:00.000Z";

describe("createLocalSecretStore — Property 11: stored representation is non-plaintext", () => {
  it("never persists a secret value as a plaintext substring or exposed JSON value", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.tuple(providerIdArb, secretValueArb), {
          minLength: 1,
          maxLength: 5,
          selector: ([providerId]) => providerId,
        }),
        async (entries) => {
          const fsDouble = createInMemorySecretFs();
          const store = createLocalSecretStore({
            filePath: FILE_PATH,
            // A fresh 32-byte key per run; the property must hold for any key.
            encryptionKey: randomBytes(32),
            fsImpl: fsDouble,
            now: () => FIXED_NOW,
          });

          for (const [providerId, value] of entries) {
            const result = await store.setSecret(providerId, value);
            expect(result.ok).toBe(true);
          }

          const stored = fsDouble.files.get(FILE_PATH);
          expect(stored).toBeDefined();
          const representation = stored as string;

          // 1) The raw stored bytes contain no plaintext secret substring.
          for (const [, value] of entries) {
            expect(representation.includes(value)).toBe(false);
          }

          // 2) Parsing the representation as JSON exposes no secret value: no string
          //    leaf equals or contains any plaintext secret.
          const parsed = JSON.parse(representation) as unknown;
          const leaves: string[] = [];
          collectStrings(parsed, leaves);
          for (const [, value] of entries) {
            for (const leaf of leaves) {
              expect(leaf.includes(value)).toBe(false);
            }
          }

          // Sanity: each stored secret is still recoverable via the store (round-trip),
          // proving the value is sealed rather than discarded.
          for (const [providerId, value] of entries) {
            const got = await store.getSecret(providerId);
            expect(got).toEqual({ ok: true, value });
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
