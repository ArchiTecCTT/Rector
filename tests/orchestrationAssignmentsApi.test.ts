import { afterAll, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";

import { createApp } from "../src/api/server";
import { TaskManager } from "../src/thalamus/router";
import { createInMemoryProviderConfigStore } from "../src/providers/configStore";
import { createInMemoryOrchestrationAssignmentStore } from "../src/providers/orchestrationAssignments";
import type { ProviderConfigState } from "../src/providers/config";
import type { SecretStore } from "../src/security/secretStore";

const NOW = "2026-06-12T00:00:00.000Z";
const SECRET = "sk-orchestration-api-secret-123456";

function providerState(): ProviderConfigState {
  return {
    version: 1,
    activeRoutes: {},
    providers: [
      {
        id: "cloudflare",
        kind: "cloudflare",
        label: "Cloudflare Workers AI",
        model: "@cf/meta/llama-3.1-8b-instruct",
        cloudflare: { accountId: "acct" },
        secretRef: "cloudflare",
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: "openai-compatible:main",
        kind: "openai-compatible",
        label: "OpenAI compatible",
        baseUrl: "https://llm.example.test/v1",
        model: "gpt-json",
        manualModels: ["gpt-json", "gpt-prose"],
        secretRef: "openai-compatible:main",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
  };
}

function secretStore(): SecretStore {
  return {
    async setSecret() {
      return { ok: true, value: undefined };
    },
    async getSecret() {
      return { ok: true, value: SECRET };
    },
    async hasSecret() {
      return true;
    },
    async deleteSecret() {
      return { ok: true, value: undefined };
    },
  };
}

interface Harness {
  server: http.Server;
  base: string;
}

async function startHarness(): Promise<Harness> {
  const app = createApp(new TaskManager(), {
    secretStore: secretStore(),
    providerConfigStore: createInMemoryProviderConfigStore(providerState()),
    orchestrationAssignmentStore: createInMemoryOrchestrationAssignmentStore(),
  });
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 3000;
  return { server, base: `http://127.0.0.1:${port}` };
}

async function stopHarness(harness: Harness): Promise<void> {
  await new Promise<void>((resolve, reject) => harness.server.close((err) => (err ? reject(err) : resolve())));
}

async function api(base: string, path: string, init: RequestInit = {}): Promise<{ status: number; data: any; text: string }> {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: { "Content-Type": "application/json", ...(init.headers as Record<string, string> | undefined) },
    body: init.body,
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : {}, text };
}

describe("Orchestration_Model_Assignment_API", () => {
  let harness: Harness;

  beforeEach(async () => {
    if (harness) await stopHarness(harness);
    harness = await startHarness();
  });

  afterAll(async () => {
    if (harness) await stopHarness(harness);
  });

  it("lists roles, sanitized providers, and deterministic effective defaults", async () => {
    const res = await api(harness.base, "/api/orchestration-models/effective");
    expect(res.status).toBe(200);
    expect(res.data.roles.map((role: any) => role.id)).toContain("planner");
    expect(res.data.providers.map((provider: any) => provider.id)).toEqual(["cloudflare", "openai-compatible:main"]);
    expect(res.data.effective.find((route: any) => route.role === "planner").providerId).toBe("deterministic");
    expect(res.text).not.toContain(SECRET);
    expect(res.text).not.toContain("secretRef");
  });

  it("roundtrips a role assignment and returns capability warnings", async () => {
    const put = await api(harness.base, "/api/orchestration-models/assignments/planner", {
      method: "PUT",
      body: JSON.stringify({
        providerId: "openai-compatible:main",
        modelId: "gpt-json",
        fallbackProviderId: "deterministic",
        maxUsdPerCall: 0.5,
        maxTokens: 4096,
      }),
    });
    expect(put.status).toBe(200);
    expect(put.data.assignment.role).toBe("planner");
    expect(put.data.assignment.providerId).toBe("openai-compatible:main");
    expect(put.text).not.toContain(SECRET);
    expect(put.text).not.toContain("secretRef");

    const listed = await api(harness.base, "/api/orchestration-models/assignments");
    expect(listed.status).toBe(200);
    expect(listed.data.assignments).toHaveLength(1);
    const planner = listed.data.effective.find((route: any) => route.role === "planner");
    expect(planner.providerId).toBe("openai-compatible:main");
    expect(planner.modelId).toBe("gpt-json");
  });

  it("rejects JSON-required roles assigned to a model with no JSON mode and no repair fallback", async () => {
    const res = await api(harness.base, "/api/orchestration-models/assignments/preprocessor", {
      method: "PUT",
      body: JSON.stringify({ providerId: "cloudflare" }),
    });
    expect(res.status).toBe(400);
    expect(res.data.error).toContain("capabilities");
    expect(res.data.warnings.some((warning: any) => warning.code === "json_mode_missing" && warning.severity === "blocker")).toBe(true);
  });

  it("tests deterministic assignments without network", async () => {
    const res = await api(harness.base, "/api/orchestration-models/assignments/directAnswer/test", {
      method: "POST",
      body: JSON.stringify({ providerId: "deterministic" }),
    });
    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(true);
    expect(res.data.providerId).toBe("deterministic");
    expect(res.data.networkAttempted).toBe(false);
  });

  it("resets saved assignments to deterministic local defaults", async () => {
    await api(harness.base, "/api/orchestration-models/assignments/planner", {
      method: "PUT",
      body: JSON.stringify({ providerId: "openai-compatible:main", fallbackProviderId: "deterministic" }),
    });

    const reset = await api(harness.base, "/api/orchestration-models/assignments/reset", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(reset.status).toBe(200);
    expect(reset.data.assignments).toEqual([]);
    expect(reset.data.effective.find((route: any) => route.role === "planner").providerId).toBe("deterministic");
  });
});
