import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import {
  deriveMacKey,
  computePayloadMac,
  verifyPayloadMac,
} from "../src/security/payloadIntegrity.js";

describe("payloadIntegrity", () => {
  describe("deriveMacKey", () => {
    it("derives a 32-byte key from a master key", () => {
      const masterKey = randomBytes(32);
      const derived = deriveMacKey(masterKey);
      expect(derived).toBeInstanceOf(Buffer);
      expect(derived.length).toBe(32);
    });

    it("is deterministic — same master key yields same derived key", () => {
      const masterKey = randomBytes(32);
      const a = deriveMacKey(masterKey);
      const b = deriveMacKey(masterKey);
      expect(a.equals(b)).toBe(true);
    });

    it("different master keys yield different derived keys", () => {
      const a = deriveMacKey(randomBytes(32));
      const b = deriveMacKey(randomBytes(32));
      expect(a.equals(b)).toBe(false);
    });
  });

  describe("computePayloadMac", () => {
    it("produces a base64url string", () => {
      const macKey = deriveMacKey(randomBytes(32));
      const mac = computePayloadMac('{"test":true}', macKey);
      expect(typeof mac).toBe("string");
      // base64url: only [A-Za-z0-9_-]
      expect(mac).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it("is deterministic — same payload + same key = same MAC", () => {
      const macKey = deriveMacKey(randomBytes(32));
      const payload = '{"id":1,"name":"test"}';
      const a = computePayloadMac(payload, macKey);
      const b = computePayloadMac(payload, macKey);
      expect(a).toBe(b);
    });

    it("different payloads produce different MACs", () => {
      const macKey = deriveMacKey(randomBytes(32));
      const a = computePayloadMac("payload-a", macKey);
      const b = computePayloadMac("payload-b", macKey);
      expect(a).not.toBe(b);
    });

    it("different keys produce different MACs for same payload", () => {
      const keyA = deriveMacKey(randomBytes(32));
      const keyB = deriveMacKey(randomBytes(32));
      const payload = "same-payload";
      expect(computePayloadMac(payload, keyA)).not.toBe(
        computePayloadMac(payload, keyB),
      );
    });
  });

  describe("verifyPayloadMac", () => {
    it("returns true for a valid MAC", () => {
      const macKey = deriveMacKey(randomBytes(32));
      const payload = '{"data":"hello"}';
      const mac = computePayloadMac(payload, macKey);
      expect(verifyPayloadMac(payload, mac, macKey)).toBe(true);
    });

    it("returns false for a tampered payload", () => {
      const macKey = deriveMacKey(randomBytes(32));
      const payload = '{"data":"hello"}';
      const mac = computePayloadMac(payload, macKey);
      expect(verifyPayloadMac('{"data":"tampered"}', mac, macKey)).toBe(false);
    });

    it("returns false for a wrong MAC", () => {
      const macKey = deriveMacKey(randomBytes(32));
      const payload = '{"data":"hello"}';
      expect(verifyPayloadMac(payload, "wrong-mac-value", macKey)).toBe(false);
    });

    it("returns false for a wrong key", () => {
      const macKey = deriveMacKey(randomBytes(32));
      const wrongKey = deriveMacKey(randomBytes(32));
      const payload = '{"data":"hello"}';
      const mac = computePayloadMac(payload, macKey);
      expect(verifyPayloadMac(payload, mac, wrongKey)).toBe(false);
    });

    it("returns false when MAC length differs from expected", () => {
      const macKey = deriveMacKey(randomBytes(32));
      const payload = '{"data":"hello"}';
      // base64url of 32 bytes is 43 chars; give a shorter string
      const shortMac = "short";
      expect(verifyPayloadMac(payload, shortMac, macKey)).toBe(false);
    });
  });
});
