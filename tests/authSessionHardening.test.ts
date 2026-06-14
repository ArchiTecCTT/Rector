import { describe, expect, it } from "vitest";
import {
  buildClearSessionCookie,
  buildSessionCookie,
  createSessionToken,
  hashPassword,
  parseAuthConfig,
  parseAuthMode,
  shouldUseSecureSessionCookie,
  verifyPassword,
} from "../src/security/auth";
import { createLocalSessionAuthAdapter, createOidcAuthAdapterStub } from "../src/security/authAdapters";

describe("auth session hardening", () => {
  it("sets secure HttpOnly SameSite cookies in production but preserves local HTTP", () => {
    const token = createSessionToken("alice", "alice", "secret");
    const localCookie = buildSessionCookie(token, { NODE_ENV: "development" });
    const prodCookie = buildSessionCookie(token, { NODE_ENV: "production" });

    expect(localCookie).toContain("HttpOnly");
    expect(localCookie).toContain("SameSite=Lax");
    expect(localCookie).not.toContain("Secure");
    expect(prodCookie).toContain("Secure");
    expect(buildClearSessionCookie({ NODE_ENV: "production" })).toContain("Secure");
    expect(shouldUseSecureSessionCookie({ PUBLIC_APP_URL: "https://rector.example.test" })).toBe(true);
  });

  it("keeps Auth0/OIDC optional behind an adapter shape", async () => {
    const adapter = createOidcAuthAdapterStub({ kind: "auth0" });
    expect(adapter.kind).toBe("auth0");
    await expect(adapter.getLoginUrl?.("state")).rejects.toThrow(/not enabled/);
    await expect(adapter.verifySession({ header: () => undefined } as any)).resolves.toBeUndefined();
  });

  it("supports the local session adapter without external providers", async () => {
    const passwordHash = hashPassword("pw");
    expect(verifyPassword("pw", passwordHash)).toBe(true);
    const authConfig = parseAuthConfig({
      RECTOR_AUTH_ENABLED: "true",
      RECTOR_AUTH_SESSION_SECRET: "session-secret",
      RECTOR_AUTH_USERS: JSON.stringify([{ username: "alice", passwordHash }]),
    });
    const token = createSessionToken("alice", "alice", authConfig.sessionSecret);
    const adapter = createLocalSessionAuthAdapter(authConfig);
    const session = await adapter.verifySession({ header: () => `rector_session=${encodeURIComponent(token)}` } as any);
    expect(session).toMatchObject({ userId: "alice", username: "alice" });
  });

  it("derives auth modes without requiring external providers", () => {
    expect(parseAuthMode({})).toBe("local-dev");
    expect(parseAuthMode({ RECTOR_AUTH_ENABLED: "true" })).toBe("self-hosted");
    expect(parseAuthMode({ RECTOR_AUTH_MODE: "external-oidc" })).toBe("external-oidc");
  });
});
