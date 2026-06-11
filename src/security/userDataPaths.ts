/**
 * Per-user data directory resolution for opt-in multi-user auth (chunk-037).
 *
 * When `RECTOR_AUTH_ENABLED=true`, each authenticated user receives an isolated
 * `.rector/users/{sanitized}/` subtree for BYOK configuration stores. When auth
 * is disabled the default `.rector/` paths are used instead (Req 9).
 */

const DEFAULT_DATA_DIR = ".rector";

/** Sanitize a user id for safe use as a single path segment. */
export function sanitizeUserId(userId: string): string {
  const trimmed = userId.trim();
  if (trimmed.length === 0) return "anonymous";
  return trimmed.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Resolve the data directory for a user. Auth-disabled mode uses the shared
 * `.rector/` root; auth-enabled mode uses `.rector/users/{sanitized}/`.
 */
export function resolveUserDataDir(userId: string, authEnabled = false): string {
  if (!authEnabled || userId === "default") {
    return `${DEFAULT_DATA_DIR}/`;
  }
  return `${DEFAULT_DATA_DIR}/users/${sanitizeUserId(userId)}/`;
}