import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { createApp } from "../src/api/server";
import { SESSION_COOKIE_NAME, hashPassword, type ParsedAuthConfig } from "../src/security/auth";
import { createInMemoryAuditLogService, type AuditLogService } from "../src/security/auditLog";
import { createInMemoryWorkspaceDirectory } from "../src/security/workspaces";
import { TaskManager } from "../src/thalamus/router";

const password = "secret-access-password";

function authConfig(): ParsedAuthConfig {
  const passwordHash = hashPassword(password);
  return {
    enabled: true,
    sessionSecret: "secret-access-session-secret",
    users: new Map([["owner", passwordHash], ["admin", passwordHash]]),
  };
}

async function startHarness() {
  const directory = createInMemoryWorkspaceDirectory({ autoProvisionPersonalWorkspaces: false });
  await directory.createWorkspace({ id: "team", name: "Team", ownerUserId: "owner" });
  await directory.addMembership({ workspaceId: "team", userId: "admin", role: "admin" });
  const auditLog = createInMemoryAuditLogService();
  const app = createApp(new TaskManager(), {
    auth: authConfig(),
    workspaceDirectory: directory,
    auditLog,
    secretEncryptionKey: Buffer.alloc(32, 6),
    rateLimit: { maxRequests: 500 },
  });
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 3000;
  return { server, base: `http://127.0.0.1:${port}`, auditLog };
}

async function api(base: string, path: string, opts: RequestInit & { cookie?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(opts.headers as Record<string, string> | undefined) };
  if (opts.cookie) headers.Cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(opts.cookie)}`;
  const res = await fetch(`${base}${path}`, { ...opts, headers });
  const text = await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, data, text, setCookie: res.headers.get("set-cookie") };
}

async function login(base: string, username: string): Promise<string> {
  const res = await api(base, "/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
  expect(res.status).toBe(200);
  const match = res.setCookie?.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
  expect(match?.[1]).toBeTruthy();
  return decodeURIComponent(match![1]!);
}

describe("secret access control", () => {
  let harness: Awaited<ReturnType<typeof startHarness>>;
  let ownerCookie: string;
  let adminCookie: string;
  let auditLog: AuditLogService;

  beforeAll(async () => {
    harness = await startHarness();
    auditLog = harness.auditLog;
    ownerCookie = await login(harness.base, "owner");
    adminCookie = await login(harness.base, "admin");
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => harness.server.close((error) => (error ? reject(error) : resolve())));
  });

  it("lets admin configure non-secret provider metadata but not write secrets", async () => {
    const created = await api(harness.base, "/api/providers", {
      method: "POST",
      cookie: adminCookie,
      body: JSON.stringify({ id: "together:main", kind: "together", label: "Admin metadata" }),
    });
    expect(created.status).toBe(200);
    expect(created.data.provider.secretPresent).toBe(false);

    const denied = await api(harness.base, "/api/providers/together:main/secret", {
      method: "POST",
      cookie: adminCookie,
      body: JSON.stringify({ apiKey: "sk-admin-should-not-egress-123456" }),
    });
    expect(denied.status).toBe(403);
    expect(denied.text).not.toContain("sk-admin-should-not-egress-123456");
  });

  it("owner can rotate a secret and responses never return the value", async () => {
    const secret = "sk-owner-secret-no-egress-abcdef123456";
    const rotated = await api(harness.base, "/api/secrets/together:main/rotate", {
      method: "POST",
      cookie: ownerCookie,
      body: JSON.stringify({ value: secret }),
    });

    expect(rotated.status).toBe(200);
    expect(rotated.data).toEqual({ id: "together:main", rotated: true, secretPresent: true });
    expect(rotated.text).not.toContain(secret);
  });

  it("failed permission checks create audit events without secret values", async () => {
    const events = await auditLog.list({ workspaceId: "team", outcome: "denied" });
    expect(events.some((event) => event.action === "permission.providers.secrets.write")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("sk-admin-should-not-egress-123456");
  });
});
