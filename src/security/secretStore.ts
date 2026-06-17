import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { redactSecrets, redactString } from "./redaction";
import { ensureRestrictedDir } from "./filePermissions";

/**
 * Secret Store abstraction (Requirement 7).
 *
 * A consumer-agnostic interface for storing, retrieving, and checking the
 * presence of provider secrets WITHOUT ever exposing raw secret values through
 * its own surface. Consumers depend only on {@link SecretStore}; the backing
 * implementation (local encrypted file today, an OS keychain later) can change
 * without touching a single consumer (Requirement 7.3).
 *
 * The shipped local development backing ({@link createLocalSecretStore})
 * persists secrets across application restarts (Requirement 7.2) in a
 * non-plaintext, authenticated-encryption envelope (Requirement 7.4): each
 * value is sealed with AES-256-GCM as `nonce + ciphertext + tag`, so the stored
 * representation is neither readable plaintext nor unencoded JSON that exposes
 * the value.
 */

/**
 * The result of a {@link SecretStore} operation.
 *
 * A discriminated union: callers branch on `ok`. On failure, `error` is a
 * human-language message that has already been routed through the
 * `Redaction_Layer` so no secret substring can escape (Requirement 7.8).
 */
export type SecretStoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/**
 * The store/retrieve/has contract (Requirement 7.1).
 *
 * `hasSecret` returns a presence-only boolean — never a value — so callers such
 * as the Setup_API can report configuration status without exposing secrets
 * (Requirements 7.5, 7.6). `getSecret` is the only operation that surfaces a
 * value, and consumers must keep that value out of every API/UI response.
 */
export interface SecretStore {
  /**
   * Store (or replace) the secret for `providerId`. On any failure the result is
   * `{ ok: false, error }` and NO partial or corrupted value is persisted
   * (Requirement 7.7) — the prior stored state is left intact.
   */
  setSecret(providerId: string, value: string): Promise<SecretStoreResult<void>>;
  /**
   * Retrieve the secret for `providerId`. Returns `{ ok: false, error }` when the
   * secret is absent or the stored representation cannot be authenticated/decrypted.
   */
  getSecret(providerId: string): Promise<SecretStoreResult<string>>;
  /** Report whether a secret value is currently stored for `providerId`. Presence only. */
  hasSecret(providerId: string): Promise<boolean>;
  /**
   * List all provider IDs that have a stored secret. Used for key rotation
   * to enumerate envelopes that must be re-encrypted (H3).
   * Optional so existing test doubles remain valid SecretStores.
   */
  listSecretIds?(): Promise<string[]>;
  /**
   * Remove the stored secret for `providerId`, if any. Optional so existing presence-only doubles
   * remain valid `SecretStore`s; the shipped local backing implements it so deleting a provider
   * configuration can also delete its secret (Requirement 10.6). Removing an absent secret is a
   * success (idempotent), and on any failure the prior stored state is left intact (Requirement
   * 7.7) with a redacted error.
   */
  deleteSecret?(providerId: string): Promise<SecretStoreResult<void>>;
}

/**
 * The minimal filesystem surface the local backing depends on, injectable so
 * tests can supply an in-memory double and exercise failure paths deterministically
 * without touching disk or the network.
 *
 * `readFile` resolves to `undefined` when the file does not yet exist (a fresh
 * store), and rejects for any other read error. Writes go through a temp file +
 * `rename` so a persisted file is never left partially written (Requirement 7.7).
 */
export interface SecretFs {
  readFile(path: string): Promise<string | undefined>;
  writeFile(path: string, data: string): Promise<void>;
  rename(fromPath: string, toPath: string): Promise<void>;
  mkdir(dirPath: string): Promise<void>;
}

/** Construction options for {@link createLocalSecretStore}. */
export interface LocalSecretStoreOptions {
  /** Backing file path, e.g. `.rector/secrets.enc`. */
  filePath: string;
  /** 32-byte key for AES-256-GCM. Derived locally; never logged. */
  encryptionKey: Buffer;
  /** Injectable filesystem (defaults to a `node:fs/promises`-backed adapter). */
  fsImpl?: SecretFs;
  /** Deterministic clock for envelope metadata timestamps. */
  now?: () => string;
}

/** Required AES-256 key length in bytes. */
const KEY_LENGTH = 32;
/** GCM nonce (IV) length in bytes — 96 bits is the recommended GCM nonce size. */
const NONCE_LENGTH = 12;
/** On-disk format version, so the envelope can evolve without ambiguity. */
const FORMAT_VERSION = 1;

/**
 * One sealed secret. `nonce`, `ciphertext`, and `tag` are base64; together they
 * form the authenticated-encryption envelope. The value is never present in
 * plaintext (Requirement 7.4).
 */
interface SecretEnvelope {
  nonce: string;
  ciphertext: string;
  tag: string;
  updatedAt: string;
}

/** The persisted file shape: a version tag plus a providerId → envelope map. */
interface SecretFileContents {
  version: number;
  entries: Record<string, SecretEnvelope>;
}

