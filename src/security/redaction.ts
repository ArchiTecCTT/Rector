const REDACTED = "[REDACTED]";

const SECRET_KEYWORDS = ["apikey", "token", "secret", "password", "authorization", "cookie", "connectionstring"];
const URI_KEYWORDS = ["uri", "url", "dsn"];
const CREDENTIAL_URI_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@]*@)/gi;
const BEARER_PATTERN = /\bBearer\s+[^\s,;]+/gi;
const BASIC_PATTERN = /\bBasic\s+[^\s,;]+/gi;
const INLINE_SECRET_PATTERN = /\b(api[_-]?key|token|secret|password)=([^\s,;&]+)/gi;

export function redactString(value: string): string {
  return value
    .replace(CREDENTIAL_URI_PATTERN, (_match, scheme: string) => `${scheme}${REDACTED}@`)
    .replace(BEARER_PATTERN, `Bearer ${REDACTED}`)
    .replace(BASIC_PATTERN, `Basic ${REDACTED}`)
    .replace(INLINE_SECRET_PATTERN, (_match, key: string) => `${key}=${REDACTED}`);
}

export function redactSecrets<T>(value: T): T {
  return redactValue(value, undefined, new WeakSet()) as T;
}

/**
 * Fixed, secret-free message returned whenever outbound redaction cannot complete. It carries no
 * caller-supplied content (only this constant), so suppressing a response can never itself leak a
 * secret substring (Requirement 11.5).
 */
export const REDACTION_FAILED_ERROR = "redaction-failed: outbound content suppressed";

/** Successful outbound redaction carrying the redacted value (Requirement 11.5). */
export interface RedactionSuccess<T> {
  ok: true;
  value: T;
}

/** Failed outbound redaction: the raw content is suppressed and only a fixed error is returned. */
export interface RedactionFailure {
  ok: false;
  error: string;
}

/** The outcome of an outbound redaction pass: either the redacted value or a suppression error. */
export type RedactionOutcome<T> = RedactionSuccess<T> | RedactionFailure;

/**
 * Outbound redaction-failure suppression (Requirement 11.5).
 *
 * Run `value` through {@link redactSecrets} and return the redacted value on success. If redaction
 * throws for any reason, the raw (unredacted) content is suppressed — never returned — and a
 * structured {@link RedactionFailure} carrying only the fixed {@link REDACTION_FAILED_ERROR} is
 * returned instead. This is the single reusable boundary every productization response, streamed
 * frame, and error path routes through so unredacted content can never escape the process.
 */
export function redactOutbound<T>(value: T): RedactionOutcome<T> {
  try {
    return { ok: true, value: redactSecrets(value) };
  } catch {
    return { ok: false, error: REDACTION_FAILED_ERROR };
  }
}

/**
 * Redact a single string for an outbound boundary, suppressing the raw value on failure
 * (Requirement 11.5). Returns the redacted string on success; if {@link redactString} throws, the
 * raw content is suppressed and the fixed {@link REDACTION_FAILED_ERROR} placeholder is returned in
 * its place so no unredacted substring is ever emitted (used for streamed view fields where a
 * per-field placeholder is preferable to dropping the whole frame).
 */
export function redactStringOrSuppress(value: string): string {
  try {
    return redactString(value);
  } catch {
    return REDACTION_FAILED_ERROR;
  }
}

export function isSensitiveKey(key: string): boolean {
  const compactKey = compactKeyName(key);
  return SECRET_KEYWORDS.some((keyword) => compactKey.includes(keyword));
}

function isUriKey(key: string): boolean {
  const compactKey = compactKeyName(key);
  return URI_KEYWORDS.some((keyword) => compactKey.includes(keyword));
}

function compactKeyName(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function redactValue(value: unknown, key: string | undefined, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    if (key && isSensitiveKey(key)) return REDACTED;
    return redactString(value);
  }

  if (value === null || typeof value !== "object") return value;

  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, undefined, seen));
  }

  const output: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(childKey)) {
      output[childKey] = REDACTED;
      continue;
    }
    if (isUriKey(childKey) && typeof childValue === "string") {
      output[childKey] = redactString(childValue);
      continue;
    }
    output[childKey] = redactValue(childValue, childKey, seen);
  }
  return output;
}
