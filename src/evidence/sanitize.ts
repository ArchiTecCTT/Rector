import { redactSecrets, redactString } from "../security/redaction";

export function sanitizeEvidencePayload<T>(payload: T): T {
  return redactSecrets(payload);
}

/** Redact secret patterns in string leaves only; preserve numeric budget fields and key names. */
export function sanitizeEvidenceStringLeaves<T>(value: T): T {
  if (typeof value === "string") {
    return redactString(value) as T;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeEvidenceStringLeaves(item)) as T;
  }
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    output[key] = sanitizeEvidenceStringLeaves(child);
  }
  return output as T;
}
