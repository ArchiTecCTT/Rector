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
