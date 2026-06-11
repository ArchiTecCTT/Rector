import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import http from "node:http";
import { createApp } from "../src/api/server";
import { TaskManager } from "../src/thalamus/router";
import { createInMemoryModuleConfigStore } from "../src/modules/moduleConfigStore";
import { NEURO_PREPROCESS_MODULE_ID } from "../src/modules/builtin/neuro-preprocess";

function makeManager(): TaskManager {
  const manager = new TaskManager();
  return manager;
}

describe("Modules API (Chunk 041)", () => {
  let app: express.Application;
  let server: http.Server;
  let base: string;
  const moduleConfigStore = createInMemoryModuleConfigStore();

  beforeAll(async () => {
    app = createApp(makeManager(), { moduleConfigStore });
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 3000;
        base = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  async function api(path: string, init?: RequestInit) {
    const res = await fetch(`${base}${path}`, {
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      ...init,
    });
    const data = res.ok ? await res.json().catch(() => ({})) : await res.text();
    return { status: res.status, data };
  }

  it("lists builtin modules with enabled state", async () => {
    const { status, data } = await api("/api/modules");
    expect(status).toBe(200);
    expect(Array.isArray(data.modules)).toBe(true);
    const preprocess = data.modules.find((m: { id: string }) => m.id === NEURO_PREPROCESS_MODULE_ID);
    expect(preprocess?.enabled).toBe(true);
  });

  it("disables and re-enables a module", async () => {
    const off = await api("/api/modules", {
      method: "POST",
      body: JSON.stringify({ moduleId: NEURO_PREPROCESS_MODULE_ID, enabled: false }),
    });
    expect(off.status).toBe(200);
    expect(off.data.enabled).toBe(false);

    const list = await api("/api/modules");
    const mod = list.data.modules.find((m: { id: string }) => m.id === NEURO_PREPROCESS_MODULE_ID);
    expect(mod?.enabled).toBe(false);

    const on = await api("/api/modules", {
      method: "POST",
      body: JSON.stringify({ moduleId: NEURO_PREPROCESS_MODULE_ID, enabled: true }),
    });
    expect(on.status).toBe(200);
    expect(on.data.enabled).toBe(true);
  });

  it("rejects unknown module ids", async () => {
    const { status } = await api("/api/modules", {
      method: "POST",
      body: JSON.stringify({ moduleId: "@rector/unknown", enabled: false }),
    });
    expect(status).toBe(404);
  });
});