#!/usr/bin/env node
/**
 * Key rotation CLI (H3 — Chunk 049).
 *
 * Reads the old encryption key from `.rector/secret.key`, generates a new
 * 32-byte key, re-encrypts all secret envelopes with the new key, and
 * atomically writes the new key file in v2 JSON format.
 *
 * Usage:
 *   npx tsx src/bin/rotate-key.ts
 *   # Or after build:
 *   node dist/bin/rotate-key.js
 *
 * Environment:
 *   RECTOR_SECRET_KEY — if set, used as the old key (scrypt-derived).
 *     Otherwise the key is read from `.rector/secret.key`.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes, scryptSync } from "node:crypto";
import { createLocalSecretStore, type SecretStore } from "../security/secretStore";

const RECTOR_DATA_DIR = ".rector";
const SECRET_KEY_FILE = `${RECTOR_DATA_DIR}/secret.key`;
const SECRETS_FILE = `${RECTOR_DATA_DIR}/secrets.enc`;

interface SecretKeyFile {
  key: string;
  version: "v2";
  createdAt: string;
}

function readOldKey(): Buffer {
  const envKey = process.env.RECTOR_SECRET_KEY?.trim();
  if (envKey) {
    return scryptSync(envKey, "rector.secret-store.v1", 32);
  }

  if (!existsSync(SECRET_KEY_FILE)) {
    console.error(`Error: Key file not found at ${SECRET_KEY_FILE}`);
    console.error("Set RECTOR_SECRET_KEY or ensure .rector/secret.key exists.");
    process.exit(1);
  }

  const stored = readFileSync(SECRET_KEY_FILE, "utf8").trim();

  // Try v2 JSON format
  try {
    const parsed = JSON.parse(stored) as Partial<SecretKeyFile>;
    if (parsed.version === "v2" && typeof parsed.key === "string") {
      const key = Buffer.from(parsed.key, "hex");
      if (key.length === 32) return key;
    }
  } catch {
    // Not valid JSON
  }

  // v1 backward compat: bare 64-char hex
  if (/^[0-9a-f]{64}$/i.test(stored)) {
    return Buffer.from(stored, "hex");
  }

  console.error("Error: Key file format is invalid. Expected v2 JSON or v1 hex.");
  process.exit(1);
}

function writeNewKey(keyFilePath: string, key: Buffer): void {
  const keyFile: SecretKeyFile = {
    key: key.toString("hex"),
    version: "v2",
    createdAt: new Date().toISOString(),
  };
  const content = JSON.stringify(keyFile, null, 2);
  // Atomic write: temp file + rename
  const tempPath = join(
    dirname(keyFilePath),
    `.secret.key.tmp.${randomBytes(4).toString("hex")}`,
  );
  writeFileSync(tempPath, content, { encoding: "utf8", mode: 0o600 });
  try {
    renameSync(tempPath, keyFilePath);
  } catch {
    // Fallback: direct write if rename fails
    writeFileSync(keyFilePath, content, { encoding: "utf8", mode: 0o600 });
  }
}

async function main(): Promise<void> {
  console.log("Rector key rotation (H3)");
  console.log(`Reading old key from ${SECRET_KEY_FILE}...`);

  const oldKey = readOldKey();
  const oldStore = createLocalSecretStore({
    filePath: SECRETS_FILE,
    encryptionKey: oldKey,
  });

  // Enumerate all existing secret IDs
  const ids = oldStore.listSecretIds ? await oldStore.listSecretIds() : [];
  console.log(`Found ${ids.length} secret(s) to re-encrypt.`);

  if (ids.length === 0) {
    console.log("No secrets to rotate. Generating new key anyway...");
  }

  // Generate new key
  const newKey = randomBytes(32);
  const newStore = createLocalSecretStore({
    filePath: SECRETS_FILE,
    encryptionKey: newKey,
  });

  // Re-encrypt each secret
  let successCount = 0;
  let failCount = 0;
  for (const id of ids) {
    const result = await oldStore.getSecret(id);
    if (!result.ok) {
      console.error(`  ✗ Failed to read secret "${id}": ${result.error}`);
      failCount++;
      continue;
    }
    const setResult = await newStore.setSecret(id, result.value);
    if (!setResult.ok) {
      console.error(`  ✗ Failed to re-encrypt secret "${id}": ${setResult.error}`);
      failCount++;
      continue;
    }
    successCount++;
  }

  if (failCount > 0) {
    console.error(
      `\n⚠ Rotation incomplete: ${successCount} succeeded, ${failCount} failed. ` +
        "Old key file is unchanged — re-run after fixing failures.",
    );
    process.exit(1);
  }

  // Write new key file
  writeNewKey(SECRET_KEY_FILE, newKey);
  console.log(`✓ Key rotation complete: ${successCount} secret(s) re-encrypted.`);
  console.log(`✓ New key written to ${SECRET_KEY_FILE} (v2 format).`);
}

main().catch((error) => {
  console.error(
    `Key rotation failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
