import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import http from "node:http";
import { createApp } from "../src/api/server";
import { TaskManager } from "../src/thalamus/router";

function makeManager() {
  return new TaskManager();
}

describe("chat API vertical shell", () => {
  let app: express.Application;
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    app = createApp(makeManager());
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 3000;
        base = `http://localhost:${port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  async function api(path: string, opts?: RequestInit) {
    const res = await fetch(`${base}${path}`, {
      headers: { "Content-Type": "application/json", ...(opts?.headers ?? {}) },
      ...opts,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    return { status: res.status, data };
  }

  it("creates and lists conversations", async () => {
    const created = await api("/api/chat/conversations", {
      method: "POST",
      body: JSON.stringify({ title: "Chunk 6 smoke", workspaceId: "test-workspace" }),
    });

    expect(created.status).toBe(201);
    expect((created.data as any).id).toMatch(/^conv-/);
    expect((created.data as any).title).toBe("Chunk 6 smoke");

    const listed = await api("/api/chat/conversations");
    expect(listed.status).toBe(200);
    expect((listed.data as any).conversations.some((c: any) => c.id === (created.data as any).id)).toBe(true);
  });

  it("gets a conversation with messages", async () => {
    const created = await api("/api/chat/conversations", {
      method: "POST",
      body: JSON.stringify({ title: "Message container" }),
    });

    const fetched = await api(`/api/chat/conversations/${(created.data as any).id}`);
    expect(fetched.status).toBe(200);
    expect((fetched.data as any).conversation.id).toBe((created.data as any).id);
    expect((fetched.data as any).messages).toEqual([]);
  });

  it("creates user and assistant messages plus a hidden run and events", async () => {
    const created = await api("/api/chat/conversations", {
      method: "POST",
      body: JSON.stringify({ title: "Run trace" }),
    });
    const conversationId = (created.data as any).id;

    const sent = await api(`/api/chat/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "Explain the vertical slice" }),
    });

    expect(sent.status).toBe(201);
    expect((sent.data as any).userMessage.role).toBe("user");
    expect((sent.data as any).assistantMessage.role).toBe("assistant");
    expect((sent.data as any).assistantMessage.content).toContain("Rector received");
    expect((sent.data as any).run.id).toMatch(/^run-/);
    expect((sent.data as any).run.status).toBe("completed");
    const eventTypes = (sent.data as any).events.map((e: any) => e.type);
    expect(eventTypes[0]).toBe("RUN_CREATED");
    expect(eventTypes).toContain("PHASE_CHANGED");
    expect(eventTypes.at(-1)).toBe("RUN_COMPLETED");

    const fetched = await api(`/api/chat/conversations/${conversationId}`);
    expect((fetched.data as any).messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
  });

  it("sets chat run route and context events from triage", async () => {
    const created = await api("/api/chat/conversations", {
      method: "POST",
      body: JSON.stringify({ title: "Triage route" }),
    });
    const conversationId = (created.data as any).id;

    const sent = await api(`/api/chat/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "Fix the TypeScript bug in src/api/server.ts and update tests." }),
    });

    expect(sent.status).toBe(201);
    expect((sent.data as any).run.route).toBe("CODE_EDIT");
    expect((sent.data as any).run.complexity).toBe("medium");

    const triageEvent = (sent.data as any).events.find(
      (event: any) => event.phase === "TRIAGE" && event.payload?.triage?.route === "CODE_EDIT"
    );
    expect(triageEvent).toBeDefined();

    const contextEvent = (sent.data as any).events.find((event: any) => event.phase === "CONTEXT_BUILDING");
    expect(contextEvent?.payload?.contextPack?.conversationRef?.id).toBe(conversationId);
    expect(contextEvent?.payload?.contextPack?.messageRefs?.length).toBeGreaterThanOrEqual(1);

    const planningEvent = (sent.data as any).events.find((event: any) => event.phase === "PLANNING");
    expect(planningEvent?.payload?.plannerOutput?.goal).toContain("Fix the TypeScript bug");
    expect(planningEvent?.payload?.plannerOutput?.tasks.map((task: any) => task.id)).toEqual([
      "code.inspect",
      "code.edit",
      "code.validate",
    ]);

    const skepticEvent = (sent.data as any).events.find((event: any) => event.phase === "SKEPTIC_REVIEW");
    expect(skepticEvent?.payload?.skepticReview?.verdict).toBeDefined();
    expect(skepticEvent?.payload?.skepticReview?.findings).toEqual(expect.any(Array));

    const crucibleEvent = (sent.data as any).events.find((event: any) => event.phase === "CRUCIBLE");
    expect(crucibleEvent?.payload?.crucibleDecision?.verdict).toBeDefined();
    expect(crucibleEvent?.payload?.crucibleDecision?.round).toBe(1);
    expect(crucibleEvent?.payload?.crucibleDecision?.maxRounds).toBe(2);
  });

  it("returns run events", async () => {
    const created = await api("/api/chat/conversations", {
      method: "POST",
      body: JSON.stringify({ title: "Events" }),
    });
    const sent = await api(`/api/chat/conversations/${(created.data as any).id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "Show trace" }),
    });

    const events = await api(`/api/runs/${(sent.data as any).run.id}/events`);
    expect(events.status).toBe(200);
    expect((events.data as any).run.id).toBe((sent.data as any).run.id);
    expect((events.data as any).events.length).toBeGreaterThanOrEqual(4);
    expect((events.data as any).events.at(-1).phase).toBe("DONE");
  });

  it("returns 404 when sending to a missing conversation", async () => {
    const sent = await api("/api/chat/conversations/no-such-conv/messages", {
      method: "POST",
      body: JSON.stringify({ content: "hello" }),
    });
    expect(sent.status).toBe(404);
    expect((sent.data as any).error).toBe("Conversation not found");
  });

  it("validates retentionPolicy type consistently in POST /api/chat/conversations", async () => {
    const res = await api("/api/chat/conversations", {
      method: "POST",
      body: JSON.stringify({ title: "Valid title", retentionPolicy: 123 }),
    });
    expect(res.status).toBe(400);
    expect((res.data as any).error).toBe("retentionPolicy must be a string");
  });

  it("filters conversations by workspaceId on GET /api/chat/conversations", async () => {
    const wsA = `ws-${Math.random()}`;
    const wsB = `ws-${Math.random()}`;

    const convA = await api("/api/chat/conversations", {
      method: "POST",
      body: JSON.stringify({ title: "Conv in WS A", workspaceId: wsA }),
    });
    const convB = await api("/api/chat/conversations", {
      method: "POST",
      body: JSON.stringify({ title: "Conv in WS B", workspaceId: wsB }),
    });

    expect(convA.status).toBe(201);
    expect(convB.status).toBe(201);

    const listedA = await api(`/api/chat/conversations?workspaceId=${wsA}`);
    expect(listedA.status).toBe(200);
    expect((listedA.data as any).conversations.length).toBe(1);
    expect((listedA.data as any).conversations[0].id).toBe((convA.data as any).id);

    const listedB = await api(`/api/chat/conversations?workspaceId=${wsB}`);
    expect(listedB.status).toBe(200);
    expect((listedB.data as any).conversations.length).toBe(1);
    expect((listedB.data as any).conversations[0].id).toBe((convB.data as any).id);
  });

  it("returns 400 when message content is missing or invalid", async () => {
    const created = await api("/api/chat/conversations", {
      method: "POST",
      body: JSON.stringify({ title: "Validation Test" }),
    });
    const conversationId = (created.data as any).id;

    // Missing content entirely
    const resMissing = await api(`/api/chat/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(resMissing.status).toBe(400);
    expect((resMissing.data as any).error).toBe("content (string) is required");

    // Invalid content type (number)
    const resInvalidType = await api(`/api/chat/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: 12345 }),
    });
    expect(resInvalidType.status).toBe(400);
    expect((resInvalidType.data as any).error).toBe("content (string) is required");

    // Empty content string
    const resEmptyString = await api(`/api/chat/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "" }),
    });
    expect(resEmptyString.status).toBe(400);
    expect((resEmptyString.data as any).error).toBe("content (string) is required");
  });

  it("serves chat shell markers", async () => {
    const res = await fetch(`${base}/`);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("Rector");
    expect(html).toContain("blueprint");
    expect(html).toContain("data-chat-shell");
    expect(html).toContain("rector-chat-form");
  });
});
