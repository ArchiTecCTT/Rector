import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  SESSION_COOKIE_NAME,
  createSessionToken,
  hashPassword,
  parseAuthConfig,
  verifyPassword,
  verifySessionToken,
} from "../src/security/auth";

describe("auth core", () => {
  it("hashPassword and verifyPassword round-trip", () => {
    const hash = hashPassword("s3cret-pass!");
    expect(hash.startsWith("scrypt:")).toBe(true);
    expect(verifyPassword("s3cret-pass!", hash)).toBe(true);
    expect(verifyPassword("wrong", hash)).toBe(false);
  });

  it("createSessionToken and verifySessionToken round-trip", () => {
    const secret = "test-session-secret-value";
    const token = createSessionToken("alice", "alice", secret);
    const session = verifySessionToken(token, secret);
    expect(session).toEqual({ userId: "alice", username: "alice" });
    expect(verifySessionToken(token, "other-secret")).toBeNull();
    expect(verifySessionToken("not-a-token", secret)).toBeNull();
  });

  it("parseAuthConfig disables auth by default", () => {
    const config = parseAuthConfig({});
    expect(config.enabled).toBe(false);
    expect(config.users.size).toBe(0);
  });

  it("parseAuthConfig loads users from RECTOR_AUTH_USERS when enabled", () => {
    const hash = hashPassword("pw");
    const config = parseAuthConfig({
      RECTOR_AUTH_ENABLED: "true",
      RECTOR_AUTH_SESSION_SECRET: "session-secret-that-is-at-least-32-characters",
      RECTOR_AUTH_USERS: JSON.stringify([{ username: "Alice", passwordHash: hash }]),
    });
    expect(config.enabled).toBe(true);
    expect(config.users.get("alice")).toBe(hash);
  });

  it("requires session secret when auth is enabled", () => {
    expect(() => parseAuthConfig({ RECTOR_AUTH_ENABLED: "true" })).toThrow(/RECTOR_AUTH_SESSION_SECRET/);
  });
});

describe("auth responses contain no password hash substrings", () => {
  it("login success and session payloads never include the stored hash", async () => {
    const password = "operator-password-123";
    const passwordHash = hashPassword(password);
    const auth = parseAuthConfig({
      RECTOR_AUTH_ENABLED: "true",
      RECTOR_AUTH_SESSION_SECRET: "integration-secret-that-is-at-least-32-char",
      RECTOR_AUTH_USERS: JSON.stringify([{ username: "ops", passwordHash }]),
    });

    await fc.assert(
      fc.asyncProperty(fc.constant(passwordHash), async (hash) => {
        const token = createSessionToken("ops", "ops", auth.sessionSecret);
        const session = verifySessionToken(token, auth.sessionSecret);
        const bodies = [
          JSON.stringify({ authenticated: true, username: "ops" }),
          JSON.stringify(session),
          JSON.stringify({ error: "Invalid username or password" }),
        ];
        for (const body of bodies) {
          expect(body.includes(hash)).toBe(false);
          expect(body.includes(password)).toBe(false);
        }
      }),
      { numRuns: 12 },
    );
  });
});