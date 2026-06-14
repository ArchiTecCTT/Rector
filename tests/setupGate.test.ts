import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import http from "node:http";

import { createApp } from "../src/api/server";
import { TaskManager } from "../src/thalamus/router";
import { createInMemoryRuntimeSettingsStore, defaultRuntimeSettings } from "../src/config/runtimeSettings";
import { SpyLLMProvider, DEFAULT_SPY_USAGE } from "./support/byokArbitraries";
import type { ModelRouter } from "../src/providers/llm";
import { createConfiguredProductStores } from "./support/configuredProductHarness";

function spyRouter(provider: SpyLLMProvider): ModelRouter {
  return {
    select: () => ({
      provider,
      modelRoute: "flagship",
      model: provider.metadata.models.flagship,
      reason: "setup-gate-test",
    }),
  };
}

describe("chat setup gate", () => {
  let unconfiguredServer: http.Server;
  let unconfiguredBase: string;
  let configuredServer: http.Server;
  let configuredBase: string;

  beforeAll(async () => {
    const unconfiguredApp = createApp(new TaskManager(), {
      runtimeSettingsStore: createInMemoryRuntimeSettingsStore(defaultRuntimeSettings()),
    });
    unconfiguredServer = await new Promise<http.Server>((resolve) => {
      const server = unconfiguredApp.listen(0, () => resolve(server));
    });
    const unconfiguredAddr = unconfiguredServer.address();
    const unconfiguredPort = typeof unconfiguredAddr === "object" && unconfiguredAddr ? unconfiguredAddr.port : 3000;
    unconfiguredBase = `http://127.0.0.1:${unconfiguredPort}`;

    const stores = await createConfiguredProductStores();
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [{ content: "configured-path-ok" }],
    });
    const configuredApp = createApp(new TaskManager(), {
      ...stores,
      orchestration: { mode: "external", router: spyRouter(provider) },
    });
    configuredServer = await new Promise<http.Server>((resolve) => {
      const server = configuredApp.listen(0, () => resolve(server));
    });
    const configuredAddr = configuredServer.address();
    const configuredPort = typeof configuredAddr === "object" && configuredAddr ? configuredAddr.port : 3001;
    configuredBase = `http://127.0.0.1:${configuredPort}`;
  });

  afterAll(async () => {
    await Promise.all([
      new Promise<void>((resolve, reject) => unconfiguredServer.close((err) => (err ? reject(err) : resolve()))),
      new Promise<void>((resolve, reject) => configuredServer.close((err) => (err ? reject(err) : resolve()))),
    ]);
  });

  async function api(base: string, path: string, init: RequestInit = {}) {
    const res = await fetch(`${base}${path}`, {
      headers: { "Content-Type": "application/json", ...(init.headers as Record<string, string> | undefined) },
      ...init,
    });
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : {} };
  }

  it("returns 409 SETUP_REQUIRED when the product is unconfigured", async () => {
    const created = await api(unconfiguredBase, "/api/chat/conversations", {
      method: "POST",
      body: JSON.stringify({ title: "Gate test" }),
    });

    expect(created.status).toBe(409);
    expect(created.data.code).toBe("SETUP_REQUIRED");
    expect(created.data.setupUrl).toBe("/setup");
    expect(Array.isArray(created.data.blockers)).toBe(true);
    expect(created.data.blockers.length).toBeGreaterThan(0);
  });

  it("allows chat when configured readiness passes with a spy router", async () => {
    const created = await api(configuredBase, "/api/chat/conversations", {
      method: "POST",
      body: JSON.stringify({ title: "Configured gate test" }),
    });
    expect(created.status).toBe(201);

    const sent = await api(configuredBase, `/api/chat/conversations/${created.data.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "hello configured product" }),
    });

    expect(sent.status).toBe(201);
    expect(sent.data.assistantMessage?.role).toBe("assistant");
  });
});