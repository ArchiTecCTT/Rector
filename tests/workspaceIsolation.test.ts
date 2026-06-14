import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { createApp } from "../src/api/server";
import { SESSION_COOKIE_NAME, hashPassword, type ParsedAuthConfig } from "../src/security/auth";
import { createInMemoryWorkspaceDirectory } from "../src/security/workspaces";
import { TaskManager } from "../src/thalamus/router";

const password = "isolation-password";

function authConfig(): ParsedAuthConfig {
  const passwordHash = hashPassword(password);
  return {
    enabled: true,
    sessionSecret: "workspace-isolation-secret",
    users: new Map([["alice", passwordHash], ["bob", passwordHash]]),
  };
}

async function startHarness() {
  const directory = createInMemoryWorkspaceDirectory({ autoProvisionPersonalWorkspaces: false });
  await directory.createWorkspace({ id: "alice-team", name: "Alice Team", ownerUserId: "alice" });
  await directory.createWorkspace({ id: "bob-team", name: "Bob Team", ownerUserId: "bob" });
  const app = createApp(new TaskManager(), {
    auth: authConfig(),
    workspaceDirectory: directory,
    secretEncryptionKey: Buffer.alloc(32, 5),
    rateLimit: { maxRequests: 500 },
  });
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 3000;
  return { server, base: `http://127.0.0.1:${port}` };
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

describe("workspace isolation helpers and route enforcement", () => {
  let harness: Awaited<ReturnType<typeof startHarness>>;
  let alice: string;
  let bob: string;
  let conversationId: string;

  beforeAll(async () => {
    harness = await startHarness();
    alice = await login(harness.base, "alice");
    bob = await login(harness.base, "bob");
    const created = await api(harness.base, "/api/chat/conversations", {
      method: "POST",
      cookie: alice,
      body: JSON.stringify({ title: "Alice private", workspaceId: "alice-team" }),
    });
    expect(created.status).toBe(201);
    conversationId = created.data.id;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => harness.server.close((error) => (error ? reject(error) : resolve())));
  });

  it("allows the workspace member to read its own conversation", async () => {
    const res = await api(harness.base, `/api/chat/conversations/${conversationId}`, { cookie: alice });
    expect(res.status).toBe(200);
    expect(res.data.conversation.workspaceId).toBe("alice-team");
  });

  it("blocks cross-workspace conversation reads", async () => {
    const res = await api(harness.base, `/api/chat/conversations/${conversationId}`, { cookie: bob });
    expect(res.status).toBe(403);
    expect(res.data.error).toMatch(/Workspace access denied|Permission denied/);
  });

  it("filters conversation lists to memberships when no workspace query is supplied", async () => {
    const aliceList = await api(harness.base, "/api/chat/conversations", { cookie: alice });
    const bobList = await api(harness.base, "/api/chat/conversations", { cookie: bob });

    expect(aliceList.status).toBe(200);
    expect(aliceList.data.conversations.map((conversation: any) => conversation.id)).toContain(conversationId);
    expect(bobList.status).toBe(200);
    expect(bobList.data.conversations.map((conversation: any) => conversation.id)).not.toContain(conversationId);
  });
});
