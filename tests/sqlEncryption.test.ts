import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes, createHmac } from "node:crypto";
import { SqlRectorStore, createSqliteDriver, type SqlDriver } from "../src/store/sqlRectorStore";

/** Derive a DB encryption key using the same HKDF-like construction as production. */
function deriveDbEncryptionKey(masterKey: Buffer): Buffer {
  return createHmac("sha256", masterKey).update("rector.db-encryption.v1").digest();
}

function createMemoryDriver(): SqlDriver {
  return createSqliteDriver({ path: ":memory:" });
}

/** Helper to create a conversation with all required fields. */
function convInput(overrides: Partial<{ workspaceId: string; title: string; retentionPolicy: string }> = {}) {
  return {
    workspaceId: overrides.workspaceId ?? "ws-1",
    title: overrides.title ?? "Test",
    retentionPolicy: overrides.retentionPolicy ?? "session",
  };
}

describe("SQLite payload encryption (H1)", () => {
  const masterKey = randomBytes(32);
  const encryptionKey = deriveDbEncryptionKey(masterKey);

  describe("encryption roundtrip", () => {
    let store: SqlRectorStore;

    beforeEach(() => {
      store = new SqlRectorStore({
        driver: createMemoryDriver(),
        encryptionKey,
      });
    });

    it("encrypts and decrypts a conversation roundtrip", async () => {
      const conversation = await store.createConversation(convInput({
        workspaceId: "ws-1",
        title: "Test encrypted conversation",
      }));
      const loaded = await store.getConversation(conversation.id);
      expect(loaded).toBeDefined();
      expect(loaded!.title).toBe("Test encrypted conversation");
      expect(loaded!.workspaceId).toBe("ws-1");
    });

    it("encrypts and decrypts a message roundtrip", async () => {
      const conversation = await store.createConversation(convInput());
      const message = await store.createMessage({
        conversationId: conversation.id,
        role: "user",
        content: "Secret payload that should be encrypted at rest",
        status: "sent",
        redactionState: "none",
      });
      const loaded = await store.getMessage(message.id);
      expect(loaded).toBeDefined();
      expect(loaded!.content).toBe("Secret payload that should be encrypted at rest");
    });

    it("encrypts and decrypts a memory entry roundtrip", async () => {
      const entry = await store.createMemoryEntry({
        layer: "episodic",
        content: "Sensitive memory content that must be encrypted",
        tags: ["secret", "test"],
      });
      const loaded = await store.getMemoryEntry(entry.id);
      expect(loaded).toBeDefined();
      expect(loaded!.content).toBe("Sensitive memory content that must be encrypted");
    });

    it("stores ENC1: prefix in the raw payload", () => {
      const driver = createMemoryDriver();
      const encStore = new SqlRectorStore({ driver, encryptionKey });
      encStore.createConversation(convInput({ title: "Encrypted" }));

      // Raw query: payload should start with ENC1:
      const row = driver.get<{ payload: string }>(
        "SELECT payload FROM conversations LIMIT 1"
      );
      expect(row).toBeDefined();
      expect(row!.payload.startsWith("ENC1:")).toBe(true);
    });

    it("plaintext payloads do NOT have ENC1: prefix when no key", () => {
      const driver = createMemoryDriver();
      const plainStore = new SqlRectorStore({ driver });
      plainStore.createConversation(convInput({ title: "Plaintext" }));

      const row = driver.get<{ payload: string }>(
        "SELECT payload FROM conversations LIMIT 1"
      );
      expect(row).toBeDefined();
      expect(row!.payload.startsWith("ENC1:")).toBe(false);
      // Should be valid JSON
      expect(() => JSON.parse(row!.payload)).not.toThrow();
    });
  });

  describe("backward compatibility with unencrypted data", () => {
    it("reads unencrypted payloads when encryption key is provided", async () => {
      // First: write data without encryption
      const driver = createMemoryDriver();
      const plainStore = new SqlRectorStore({ driver });
      const conversation = await plainStore.createConversation(convInput({
        workspaceId: "ws-legacy",
        title: "Legacy unencrypted conversation",
      }));

      // Now: create a new store WITH encryption key over the same driver
      const encStore = new SqlRectorStore({ driver, encryptionKey });

      // Should still be able to read the unencrypted data
      const loaded = await encStore.getConversation(conversation.id);
      expect(loaded).toBeDefined();
      expect(loaded!.title).toBe("Legacy unencrypted conversation");
      expect(loaded!.workspaceId).toBe("ws-legacy");
    });

    it("new writes after reading legacy data are encrypted", async () => {
      const driver = createMemoryDriver();
      const plainStore = new SqlRectorStore({ driver });
      await plainStore.createConversation(convInput({ workspaceId: "ws-1", title: "Old" }));

      const encStore = new SqlRectorStore({ driver, encryptionKey });
      const newConv = await encStore.createConversation(convInput({
        workspaceId: "ws-2",
        title: "New Encrypted",
      }));

      // The new row should be encrypted
      const row = driver.get<{ payload: string }>(
        "SELECT payload FROM conversations WHERE id = ?",
        [newConv.id]
      );
      expect(row).toBeDefined();
      expect(row!.payload.startsWith("ENC1:")).toBe(true);
    });
  });

  describe("missing key handling", () => {
    it("throws when reading encrypted payload without key", async () => {
      // Write encrypted data
      const driver = createMemoryDriver();
      const encStore = new SqlRectorStore({ driver, encryptionKey });
      const conv = await encStore.createConversation(convInput({ title: "Encrypted" }));

      // Try to read with a store that has no key
      const noKeyStore = new SqlRectorStore({ driver });
      await expect(noKeyStore.getConversation(conv.id)).rejects.toThrow(
        /no encryption key provided/i
      );
    });

    it("throws when reading encrypted payload with wrong key", async () => {
      const driver = createMemoryDriver();
      const encStore = new SqlRectorStore({ driver, encryptionKey });
      const conv = await encStore.createConversation(convInput({ title: "Encrypted" }));

      // Try to read with a different key
      const wrongKey = deriveDbEncryptionKey(randomBytes(32));
      const wrongKeyStore = new SqlRectorStore({ driver, encryptionKey: wrongKey });
      await expect(wrongKeyStore.getConversation(conv.id)).rejects.toThrow(
        /Corrupt|unsupported state/
      );
    });
  });

  describe("HKDF key derivation", () => {
    it("derives a different key from the master key", () => {
      const masterKey = randomBytes(32);
      const dbKey = deriveDbEncryptionKey(masterKey);
      // The derived key should be 32 bytes
      expect(dbKey.length).toBe(32);
      // The derived key should be different from the master key
      expect(dbKey.equals(masterKey)).toBe(false);
    });

    it("derives the same key for the same master key", () => {
      const masterKey = randomBytes(32);
      const key1 = deriveDbEncryptionKey(masterKey);
      const key2 = deriveDbEncryptionKey(masterKey);
      expect(key1.equals(key2)).toBe(true);
    });
  });

  describe("update operations with encryption", () => {
    it("encrypts updated conversation payloads", async () => {
      const driver = createMemoryDriver();
      const store = new SqlRectorStore({ driver, encryptionKey });
      const conv = await store.createConversation(convInput({ title: "Original" }));

      const updated = await store.updateConversation(conv.id, { title: "Updated" });
      expect(updated!.title).toBe("Updated");

      // Verify the updated row is still encrypted
      const row = driver.get<{ payload: string }>(
        "SELECT payload FROM conversations WHERE id = ?",
        [conv.id]
      );
      expect(row!.payload.startsWith("ENC1:")).toBe(true);
    });
  });
});
