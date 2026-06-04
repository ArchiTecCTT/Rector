import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import { createApp } from "../src/api/server";
import { TaskManager } from "../src/thalamus/router";
import { LocalTelemetry, type WorkerDependencies } from "../src/adapters/providers";
import http from "node:http";

function makeManager() {
  const manager = new TaskManager();
  const tel = new LocalTelemetry();
  manager.setTelemetry({
    record: (e) => tel.record(e),
    getMetrics: () => tel.getMetrics(),
  });
  return manager;
}

describe("API", () => {
  let app: express.Application;
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    const manager = makeManager();
    app = createApp(manager);
    return new Promise<void>((resolve) => {
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
    return { status: res.status, data: res.ok ? await res.json().catch(() => ({})) : await res.text() };
  }

  it("creates a task", async () => {
    const r = await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ description: "api-test hello" }),
    });
    expect(r.status).toBe(201);
    expect((r.data as any).id).toBeDefined();
    expect((r.data as any).state).toBe("1_INTAKE");
  });

  it("rejects missing description", async () => {
    const r = await api("/api/tasks", { method: "POST", body: JSON.stringify({}) });
    expect(r.status).toBe(400);
  });

  it("lists tasks", async () => {
    const r = await api("/api/tasks");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.data)).toBe(true);
  });

  it("gets task by id", async () => {
    const created = await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ description: "get-by-id" }),
    });
    const id = (created.data as any).id;
    const r = await api(`/api/tasks/${id}`);
    expect(r.status).toBe(200);
    expect((r.data as any).description).toBe("get-by-id");
  });

  it("returns 404 for an unknown task id", async () => {
    const r = await api("/api/tasks/no-such-task");
    expect(r.status).toBe(404);
  });

  it("advances task one step", async () => {
    const created = await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ description: "advance me" }),
    });
    const id = (created.data as any).id;
    const r = await api(`/api/tasks/${id}/advance`, { method: "POST" });
    expect(r.status).toBe(200);
    expect((r.data as any).state).toBe("2_ARCHITECTURAL_PLAN");
  });

  it("pauses a task", async () => {
    const created = await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ description: "pause me" }),
    });
    const id = (created.data as any).id;
    const r = await api(`/api/tasks/${id}/pause`, { method: "POST" });
    expect(r.status).toBe(200);
    expect((r.data as any).state).toBe("PAUSED");
  });

  it("retries a paused task", async () => {
    const created = await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ description: "retry test" }),
    });
    const id = (created.data as any).id;
    await api(`/api/tasks/${id}/pause`, { method: "POST" });
    const r = await api(`/api/tasks/${id}/retry`, { method: "POST" });
    expect(r.status).toBe(200);
    expect((r.data as any).state).toBe("1_INTAKE");
  });

  it("does not retry an aborted task", async () => {
    const created = await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ description: "aborted retry test" }),
    });
    const id = (created.data as any).id;
    await api(`/api/tasks/${id}/abort`, { method: "POST" });
    const r = await api(`/api/tasks/${id}/retry`, { method: "POST" });
    expect(r.status).toBe(400);
  });

  it("aborts a task", async () => {
    const created = await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ description: "abort test" }),
    });
    const id = (created.data as any).id;
    const r = await api(`/api/tasks/${id}/abort`, { method: "POST" });
    expect(r.status).toBe(200);
    expect((r.data as any).state).toBe("ABORTED");
  });

  it("persists approval at human handoff", async () => {
    const created = await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ description: "approve me" }),
    });
    const id = (created.data as any).id;
    let task = created.data as any;
    for (let i = 0; i < 10 && task.state !== "7_HUMAN_HANDOFF"; i++) {
      task = (await api(`/api/tasks/${id}/advance`, { method: "POST" })).data as any;
    }

    const approved = await api(`/api/tasks/${id}/approve`, { method: "POST" });
    expect(approved.status).toBe(200);
    expect((approved.data as any).approved).toBe(true);

    const fetched = await api(`/api/tasks/${id}`);
    expect((fetched.data as any).approved).toBe(true);
  });

  it("rejects approval before human handoff", async () => {
    const created = await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ description: "not ready" }),
    });
    const id = (created.data as any).id;
    const r = await api(`/api/tasks/${id}/approve`, { method: "POST" });
    expect(r.status).toBe(400);
  });

  it("telemetry endpoint returns metrics", async () => {
    const r = await api("/api/telemetry");
    expect(r.status).toBe(200);
    expect((r.data as any).totalCost).toBeDefined();
  });

  it("setup endpoint returns checklist without leaking secret values", async () => {
    const secrets = {
      LLM_API_KEY: "super-secret-test-key",
      AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
      NEW_RELIC_LICENSE_KEY: "new-relic-secret",
      KAFKA_USERNAME: "confluent-api-key",
      MONGO_URI: "mongodb://admin:s3cret@host/rector",
    };
    for (const [key, value] of Object.entries(secrets)) process.env[key] = value;
    try {
      const r = await api("/api/setup");
      expect(r.status).toBe(200);
      expect(Array.isArray(r.data)).toBe(true);
      expect((r.data as any).length).toBeGreaterThan(0);
      for (const key of Object.keys(secrets)) {
        const item = (r.data as any[]).find((entry) => entry.key === key);
        expect(item.isSet).toBe(true);
        expect(item.isSensitive).toBe(true);
        expect(item.currentValue).toBeUndefined();
        expect(item.displayValue).toBe("••••••••");
      }
    } finally {
      for (const key of Object.keys(secrets)) delete process.env[key];
    }
  });

  it("serves the UI shell at /", async () => {
    const res = await fetch(`${base}/`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("Rector");
    expect(html).toContain("Chat with Rector");
  });

  it("scenario endpoint seeds a task", async () => {
    const r = await api("/api/dev/scenario", {
      method: "POST",
      body: JSON.stringify({ type: "happy" }),
    });
    expect(r.status).toBe(201);
    expect((r.data as any).id).toBeDefined();
  });

  it("rejects unknown scenario types", async () => {
    const r = await api("/api/dev/scenario", {
      method: "POST",
      body: JSON.stringify({ type: "unknown" }),
    });
    expect(r.status).toBe(400);
  });
});
