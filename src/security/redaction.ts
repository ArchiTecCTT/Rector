const REDACTED = "[REDACTED]";

const SECRET_KEY_PATTERN = /(^|[_-])(api[_-]?key|token|secret|password|authorization|cookie|connection[_-]?string)($|[_-])/i;
const URI_KEY_PATTERN = /(^|[_-])(uri|url|dsn)($|[_-])/i;
const CREDENTIAL_URI_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi;
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

export function isSensitiveKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
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
    if (URI_KEY_PATTERN.test(childKey) && typeof childValue === "string") {
      output[childKey] = redactString(childValue);
      continue;
    }
    output[childKey] = redactValue(childValue, childKey, seen);
  }
  return output;
}
