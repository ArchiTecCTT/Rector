import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type express from "express";
import { createApp } from "../src/api/server";
import { InMemoryRectorStore } from "../src/store";
import { TaskManager } from "../src/thalamus/router";

function clock(): () => string {
  let tick = 0;
  const base = Date.parse("2026-06-13T03:00:00.000Z");
  return () => new Date(base + tick++ * 1000).toISOString();
}

async function start(app: express.Application): Promise<{ base: string; server: http.Server }> {
  const server = await new Promise<http.Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 3000;
  return { base: `http://127.0.0.1:${port}`, server };
}

async function api(base: string, path: string) {
  const res = await fetch(`${base}${path}`, { headers: { "Content-Type": "application/json" } });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : {} };
}

describe("conversation search API", () => {
  const servers = new Set<http.Server>();

  afterEach(async () => {
    for (const server of servers) {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
    servers.clear();
  });

  it("returns redacted, workspace-scoped search hits", async () => {
    const store = new InMemoryRectorStore({ now: clock() });
    const conversation = await store.createConversation({
      title: "API Search",
      workspaceId: "api-ws",
      retentionPolicy: "session",
    });
    await store.createMessage({
      conversationId: conversation.id,
      role: "user",
      content: "Find zircon plus password=hunter2",
      status: "complete",
      redactionState: "none",
    });
    const other = await store.createConversation({
      title: "Other",
      workspaceId: "other-ws",
      retentionPolicy: "session",
    });
    await store.createMessage({
      conversationId: other.id,
      role: "user",
      content: "Find zircon elsewhere",
      status: "complete",
      redactionState: "none",
    });
    const harness = await start(createApp(new TaskManager(), { store }));
    servers.add(harness.server);

    const res = await api(harness.base, "/api/conversations/search?workspaceId=api-ws&q=zircon&limit=10");

    expect(res.status).toBe(200);
    expect(res.data.hits.map((hit: any) => hit.conversationId)).toEqual([conversation.id]);
    expect(JSON.stringify(res.data)).not.toContain("hunter2");
  });

  it("returns 400 for overlong search queries", async () => {
    const harness = await start(createApp(new TaskManager(), { store: new InMemoryRectorStore({ now: clock() }) }));
    servers.add(harness.server);

    const res = await api(harness.base, `/api/conversations/search?workspaceId=api-ws&q=${"x".repeat(501)}`);

    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/500 characters/);
  });

  it("returns ordered conversation lineage", async () => {
    const store = new InMemoryRectorStore({ now: clock() });
    const root = await store.createConversation({
      title: "Root",
      workspaceId: "api-lineage",
      retentionPolicy: "session",
    });
    const child = await store.createConversation({
      title: "Child",
      workspaceId: "api-lineage",
      parentConversationId: root.id,
      compressionGeneration: 1,
      retentionPolicy: "session",
    });
    const harness = await start(createApp(new TaskManager(), { store }));
    servers.add(harness.server);

    const res = await api(harness.base, `/api/conversations/${child.id}/lineage`);

    expect(res.status).toBe(200);
    expect(res.data.lineage.map((conversation: any) => conversation.id)).toEqual([root.id, child.id]);
  });
});
