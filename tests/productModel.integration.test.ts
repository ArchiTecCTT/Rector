import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";

import { createApp } from "../src/api/server";
import { TaskManager } from "../src/thalamus/router";
import { createInMemoryRuntimeSettingsStore, defaultRuntimeSettings } from "../src/config/runtimeSettings";
import { createInMemoryProviderConfigStore } from "../src/providers/configStore";
import { createInMemoryOrchestrationAssignmentStore } from "../src/providers/orchestrationAssignments";
import { createInMemoryMemoryAssignmentStore } from "../src/providers/memoryAssignmentStore";
import { createInMemoryMemoryConfigStore } from "../src/providers/memoryConfigStore";
import { InMemoryRectorStore } from "../src/store/inMemoryRectorStore";
import { configuredSecretStore, seedRequiredOrchestrationAssignments } from "./support/configuredProductHarness";
import {
  SpyLLMProvider,
  DEFAULT_SPY_USAGE,
  makeContextPack,
  planToJson,
  skepticDraftToJson,
  synthesisDraftToJson,
} from "./support/byokArbitraries";
import { createFakePlan } from "../src/orchestration/planner";
import { triageUserMessage } from "../src/orchestration/triage";
import type { ModelRouter } from "../src/providers/llm";

function spyRouter(provider: SpyLLMProvider): ModelRouter {
  return {
    select: () => ({
      provider,
      modelRoute: "flagship",
      model: provider.metadata.models.flagship,
      reason: "product-model-integration-test",
    }),
  };
}

describe("Product Model Onboarding E2E Integration Flow", () => {
  let server: http.Server;
  let base: string;

  const rectorStore = new InMemoryRectorStore();
  const runtimeSettingsStore = createInMemoryRuntimeSettingsStore(defaultRuntimeSettings());
  const providerConfigStore = createInMemoryProviderConfigStore({ version: 1, activeRoutes: {}, providers: [] });
  const secretStore = configuredSecretStore({});
  const orchestrationAssignmentStore = createInMemoryOrchestrationAssignmentStore();
  const memoryAssignmentStore = createInMemoryMemoryAssignmentStore();
  const memoryConfigStore = createInMemoryMemoryConfigStore();

  const prompt = "hello success";
  const triage = triageUserMessage(prompt);
  const contextPack = makeContextPack(triage, prompt);

  const provider = new SpyLLMProvider({
    estimate: DEFAULT_SPY_USAGE,
    responses: [
      {
        content: JSON.stringify({
          distilledContext: prompt,
          proposedToolCalls: [],
          entities: [],
          intent: "Explain",
          constraints: [],
        }),
      },
      { content: planToJson(createFakePlan({ triage, contextPack, messageContent: prompt })) },
      { content: skepticDraftToJson({ verdict: "SOUND", findings: [] }) },
      {
        content: synthesisDraftToJson({
          response: "hello from spy provider",
          citations: [{ kind: "artifact", ref: "task:answer.synthesize", detail: "no-op execution node succeeded" }],
        }),
      },
    ],
  });

  beforeAll(async () => {
    const app = createApp(new TaskManager(), {
      store: rectorStore,
      runtimeSettingsStore,
      providerConfigStore,
      secretStore,
      orchestrationAssignmentStore,
      memoryAssignmentStore,
      memoryConfigStore,
      orchestration: { mode: "external", router: spyRouter(provider), preferInjectedRouter: true },
    });

    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 3000;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  async function api(path: string, init: RequestInit = {}) {
    const res = await fetch(`${base}${path}`, {
      headers: { "Content-Type": "application/json", ...(init.headers as Record<string, string> | undefined) },
      ...init,
    });
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : {} };
  }

  it("flows cleanly through unconfigured -> configured -> chat", async () => {
    // 1. GET /api/runtime-settings -> orchestrationProfile = "unconfigured"
    const settingsGet1 = await api("/api/runtime-settings");
    expect(settingsGet1.status).toBe(200);
    expect(settingsGet1.data.settings.orchestrationProfile).toBe("unconfigured");

    // 2. POST /api/chat/conversations -> 409 SETUP_REQUIRED
    const convPost1 = await api("/api/chat/conversations", {
      method: "POST",
      body: JSON.stringify({ title: "Fail Conv" }),
    });
    expect(convPost1.status).toBe(409);
    expect(convPost1.data.code).toBe("SETUP_REQUIRED");

    // 3. POST /api/chat/conversations/:id/messages -> 409 SETUP_REQUIRED
    // We create a conversation directly in the store to bypass the 404 check
    await rectorStore.createConversation({
      title: "Dummy conversation",
      workspaceId: "personal",
      retentionPolicy: "session",
    });

    const msgPost1 = await api("/api/chat/conversations/conv-1/messages", {
      method: "POST",
      body: JSON.stringify({ content: "hello fail" }),
    });
    expect(msgPost1.status).toBe(409);
    expect(msgPost1.data.code).toBe("SETUP_REQUIRED");

    // 4. POST /api/setup/activate -> 409 SETUP_INCOMPLETE (since we haven't configured provider/secret/assignments)
    const activatePost1 = await api("/api/setup/activate", {
      method: "POST",
    });
    expect(activatePost1.status).toBe(409);
    expect(activatePost1.data.code).toBe("SETUP_INCOMPLETE");

    // 5. Seed configurations in the stores to pass readiness checks
    await providerConfigStore.upsertProvider({
      id: "openai-compatible:main",
      kind: "openai-compatible",
      label: "OpenAI compatible",
      baseUrl: "https://llm.example.test/v1",
      model: "gpt-json",
      manualModels: ["gpt-json"],
      secretRef: "openai-compatible:main",
      createdAt: "2026-06-12T00:00:00.000Z",
      updatedAt: "2026-06-12T00:00:00.000Z",
    });
    await secretStore.setSecret("openai-compatible:main", "test-secret");
    await seedRequiredOrchestrationAssignments(orchestrationAssignmentStore, "openai-compatible:main", "gpt-json");

    // 6. POST /api/setup/activate -> 200 OK
    const activatePost2 = await api("/api/setup/activate", {
      method: "POST",
    });
    expect(activatePost2.status).toBe(200);
    expect(activatePost2.data.settings.orchestrationProfile).toBe("configured");

    // 7. GET /api/runtime-settings -> orchestrationProfile = "configured"
    const settingsGet2 = await api("/api/runtime-settings");
    expect(settingsGet2.status).toBe(200);
    expect(settingsGet2.data.settings.orchestrationProfile).toBe("configured");

    // 8. POST /api/chat/conversations -> 201 Created
    const convPost2 = await api("/api/chat/conversations", {
      method: "POST",
      body: JSON.stringify({ title: "Success Conv" }),
    });
    expect(convPost2.status).toBe(201);
    const conversationId = convPost2.data.id;
    expect(conversationId).toBeDefined();

    // 9. POST /api/chat/conversations/:id/messages -> 201 Created (SpyLLMProvider response)
    const msgPost2 = await api(`/api/chat/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "hello success" }),
    });
    expect(msgPost2.status).toBe(201);
    expect(msgPost2.data.assistantMessage.role).toBe("assistant");
    expect(msgPost2.data.assistantMessage.content).toContain("hello from spy provider");
  });
});
