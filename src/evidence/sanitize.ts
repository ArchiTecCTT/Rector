import { redactSecrets } from "../security/redaction";

export function sanitizeEvidencePayload<T>(payload: T): T {
  return redactSecrets(payload);
}
