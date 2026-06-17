import { createHmac, timingSafeEqual } from "node:crypto";

const MAC_CONTEXT = "rector.payload-mac.v1";

/**
 * Derive a MAC key from a master key using HKDF-like construction.
 * Uses HMAC-SHA256 with a fixed context string for domain separation.
 */
export function deriveMacKey(masterKey: Buffer): Buffer {
  return createHmac("sha256", masterKey).update(MAC_CONTEXT).digest();
}

/**
 * Compute an HMAC-SHA256 MAC of a payload string.
 * Returns a base64url-encoded string suitable for storage.
 */
export function computePayloadMac(payload: string, macKey: Buffer): string {
  return createHmac("sha256", macKey).update(payload).digest("base64url");
}

/**
 * Verify a payload MAC using constant-time comparison.
 * Returns true if the provided MAC matches the expected MAC for the payload.
 */
export function verifyPayloadMac(
  payload: string,
  mac: string,
  macKey: Buffer,
): boolean {
  const expected = computePayloadMac(payload, macKey);
  if (expected.length !== mac.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected), Buffer.from(mac));
}
