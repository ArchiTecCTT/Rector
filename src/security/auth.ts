import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { redactString } from "./redaction";

/** Cookie name for the signed session token. */
export const SESSION_COOKIE_NAME = "rector_session";

/** Default session lifetime: 7 days. */
export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface AuthUserRecord {
  username: string;
  passwordHash: string;
}

export interface ParsedAuthConfig {
  enabled: boolean;
  sessionSecret: string;
  /** username (lowercase) -> scrypt password hash */
  users: Map<string, string>;
}

function truthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

function parseUsersJson(raw: string, source: string): Map<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid ${source}: expected JSON array of { username, passwordHash }`);
  }

  const users = new Map<string, string>();
  if (!Array.isArray(parsed)) {
    throw new Error(`Invalid ${source}: expected JSON array of { username, passwordHash }`);
  }

  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const username = typeof record.username === "string" ? normalizeUsername(record.username) : "";
    const passwordHash = typeof record.passwordHash === "string" ? record.passwordHash.trim() : "";
    if (!username || !passwordHash) continue;
    users.set(username, passwordHash);
  }
  return users;
}

function loadUsersFromFile(filePath: string): Map<string, string> | undefined {
  if (!existsSync(filePath)) return undefined;
  const raw = readFileSync(filePath, "utf8");
  return parseUsersJson(raw, filePath);
}

/**
 * Parse auth configuration from environment variables and optional on-disk users file.
 *
 * Users are loaded from `RECTOR_AUTH_USERS` (JSON) when set, otherwise from
 * `.rector/auth-users.json`. Password hashes are scrypt envelopes produced by
 * {@link hashPassword}; plaintext passwords never appear in responses.
 */
export function parseAuthConfig(env: Record<string, string | undefined> = process.env): ParsedAuthConfig {
  const enabled = truthyEnv(env.RECTOR_AUTH_ENABLED);
  const sessionSecret = env.RECTOR_AUTH_SESSION_SECRET?.trim() ?? "";

  if (!enabled) {
    return { enabled: false, sessionSecret: "", users: new Map() };
  }

  if (!sessionSecret) {
    throw new Error("RECTOR_AUTH_SESSION_SECRET is required when RECTOR_AUTH_ENABLED=true");
  }

  const envUsers = env.RECTOR_AUTH_USERS?.trim();
  const users = envUsers
    ? parseUsersJson(envUsers, "RECTOR_AUTH_USERS")
    : (loadUsersFromFile(".rector/auth-users.json") ?? new Map());

  return { enabled: true, sessionSecret, users };
}

/** Hash a password with scrypt for storage in auth-users.json / RECTOR_AUTH_USERS. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
}

/** Verify a plaintext password against a stored scrypt hash. */
export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  try {
    const salt = Buffer.from(parts[1]!, "hex");
    const expected = Buffer.from(parts[2]!, "hex");
    const actual = scryptSync(password, salt, expected.length);
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export interface VerifiedSession {
  userId: string;
  username: string;
}

function signPayload(payload: string, sessionSecret: string): string {
  return createHmac("sha256", sessionSecret).update(payload).digest("base64url");
}

/** Create a signed session token for `userId` / `username`. */
export function createSessionToken(userId: string, username: string, sessionSecret: string): string {
  const exp = Date.now() + SESSION_MAX_AGE_MS;
  const payload = Buffer.from(JSON.stringify({ userId, username, exp }), "utf8").toString("base64url");
  const signature = signPayload(payload, sessionSecret);
  return `${payload}.${signature}`;
}

/** Verify a session cookie value and return the authenticated user, or null. */
export function verifySessionToken(token: string | undefined, sessionSecret: string): VerifiedSession | null {
  if (!token || !sessionSecret) return null;

  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;

  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = signPayload(payload, sessionSecret);

  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!timingSafeEqual(sigBuf, expectedBuf)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      userId?: unknown;
      username?: unknown;
      exp?: unknown;
    };
    if (typeof parsed.exp !== "number" || parsed.exp < Date.now()) return null;
    if (typeof parsed.userId !== "string" || typeof parsed.username !== "string") return null;
    return { userId: parsed.userId, username: parsed.username };
  } catch {
    return null;
  }
}

/** Redacted, secret-free auth error message suitable for API responses. */
export function authErrorMessage(reason: string): string {
  return redactString(reason);
}