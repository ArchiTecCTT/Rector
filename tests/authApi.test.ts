import { describe, expect, it, beforeAll, afterAll } from "vitest";
import express from "express";
import http from "node:http";
import fc from "fast-check";
import { createApp } from "../src/api/server";
import { TaskManager } from "../src/thalamus/router";
import {
  SESSION_COOKIE_NAME,
  hashPassword,
  type ParsedAuthConfig,
} from "../src/security/auth";
import { createInMemoryProviderConfigStore } from "../src/providers/configStore";

interface Harness {
  app: express.Application;
  server: http.Server;
  base: string;
}

async function startHarness(auth: ParsedAuthConfig): Promise<Harness> {
  const app = createApp(new TaskManager(), {
    auth,
    providerConfigStore: createInMemoryProviderConfigStore(),
    secretEncryptionKey: Buffer.alloc(32, 9),
  });
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 3000;
  return { app, server, base: `http://127.0.0.1:${port}` };
}

async function stopHarness(harness: Harness): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    harness.server.close((err) => (err ? reject(err) : resolve()));
  });
}

function extractSessionCookie(setCookie: string | null): string | undefined {
  if (!setCookie) return undefined;
  const match = setCookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

async function api(
  base: string,
  path: string,
  opts?: RequestInit & { cookie?: string },
): Promise<{ status: number; data: unknown; text: string; setCookie: string | null }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(opts?.headers as Record<string, string> | undefined),
  };
  if (opts?.cookie) headers.Cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(opts.cookie)}`;

  const res = await fetch(`${base}${path}`, {
    method: opts?.method ?? "GET",
    headers,
    body: opts?.body,
  });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    // keep raw text
  }
  return { status: res.status, data, text, setCookie: res.headers.get("set-cookie") };
}

function enabledAuth(password = "pw"): ParsedAuthConfig {
  const passwordHash = hashPassword(password);
  return {
    enabled: true,
    sessionSecret: "api-test-session-secret",
    users: new Map([["alice", passwordHash]]),
  };
}

describe("auth API integration", () => {
  describe("disabled mode bypasses auth", () => {
    let harness: Harness;

    beforeAll(async () => {
      harness = await startHarness({ enabled: false, sessionSecret: "", users: new Map() });
    });

    afterAll(async () => {
      await stopHarness(harness);
    });

    it("allows protected routes without a session", async () => {
      const res = await api(harness.base, "/api/providers");
      expect(res.status).toBe(200);
    });

    it("reports default session when auth is disabled", async () => {
      const res = await api(harness.base, "/api/auth/session");
      expect(res.status).toBe(200);
      expect(res.data).toEqual({ authenticated: true, username: "default" });
    });
  });

  describe("enabled mode enforces sessions", () => {
    let harness: Harness;
    const password = "alice-password";

    beforeAll(async () => {
      harness = await startHarness(enabledAuth(password));
    });

    afterAll(async () => {
      await stopHarness(harness);
    });

    it("returns 401 for protected routes without a session", async () => {
      const res = await api(harness.base, "/api/providers");
      expect(res.status).toBe(401);
      expect((res.data as { error?: string }).error).toBe("Authentication required");
    });

    it("allows public setup status without a session", async () => {
      const res = await api(harness.base, "/api/setup/status");
      expect(res.status).toBe(200);
      expect((res.data as { mode?: string }).mode).toBeDefined();
    });

    it("login sets a session cookie and unlocks protected routes", async () => {
      const login = await api(harness.base, "/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username: "alice", password }),
      });
      expect(login.status).toBe(200);
      expect(login.data).toEqual({ authenticated: true, username: "alice" });
      const cookie = extractSessionCookie(login.setCookie);
      expect(cookie).toBeTruthy();

      const providers = await api(harness.base, "/api/providers", { cookie });
      expect(providers.status).toBe(200);

      const session = await api(harness.base, "/api/auth/session", { cookie });
      expect(session.status).toBe(200);
      expect(session.data).toEqual({ authenticated: true, username: "alice" });
    });

    it("logout clears the session", async () => {
      const login = await api(harness.base, "/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username: "alice", password }),
      });
      const cookie = extractSessionCookie(login.setCookie);
      expect(cookie).toBeTruthy();

      const logout = await api(harness.base, "/api/auth/logout", {
        method: "POST",
        cookie,
      });
      expect(logout.status).toBe(200);
      expect(logout.data).toEqual({ authenticated: false });
      expect(logout.setCookie).toMatch(/Max-Age=0/);

      const blocked = await api(harness.base, "/api/providers");
      expect(blocked.status).toBe(401);
    });

    it("rejects invalid credentials with redacted errors and no hash leakage", async () => {
      const hash = hashPassword(password);
      const res = await api(harness.base, "/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username: "alice", password: "not-the-password" }),
      });
      expect(res.status).toBe(401);
      expect(res.text.includes(hash)).toBe(false);
      expect(res.text.includes(password)).toBe(false);
      expect((res.data as { error?: string }).error).toBe("Invalid username or password");
    });
  });

  it("property: enabled-mode API responses never include password hash substrings", async () => {
    const password = "property-test-password";
    const passwordHash = hashPassword(password);
    const harness = await startHarness(enabledAuth(password));

    try {
      await fc.assert(
        fc.asyncProperty(fc.constant(passwordHash), async (hash) => {
          const login = await api(harness.base, "/api/auth/login", {
            method: "POST",
            body: JSON.stringify({ username: "alice", password }),
          });
          const cookie = extractSessionCookie(login.setCookie);
          const session = await api(harness.base, "/api/auth/session", { cookie });
          const denied = await api(harness.base, "/api/providers");

          for (const res of [login, session, denied]) {
            expect(res.text.includes(hash)).toBe(false);
            expect(res.text.includes(password)).toBe(false);
          }
        }),
        { numRuns: 8 },
      );
    } finally {
      await stopHarness(harness);
    }
  });
});