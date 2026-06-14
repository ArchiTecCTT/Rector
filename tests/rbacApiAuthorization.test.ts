import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import express from "express";
import { createApp } from "../src/api/server";
import { hashPassword, SESSION_COOKIE_NAME, type ParsedAuthConfig } from "../src/security/auth";
import { createInMemoryWorkspaceDirectory, type WorkspaceDirectory } from "../src/security/workspaces";
import { TaskManager } from "../src/thalamus/router";

interface Harness {
  app: express.Application;
  server: http.Server;
  base: string;
  directory: WorkspaceDirectory;
}

const password = "rbac-password";

function authFor(users: string[]): ParsedAuthConfig {
  const passwordHash = hashPassword(password);
  return {
    enabled: true,
    sessionSecret: "rbac-api-session-secret",
    users: new Map(users.map((user) => [user, passwordHash])),
  };
}

async function startHarness(): Promise<Harness> {
  const directory = createInMemoryWorkspaceDirectory({ autoProvisionPersonalWorkspaces: false });
  await directory.createWorkspace({ id: "team", name: "Team", ownerUserId: "owner" });
  await directory.addMembership({ workspaceId: "team", userId: "admin", role: "admin" });
  await directory.addMembership({ workspaceId: "team", userId: "operator", role: "operator" });
  await directory.addMembership({ workspaceId: "team", userId: "developer", role: "developer" });
  await directory.addMembership({ workspaceId: "team", userId: "viewer", role: "viewer" });

  const app = createApp(new TaskManager(), {
    auth: authFor(["owner", "admin", "operator", "developer", "viewer"]),
    workspaceDirectory: directory,
    secretEncryptionKey: Buffer.alloc(32, 4),
    rateLimit: { maxRequests: 500 },
  });
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 3000;
  return { app, server, base: `http://127.0.0.1:${port}`, directory };
}

async function stopHarness(harness: Harness): Promise<void> {
  await new Promise<void>((resolve, reject) => harness.server.close((error) => (error ? reject(error) : resolve())));
}

async function api(base: string, path: string, opts: RequestInit & { cookie?: string } = {}): Promise<{ status: number; data: any; text: string; setCookie: string | null }> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(opts.headers as Record<string, string> | undefined) };
  if (opts.cookie) headers.Cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(opts.cookie)}`;
  const res = await fetch(`${base}${path}`, { ...opts, headers });
  const text = await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, data, text, setCookie: res.headers.get("set-cookie") };
}

async function login(base: string, username: string): Promise<string> {
  const res = await api(base, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  expect(res.status).toBe(200);
  const match = res.setCookie?.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
  expect(match?.[1]).toBeTruthy();
  return decodeURIComponent(match![1]!);
}

describe("RBAC API authorization", () => {
  let harness: Harness;
  let owner: string;
  let operator: string;
  let developer: string;
  let viewer: string;

  beforeAll(async () => {
    harness = await startHarness();
    owner = await login(harness.base, "owner");
    operator = await login(harness.base, "operator");
    developer = await login(harness.base, "developer");
    viewer = await login(harness.base, "viewer");
  });

  afterAll(async () => {
    await stopHarness(harness);
  });

  it("viewer cannot configure providers", async () => {
    const res = await api(harness.base, "/api/providers", {
      method: "POST",
      cookie: viewer,
      body: JSON.stringify({ id: "together:viewer", kind: "together", label: "Viewer" }),
    });
    expect(res.status).toBe(403);
    expect(res.data.permission).toBe("providers.configure");
  });

  it("developer can create chat conversations but cannot use operator controls", async () => {
    const created = await api(harness.base, "/api/chat/conversations", {
      method: "POST",
      cookie: developer,
      body: JSON.stringify({ title: "Developer run", workspaceId: "team" }),
    });
    expect(created.status).toBe(201);
    expect(created.data.workspaceId).toBe("team");

    const deniedAbort = await api(harness.base, "/api/operator/runs/not-a-run/abort", { method: "POST", cookie: developer, body: JSON.stringify({}) });
    expect(deniedAbort.status).toBe(403);
    expect(deniedAbort.data.permission).toBe("operator.manage");
  });

  it("operator reaches operator run controls while non-operator roles are denied", async () => {
    const approvals = await api(harness.base, "/api/operator/approvals", { cookie: operator });
    expect(approvals.status).toBe(200);

    const abortMissingRun = await api(harness.base, "/api/operator/runs/not-a-run/abort", { method: "POST", cookie: operator, body: JSON.stringify({}) });
    expect(abortMissingRun.status).toBe(404);
  });

  it("owner can manage quotas and developer cannot", async () => {
    const saved = await api(harness.base, "/api/quotas", {
      method: "PUT",
      cookie: owner,
      body: JSON.stringify({ workspaceId: "team", policy: { maxRunsPerDay: 2 } }),
    });
    expect(saved.status).toBe(200);
    expect(saved.data.policy.maxRunsPerDay).toBe(2);

    const denied = await api(harness.base, "/api/quotas", {
      method: "PUT",
      cookie: developer,
      body: JSON.stringify({ workspaceId: "team", policy: { maxRunsPerDay: 3 } }),
    });
    expect(denied.status).toBe(403);
    expect(denied.data.permission).toBe("billing.manage");
  });

  it("local auth-disabled mode remains zero-config", async () => {
    const localApp = createApp(new TaskManager(), { auth: { enabled: false, sessionSecret: "", users: new Map() } });
    const localServer = await new Promise<http.Server>((resolve) => {
      const s = localApp.listen(0, () => resolve(s));
    });
    const addr = localServer.address();
    const port = typeof addr === "object" && addr ? addr.port : 3000;
    const base = `http://127.0.0.1:${port}`;
    try {
      const providers = await api(base, "/api/providers");
      expect(providers.status).toBe(200);
      const conversation = await api(base, "/api/chat/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "Local", workspaceId: "arbitrary-local-workspace" }),
      });
      expect(conversation.status).toBe(201);
      expect(conversation.data.workspaceId).toBe("arbitrary-local-workspace");
    } finally {
      await new Promise<void>((resolve, reject) => localServer.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
