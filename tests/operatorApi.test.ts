import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import http from "node:http";
import { createApp } from "../src/api/server";
import { TaskManager } from "../src/thalamus/router";

function makeManager() {
  return new TaskManager();
}

describe("Retool operator console API", () => {
  let app: express.Application;
  let server: http.Server;
  let base: string;
  const originalFetch = globalThis.fetch.bind(globalThis);

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
    const res = await originalFetch(`${base}${path}`, {
      headers: { "Content-Type": "application/json", ...(opts?.headers ?? {}) },
      ...opts,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    return { status: res.status, data };
  }

  async function createRun(content = "Inspect this operator run") {
    const conversation = await api("/api/chat/conversations", {
      method: "POST",
      body: JSON.stringify({ title: "Operator API", workspaceId: "operator-test" }),
    });
    const message = await api(`/api/chat/conversations/${(conversation.data as any).id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content }),
    });
    return { conversation: conversation.data as any, message: message.data as any, run: (message.data as any).run };
  }

  it("lists and inspects runs with local-only no-auth metadata", async () => {
    const created = await createRun("Inspect run status and costs for Retool");

    const listed = await api("/api/operator/runs");
    expect(listed.status).toBe(200);
    expect((listed.data as any).localOnly).toBe(true);
    expect((listed.data as any).auth).toBe("local-only-no-auth");
    expect((listed.data as any).runs.some((run: any) => run.id === created.run.id)).toBe(true);

    const inspected = await api(`/api/operator/runs/${created.run.id}`);
    expect(inspected.status).toBe(200);
    expect((inspected.data as any).localOnly).toBe(true);
    expect((inspected.data as any).run.id).toBe(created.run.id);
    expect((inspected.data as any).conversation.id).toBe(created.conversation.id);
    expect((inspected.data as any).userMessage.id).toBe(created.message.userMessage.id);
    expect((inspected.data as any).assistantMessages.length).toBe(1);
    expect((inspected.data as any).events.length).toBeGreaterThanOrEqual(4);
    expect((inspected.data as any).artifactHandles).toEqual(expect.any(Array));
  });

  it("lists failures and approvals without provider or network dependencies", async () => {
    await createRun("Show failures and approvals tables");

    const failures = await api("/api/operator/failures");
    expect(failures.status).toBe(200);
    expect((failures.data as any).localOnly).toBe(true);
    expect((failures.data as any).failures).toEqual(expect.any(Array));

    const approvals = await api("/api/operator/approvals");
    expect(approvals.status).toBe(200);
    expect((approvals.data as any).localOnly).toBe(true);
    expect((approvals.data as any).approvals).toEqual(expect.any(Array));
  });

  it("summarizes local run costs and tokens", async () => {
    await createRun("Summarize costs");

    const costs = await api("/api/operator/costs");
    expect(costs.status).toBe(200);
    expect((costs.data as any).localOnly).toBe(true);
    expect((costs.data as any).summary.runCount).toBeGreaterThanOrEqual(1);
    expect((costs.data as any).summary.estimatedUsd).toBe(0);
    expect((costs.data as any).summary.actualUsd).toBe(0);
    expect((costs.data as any).summary.actualInputTokens).toBe(0);
    expect((costs.data as any).summary.actualOutputTokens).toBe(0);
  });

  it("keeps retry, abort, and approval decisions as non-mutating placeholders", async () => {
    const created = await createRun("Do not mutate placeholder controls");

    const retry = await api(`/api/operator/runs/${created.run.id}/retry`, { method: "POST" });
    expect(retry.status).toBe(202);
    expect((retry.data as any).status).toBe("placeholder");
    expect((retry.data as any).mutated).toBe(false);

    const abort = await api(`/api/operator/runs/${created.run.id}/abort`, { method: "POST" });
    expect(abort.status).toBe(202);
    expect((abort.data as any).status).toBe("placeholder");
    expect((abort.data as any).mutated).toBe(false);

    const decision = await api(`/api/operator/approvals/${created.run.id}/decision`, {
      method: "POST",
      body: JSON.stringify({ decision: "approve", note: "Retool placeholder" }),
    });
    expect(decision.status).toBe(202);
    expect((decision.data as any).status).toBe("placeholder");
    expect((decision.data as any).mutated).toBe(false);

    const inspected = await api(`/api/operator/runs/${created.run.id}`);
    expect((inspected.data as any).run.status).toBe(created.run.status);
    expect((inspected.data as any).run.phase).toBe(created.run.phase);
  });

  it("returns artifact metadata only and omits raw in-memory content", async () => {
    const oversizedContent = `artifact-marker-${"x".repeat(5000)}`;
    const created = await createRun(oversizedContent);
    const inspected = await api(`/api/operator/runs/${created.run.id}`);
    const artifactId = (inspected.data as any).artifactHandles[0]?.artifactId;
    expect(artifactId).toMatch(/^art-/);

    const artifact = await api(`/api/operator/artifacts/${artifactId}`);
    expect(artifact.status).toBe(200);
    expect((artifact.data as any).localOnly).toBe(true);
    expect((artifact.data as any).artifact.id).toBe(artifactId);
    expect((artifact.data as any).artifact.metadata.content).toBeUndefined();
    expect(JSON.stringify(artifact.data)).not.toContain(oversizedContent);
  });

  it("creates Linear issue stubs without network calls", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const created = await createRun("Create local Linear issue stub");
      const issue = await api("/api/operator/linear/issues", {
        method: "POST",
        body: JSON.stringify({ runId: created.run.id, title: "Investigate run", description: "No network" }),
      });

      expect(issue.status).toBe(202);
      expect((issue.data as any).localOnly).toBe(true);
      expect((issue.data as any).status).toBe("stubbed");
      expect((issue.data as any).networkCalls).toBe(0);
      expect((issue.data as any).issue.key).toMatch(/^LOCAL-LINEAR-/);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
