/**
 * Task 1.5 — Secret store failure-path unit tests (Requirements 7.7, 7.8).
 *
 * These tests exercise the local secret store's failure branches with an
 * injectable in-memory {@link SecretFs} double, so the same code path that runs
 * against disk in production is driven here with deterministic, fault-injected
 * I/O. There are ZERO network or provider calls.
 *
 * They assert two guarantees:
 *
 *   1. Requirement 7.7 — on a store/retrieve failure the store returns a failure
 *      indicator (`{ ok: false }`) and NEVER persists a partial or corrupted
 *      value: the on-disk target file is left exactly as it was, any
 *      previously stored secret remains intact and retrievable, and the secret
 *      that failed to write is reported absent.
 *
 *   2. Requirement 7.8 — every returned error message is routed through the
 *      Redaction_Layer, so no secret substring (e.g. a Bearer token or an
 *      inline `token=`/`api_key=` value embedded in a raw I/O error) ever
 *      escapes through the failure result.
 */
import { describe, expect, it } from "vitest";
import { createLocalSecretStore, type SecretFs } from "../src/security/secretStore";

const FILE_PATH = ".rector/secrets.enc";
// A fixed 32-byte key satisfies the AES-256-GCM contract without any randomness.
const KEY = Buffer.alloc(32, 7);

/**
 * In-memory {@link SecretFs} double with per-operation fault injection. A
 * pending error is consumed (thrown once) the next time the matching operation
 * runs, mirroring a transient mid-write/mid-rename/mid-read failure.
 */
class InMemorySecretFs implements SecretFs {
  readonly files = new Map<string, string>();
  failNextWrite: Error | null = null;
  failNextRename: Error | null = null;
  failNextRead: Error | null = null;

  async readFile(path: string): Promise<string | undefined> {
    if (this.failNextRead) {
      const error = this.failNextRead;
      this.failNextRead = null;
      throw error;
    }
    return this.files.get(path);
  }

  async writeFile(path: string, data: string): Promise<void> {
    if (this.failNextWrite) {
      const error = this.failNextWrite;
      this.failNextWrite = null;
      throw error;
    }
    this.files.set(path, data);
  }

  async rename(fromPath: string, toPath: string): Promise<void> {
    if (this.failNextRename) {
      const error = this.failNextRename;
      this.failNextRename = null;
      throw error;
    }
    const data = this.files.get(fromPath);
    if (data === undefined) throw new Error("ENOENT: temp file missing during rename");
    this.files.set(toPath, data);
    this.files.delete(fromPath);
  }

  async mkdir(_dirPath: string): Promise<void> {
    // No-op: directories are implicit in this in-memory model.
  }
}

function newStore(fsImpl: SecretFs) {
  return createLocalSecretStore({ filePath: FILE_PATH, encryptionKey: KEY, fsImpl });
}

describe("secret store failure paths (Req 7.7, 7.8)", () => {
  describe("Requirement 7.7 — no partial/corrupted value persisted", () => {
    it("leaves a previously stored secret intact when a later write fails mid-operation", async () => {
      const fsImpl = new InMemorySecretFs();
      const store = newStore(fsImpl);

      const first = await store.setSecret("openai", "sk-original-value");
      expect(first.ok).toBe(true);

      // Snapshot the on-disk target after the successful write.
      const persistedAfterSuccess = fsImpl.files.get(FILE_PATH);
      expect(persistedAfterSuccess).toBeDefined();

      // Inject a mid-write failure for the next store operation.
      fsImpl.failNextWrite = new Error("EIO: simulated disk failure during write");
      const failed = await store.setSecret("anthropic", "sk-should-not-persist");

      expect(failed.ok).toBe(false);
      // The target file is byte-for-byte unchanged: no partial/corrupted value.
      expect(fsImpl.files.get(FILE_PATH)).toBe(persistedAfterSuccess);
      // The previously stored secret is still retrievable and correct.
      const original = await store.getSecret("openai");
      expect(original).toEqual({ ok: true, value: "sk-original-value" });
      // The secret that failed to write is reported absent.
      expect(await store.hasSecret("anthropic")).toBe(false);
    });

    it("leaves the target untouched when the atomic rename fails", async () => {
      const fsImpl = new InMemorySecretFs();
      const store = newStore(fsImpl);

      const first = await store.setSecret("openai", "sk-original-value");
      expect(first.ok).toBe(true);
      const persistedAfterSuccess = fsImpl.files.get(FILE_PATH);

      // The temp file write succeeds but the rename over the target fails.
      fsImpl.failNextRename = new Error("EXDEV: simulated cross-device rename failure");
      const failed = await store.setSecret("anthropic", "sk-never-renamed-in");

      expect(failed.ok).toBe(false);
      // Target file unchanged — the half-written temp file never replaced it.
      expect(fsImpl.files.get(FILE_PATH)).toBe(persistedAfterSuccess);
      // Stored representation never contains the un-committed plaintext secret.
      expect(fsImpl.files.get(FILE_PATH) ?? "").not.toContain("sk-never-renamed-in");
      expect(await store.hasSecret("anthropic")).toBe(false);
      expect(await store.getSecret("openai")).toEqual({ ok: true, value: "sk-original-value" });
    });

    it("persists no file at all when the very first write fails", async () => {
      const fsImpl = new InMemorySecretFs();
      const store = newStore(fsImpl);

      fsImpl.failNextWrite = new Error("ENOSPC: simulated no space left on device");
      const failed = await store.setSecret("openai", "sk-first-ever");

      expect(failed.ok).toBe(false);
      // No partial file was left behind for the target path.
      expect(fsImpl.files.has(FILE_PATH)).toBe(false);
      expect(await store.hasSecret("openai")).toBe(false);
    });

    it("reports a failure indicator (not a throw) when retrieval reads a faulting backing", async () => {
      const fsImpl = new InMemorySecretFs();
      const store = newStore(fsImpl);
      await store.setSecret("openai", "sk-original-value");

      fsImpl.failNextRead = new Error("EIO: simulated read failure");
      const result = await store.getSecret("openai");

      expect(result.ok).toBe(false);
    });
  });

  describe("Requirement 7.8 — error messages are redacted", () => {
    it("redacts secret material embedded in a write-failure error", async () => {
      const fsImpl = new InMemorySecretFs();
      const store = newStore(fsImpl);

      const secret = "sk-LIVE-DEADBEEF-supersecret";
      // A raw I/O error that leaks secret-like material in its message.
      fsImpl.failNextWrite = new Error(
        `EIO writing request with Authorization: Bearer ${secret} and token=${secret}`,
      );

      const failed = await store.setSecret("openai", secret);

      expect(failed.ok).toBe(false);
      if (failed.ok) throw new Error("expected failure");
      expect(failed.error).not.toContain(secret);
      expect(failed.error).toContain("[REDACTED]");
    });

    it("redacts secret material embedded in a read-failure error from getSecret", async () => {
      const fsImpl = new InMemorySecretFs();
      const store = newStore(fsImpl);
      await store.setSecret("openai", "sk-stored");

      const secret = "sk-LEAK-IN-READ-ERROR-CAFEBABE";
      fsImpl.failNextRead = new Error(`EIO reading; Bearer ${secret}`);

      const result = await store.getSecret("openai");

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error).not.toContain(secret);
      expect(result.error).toContain("[REDACTED]");
    });
  });
});
