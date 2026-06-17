import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomBytes, createHmac } from "node:crypto";
import { SqlRectorStore, createSqliteDriver, type SqlDriver } from "../src/store/sqlRectorStore";
import { deriveMacKey } from "../src/security/payloadIntegrity";

/** Derive a MAC key using the same HKDF-like construction as production. */
function derivePayloadMacKey(masterKey: Buffer): Buffer {
  return createHmac("sha256", masterKey).update("rector.payload-mac.v1").digest();
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

describe("SQLite payload MAC protection (H8)", () => {
  const masterKey = randomBytes(32);
  const macKey = derivePayloadMacKey(masterKey);

  describe("MAC computation and verification", () => {
    let store: SqlRectorStore;
    let driver: SqlDriver;

    beforeEach(() => {
      driver = createMemoryDriver();
      store = new SqlRectorStore({
        driver,
        macKey,
      });
    });

    it("stores MAC alongside inserted conversation", async () => {
      const conv = await store.createConversation(convInput({ title: "MAC test" }));

      const row = driver.get<{ mac: string | null }>(
        "SELECT mac FROM conversations WHERE id = ?",
        [conv.id]
      );
      expect(row).toBeDefined();
      expect(row!.mac).not.toBeNull();
      expect(typeof row!.mac).toBe("string");
      expect(row!.mac.length).toBeGreaterThan(0);
    });

    it("stores MAC alongside inserted message", async () => {
      const conv = await store.createConversation(convInput());
      const msg = await store.createMessage({
        conversationId: conv.id,
        role: "user",
        content: "Message with MAC",
        status: "sent",
        redactionState: "none",
      });

      const row = driver.get<{ mac: string | null }>(
        "SELECT mac FROM messages WHERE id = ?",
        [msg.id]
      );
      expect(row).toBeDefined();
      expect(row!.mac).not.toBeNull();
    });

    it("updates MAC on row update", async () => {
      const conv = await store.createConversation(convInput({ title: "Original" }));

      const rowBefore = driver.get<{ mac: string | null }>(
        "SELECT mac FROM conversations WHERE id = ?",
        [conv.id]
      );
      const macBefore = rowBefore!.mac;

      await store.updateConversation(conv.id, { title: "Updated" });

      const rowAfter = driver.get<{ mac: string | null }>(
        "SELECT mac FROM conversations WHERE id = ?",
        [conv.id]
      );
      expect(rowAfter!.mac).not.toBeNull();
      // MAC should change when the payload changes
      expect(rowAfter!.mac).not.toBe(macBefore);
    });

    it("reads back data with valid MAC without error", async () => {
      const conv = await store.createConversation(convInput({ title: "Valid MAC" }));
      const loaded = await store.getConversation(conv.id);
      expect(loaded).toBeDefined();
      expect(loaded!.title).toBe("Valid MAC");
    });

    it("reads back data from list with valid MAC", async () => {
      await store.createConversation(convInput({ workspaceId: "ws-1", title: "A" }));
      await store.createConversation(convInput({ workspaceId: "ws-1", title: "B" }));

      const list = await store.listConversations("ws-1");
      expect(list).toHaveLength(2);
      expect(list.map((c) => c.title).sort()).toEqual(["A", "B"]);
    });
  });

  describe("MAC tampering detection", () => {
    it("throws when payload is tampered with (MAC mismatch)", async () => {
      const driver = createMemoryDriver();
      const store = new SqlRectorStore({ driver, macKey });
      const conv = await store.createConversation(convInput({ title: "Original" }));

      // Tamper with the payload directly in the DB — change the JSON payload
      // but leave the MAC unchanged
      driver.run(
        "UPDATE conversations SET payload = ? WHERE id = ?",
        [JSON.stringify({ ...conv, title: "TAMPERED" }), conv.id]
      );

      await expect(store.getConversation(conv.id)).rejects.toThrow(
        /MAC mismatch|tampered/i
      );
    });

    it("throws when MAC is tampered with (MAC mismatch)", async () => {
      const driver = createMemoryDriver();
      const store = new SqlRectorStore({ driver, macKey });
      const conv = await store.createConversation(convInput({ title: "Original" }));

      // Tamper with the MAC directly — replace it with a fake value
      driver.run(
        "UPDATE conversations SET mac = ? WHERE id = ?",
        ["fake-mac-value", conv.id]
      );

      await expect(store.getConversation(conv.id)).rejects.toThrow(
        /MAC mismatch|tampered/i
      );
    });

    it("throws on list when one row has a tampered payload", async () => {
      const driver = createMemoryDriver();
      const store = new SqlRectorStore({ driver, macKey });
      const conv1 = await store.createConversation(convInput({ workspaceId: "ws-1", title: "Clean" }));
      const conv2 = await store.createConversation(convInput({ workspaceId: "ws-1", title: "Also Clean" }));

      // Tamper with one row
      driver.run(
        "UPDATE conversations SET payload = ? WHERE id = ?",
        [JSON.stringify({ ...conv1, title: "TAMPERED" }), conv1.id]
      );

      // List should throw because one row fails MAC verification
      await expect(store.listConversations("ws-1")).rejects.toThrow(
        /MAC mismatch|tampered/i
      );

      // Untampered row should still be readable individually
      const safeConv = await store.getConversation(conv2.id);
      expect(safeConv!.title).toBe("Also Clean");
    });
  });

  describe("legacy rows without MAC", () => {
    it("accepts rows without MAC with a warning (backward compat)", async () => {
      const driver = createMemoryDriver();
      // First: write data WITHOUT a macKey (no MAC column populated)
      const plainStore = new SqlRectorStore({ driver });
      const conv = await plainStore.createConversation(convInput({ title: "Legacy" }));

      // Now: create a new store WITH macKey over the same driver
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const macStore = new SqlRectorStore({ driver, macKey });

      // Should still be able to read the legacy data (warning emitted)
      const loaded = await macStore.getConversation(conv.id);
      expect(loaded).toBeDefined();
      expect(loaded!.title).toBe("Legacy");

      // A warning should have been emitted for the legacy row
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("No MAC on")
      );
      warnSpy.mockRestore();
    });

    it("new writes after reading legacy data include MAC", async () => {
      const driver = createMemoryDriver();
      const plainStore = new SqlRectorStore({ driver });
      await plainStore.createConversation(convInput({ workspaceId: "ws-1", title: "Old" }));

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const macStore = new SqlRectorStore({ driver, macKey });
      const newConv = await macStore.createConversation(convInput({ workspaceId: "ws-2", title: "New with MAC" }));
      warnSpy.mockRestore();

      // The new row should have a MAC
      const row = driver.get<{ mac: string | null }>(
        "SELECT mac FROM conversations WHERE id = ?",
        [newConv.id]
      );
      expect(row).toBeDefined();
      expect(row!.mac).not.toBeNull();
    });
  });

  describe("no MAC without macKey (opt-in)", () => {
    it("does not compute or verify MAC when macKey is not provided", async () => {
      const driver = createMemoryDriver();
      const store = new SqlRectorStore({ driver });
      const conv = await store.createConversation(convInput({ title: "No MAC" }));

      // The mac column should be null
      const row = driver.get<{ mac: string | null }>(
        "SELECT mac FROM conversations WHERE id = ?",
        [conv.id]
      );
      expect(row).toBeDefined();
      expect(row!.mac).toBeNull();

      // Reading back should work fine
      const loaded = await store.getConversation(conv.id);
      expect(loaded!.title).toBe("No MAC");
    });
  });

  describe("MAC key derivation", () => {
    it("deriveMacKey produces a 32-byte key from a 32-byte master", () => {
      const key = deriveMacKey(masterKey);
      expect(key.length).toBe(32);
    });

    it("deriveMacKey is deterministic", () => {
      const key1 = deriveMacKey(masterKey);
      const key2 = deriveMacKey(masterKey);
      expect(key1.equals(key2)).toBe(true);
    });

    it("deriveMacKey produces a different key from the master key", () => {
      const key = deriveMacKey(masterKey);
      expect(key.equals(masterKey)).toBe(false);
    });

    it("derivePayloadMacKey is independent of deriveDbEncryptionKey", () => {
      const macKey = derivePayloadMacKey(masterKey);
      const dbEncKey = createHmac("sha256", masterKey).update("rector.db-encryption.v1").digest();
      expect(macKey.equals(dbEncKey)).toBe(false);
    });
  });

  describe("MAC with encryption (combined H1+H8)", () => {
    it("computes MAC over encrypted payload when both keys present", async () => {
      const driver = createMemoryDriver();
      const encryptionKey = createHmac("sha256", masterKey).update("rector.db-encryption.v1").digest();
      const store = new SqlRectorStore({ driver, encryptionKey, macKey });

      const conv = await store.createConversation(convInput({ title: "Encrypted+MAC" }));
      const loaded = await store.getConversation(conv.id);
      expect(loaded!.title).toBe("Encrypted+MAC");

      // Payload should be encrypted (ENC1: prefix)
      const row = driver.get<{ payload: string; mac: string | null }>(
        "SELECT payload, mac FROM conversations WHERE id = ?",
        [conv.id]
      );
      expect(row!.payload.startsWith("ENC1:")).toBe(true);
      expect(row!.mac).not.toBeNull();
    });

    it("detects tampering on encrypted payload with MAC", async () => {
      const driver = createMemoryDriver();
      const encryptionKey = createHmac("sha256", masterKey).update("rector.db-encryption.v1").digest();
      const store = new SqlRectorStore({ driver, encryptionKey, macKey });
      const conv = await store.createConversation(convInput({ title: "Safe" }));

      // Tamper: replace the encrypted payload with another valid encrypted payload
      // (from a different entity) but keep the MAC unchanged
      const otherConv = await store.createConversation(convInput({ title: "Other" }));
      const otherRow = driver.get<{ payload: string; mac: string | null }>(
        "SELECT payload, mac FROM conversations WHERE id = ?",
        [otherConv.id]
      );

      driver.run(
        "UPDATE conversations SET payload = ? WHERE id = ?",
        [otherRow!.payload, conv.id]
      );

      // The MAC no longer matches the swapped payload
      await expect(store.getConversation(conv.id)).rejects.toThrow(
        /MAC mismatch|tampered/i
      );
    });
  });

  describe("commitRunTransition MAC handling", () => {
    it("includes MAC in run transition transaction", async () => {
      const driver = createMemoryDriver();
      const store = new SqlRectorStore({ driver, macKey });
      const run = await store.createRun({
        conversationId: "conv-1",
        userMessageId: "msg-1",
        status: "running",
        phase: "EXECUTING",
        route: "local",
        complexity: "simple",
        budget: { maxUsd: 10, maxInputTokens: 500_000, maxOutputTokens: 500_000, maxModelCalls: 1000, maxRuntimeMs: 1_800_000, maxHealingAttempts: 10, allowedProviders: [], approvalRequiredAboveUsd: 1 },
        costEstimate: { usd: 0.5 },
        tokenEstimate: { input: 100, output: 200 },
        traceId: "trace-1",
        attempts: 0,
        healingAttempts: 0,
        validationAttempts: 0,
      });

      const updated = await store.commitRunTransition(
        run.id,
        { status: "validating", phase: "VALIDATING" },
        {
          id: "evt-1",
          runId: run.id,
          type: "PHASE_CHANGED",
          phase: "VALIDATING",
          createdAt: new Date().toISOString(),
          payload: { from: "EXECUTING", to: "VALIDATING" },
        }
      );

      expect(updated.run.status).toBe("validating");

      // The run should have a MAC after the transition
      const row = driver.get<{ mac: string | null }>(
        "SELECT mac FROM runs WHERE id = ?",
        [run.id]
      );
      expect(row!.mac).not.toBeNull();

      // The event should also have a MAC
      const eventRow = driver.get<{ mac: string | null }>(
        "SELECT mac FROM run_events WHERE id = ?",
        ["evt-1"]
      );
      expect(eventRow!.mac).not.toBeNull();
    });
  });
});