/** Default filesystem adapter over `node:fs/promises`. */
function defaultSecretFs(): SecretFs {
  return {
    async readFile(path: string): Promise<string | undefined> {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
        throw error;
      }
    },
    async writeFile(path: string, data: string): Promise<void> {
      await writeFile(path, data, "utf8");
    },
    async rename(fromPath: string, toPath: string): Promise<void> {
      await rename(fromPath, toPath);
    },
    async mkdir(dirPath: string): Promise<void> {
      ensureRestrictedDir(dirPath);
    },
  };
}

/** Redact any error into a safe, secret-free message (Requirement 7.8). */
function toRedactedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactString(message);
}

/**
 * Create the local development {@link SecretStore} backing.
 *
 * Persists secrets across restarts in an authenticated-encryption envelope and
 * keeps every error message redacted. All disk access flows through the
 * injectable {@link SecretFs} so the same code path is exercised in tests with
 * an in-memory double.
 */
export function createLocalSecretStore(options: LocalSecretStoreOptions): SecretStore {
  const { filePath, encryptionKey } = options;
  const fsImpl = options.fsImpl ?? defaultSecretFs();
  const now = options.now ?? (() => new Date().toISOString());

  if (!Buffer.isBuffer(encryptionKey) || encryptionKey.length !== KEY_LENGTH) {
    throw new Error(`encryptionKey must be a ${KEY_LENGTH}-byte Buffer for AES-256-GCM.`);
  }

  async function readFileContents(): Promise<SecretFileContents> {
    const raw = await fsImpl.readFile(filePath);
    if (raw === undefined || raw.trim() === "") {
      return { version: FORMAT_VERSION, entries: {} };
    }
    const parsed = JSON.parse(raw) as Partial<SecretFileContents>;
    const entries = parsed.entries;
    if (!entries || typeof entries !== "object") {
      return { version: FORMAT_VERSION, entries: {} };
    }
    return { version: parsed.version ?? FORMAT_VERSION, entries };
  }

  /**
   * Persist `contents` atomically: serialize to a temp sibling, then rename over
   * the target. A failure before the rename leaves the existing file untouched,
   * so no partial/corrupted value is ever observed (Requirement 7.7).
   */
  async function writeFileContents(contents: SecretFileContents): Promise<void> {
    await fsImpl.mkdir(dirname(filePath));
    const tempPath = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
    const serialized = JSON.stringify(contents);
    await fsImpl.writeFile(tempPath, serialized);
    await fsImpl.rename(tempPath, filePath);
  }

  function seal(value: string): SecretEnvelope {
    const nonce = randomBytes(NONCE_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: tag.toString("base64"),
      updatedAt: now(),
    };
  }

  function open(envelope: SecretEnvelope): string {
    const nonce = Buffer.from(envelope.nonce, "base64");
    const ciphertext = Buffer.from(envelope.ciphertext, "base64");
    const tag = Buffer.from(envelope.tag, "base64");
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey, nonce);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
  }

  return {
    async setSecret(providerId: string, value: string): Promise<SecretStoreResult<void>> {
      try {
        const contents = await readFileContents();
        // Seal into a fresh copy so a mid-operation failure never mutates the
        // on-disk state until the atomic rename succeeds.
        const next: SecretFileContents = {
          version: FORMAT_VERSION,
          entries: { ...contents.entries, [providerId]: seal(value) },
        };
        await writeFileContents(next);
        return { ok: true, value: undefined };
      } catch (error) {
        return { ok: false, error: toRedactedError(error) };
      }
    },

    async getSecret(providerId: string): Promise<SecretStoreResult<string>> {
      try {
        const contents = await readFileContents();
        const envelope = contents.entries[providerId];
        if (!envelope) {
          return { ok: false, error: redactSecrets(`No secret stored for provider "${providerId}".`) };
        }
        return { ok: true, value: open(envelope) };
      } catch (error) {
        return { ok: false, error: toRedactedError(error) };
      }
    },

    async hasSecret(providerId: string): Promise<boolean> {
      try {
        const contents = await readFileContents();
        return Object.prototype.hasOwnProperty.call(contents.entries, providerId);
      } catch {
        // Presence is a best-effort boolean; an unreadable backing reports "absent"
        // rather than surfacing an error or a value.
        return false;
      }
    },

    async listSecretIds(): Promise<string[]> {
      try {
        const contents = await readFileContents();
        return Object.keys(contents.entries);
      } catch {
        return [];
      }
    },

    async deleteSecret(providerId: string): Promise<SecretStoreResult<void>> {
      try {
        const contents = await readFileContents();
        // Deleting an absent secret is a no-op success (idempotent), and avoids an
        // unnecessary write when nothing changes.
        if (!Object.prototype.hasOwnProperty.call(contents.entries, providerId)) {
          return { ok: true, value: undefined };
        }
        // Build the next entries in a fresh object so a mid-operation failure never mutates
        // the on-disk state until the atomic rename succeeds (Requirement 7.7).
        const entries = { ...contents.entries };
        delete entries[providerId];
        await writeFileContents({ version: FORMAT_VERSION, entries });
        return { ok: true, value: undefined };
      } catch (error) {
        return { ok: false, error: toRedactedError(error) };
      }
    },
  };
}
