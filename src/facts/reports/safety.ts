import { redactString } from "../../security/redaction";

const SECRET_MARKER_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/gi,
];

export function scrubKnownSecrets(value: string): string {
  let output = value;
  for (const pattern of SECRET_MARKER_PATTERNS) output = output.replace(pattern, "[REDACTED]");
  return output;
}

/** Redact secret-like substrings and normalize whitespace for fact eval report surfaces (JSON + markdown). */
export function safeReportText(value: string, maxLength?: number): string {
  const redacted = scrubKnownSecrets(redactString(value)).replace(/[\r\n|]/g, " ");
  if (maxLength === undefined) return redacted;
  return redacted.length > maxLength ? `${redacted.slice(0, Math.max(0, maxLength - 3))}...` : redacted;
}