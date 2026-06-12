import { describe, expect, it, beforeEach } from "vitest";

import { createProviderPanelHarness, jsonResponse, type ProviderPanelHarness } from "./support/providerPanelHarness";

type AnyEl = any;

async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function samplePayload() {
  return {
    roles: [
      {
        id: "planner",
        label: "Planner",
        description: "Produces plans",
        modelRoute: "flagship",
        requiredCapabilities: ["text", "jsonMode"],
        preferredCapabilities: ["reasoning"],
        optional: false,
      },
      {
        id: "directAnswer",
        label: "Direct answer",
        description: "Answers simple questions",
        modelRoute: "cheap",
        requiredCapabilities: ["text"],
        preferredCapabilities: ["low-cost"],
        optional: false,
      },
    ],
    providers: [
      {
        id: "openai-compatible:main",
        label: "OpenAI compatible",
        kind: "openai-compatible",
        models: [
          { id: "gpt-json", label: "gpt-json", capabilities: { text: true, jsonMode: true } },
          { id: "gpt-prose", label: "gpt-prose", capabilities: { text: true, jsonMode: true } },
        ],
        capabilities: { text: true, jsonMode: true },
      },
    ],
    assignments: [
      {
        id: "default:default:planner",
        role: "planner",
        providerId: "openai-compatible:main",
        modelId: "gpt-json",
        fallbackProviderId: "deterministic",
        enabled: true,
        maxUsdPerCall: 0.25,
        maxTokens: 4096,
        createdAt: "2026-06-12T00:00:00.000Z",
        updatedAt: "2026-06-12T00:00:00.000Z",
      },
    ],
    effective: [
      {
        role: "planner",
        providerId: "openai-compatible:main",
        modelId: "gpt-json",
        modelRoute: "flagship",
        fallbackProviderId: "deterministic",
        enabled: true,
        source: "assignment",
        capabilities: { text: true, jsonMode: true },
        warnings: [],
        budgetProjection: { maxUsdPerCall: 0.25, maxTokens: 4096, estimatedUsdPerCall: 0.01 },
      },
      {
        role: "directAnswer",
        providerId: "deterministic",
        modelRoute: "cheap",
        fallbackProviderId: "deterministic",
        enabled: true,
        source: "builtin-template",
        capabilities: { text: true, jsonMode: true, embeddings: true },
        warnings: [],
        budgetProjection: { estimatedUsdPerCall: 0 },
      },
    ],
  };
}

describe("Orchestration model assignment UI", () => {
  let harness: ProviderPanelHarness;

  beforeEach(() => {
    harness = createProviderPanelHarness();
  });

  it("renders role rows with provider/model/fallback controls and no secret fields", async () => {
    harness.setFetchHandler(async (url) => {
      expect(url).toBe("/api/orchestration-models/effective");
      return jsonResponse(samplePayload());
    });

    await harness.sandbox.loadOrchestrationModelConfig();

    const rows = harness.getEl("orchestration-model-rows");
    expect(rows.children).toHaveLength(2);
    const planner = rows.children.find((row: AnyEl) => row.dataset.role === "planner");
    expect(planner).toBeDefined();
    expect(planner.querySelector(".orchestration-model-provider").value).toBe("openai-compatible:main");
    expect(planner.querySelector(".orchestration-model-model").value).toBe("gpt-json");
    expect(planner.querySelector(".orchestration-model-fallback").value).toBe("deterministic");
    expect(planner.textContent).not.toContain("secretRef");
    expect(planner.textContent).not.toContain("apiKey");
  });

  it("builds a save body from the edited row and marks unsaved changes", async () => {
    harness.setFetchHandler(async () => jsonResponse(samplePayload()));
    await harness.sandbox.loadOrchestrationModelConfig();
    const row = harness.getEl("orchestration-model-rows").children[0];

    const provider = row.querySelector(".orchestration-model-provider");
    const model = row.querySelector(".orchestration-model-model");
    const dirty = row.querySelector(".orchestration-model-dirty");
    expect(dirty.hidden).toBe(true);

    provider.value = "deterministic";
    provider.dispatch("change");
    model.value = "deterministic-local";
    expect(dirty.hidden).toBe(false);

    const parsed = harness.sandbox.readOrchestrationModelRow(row);
    expect(parsed.role).toBe("planner");
    expect(parsed.body).toMatchObject({
      providerId: "deterministic",
      enabled: true,
      fallbackProviderId: "deterministic",
      modelId: "deterministic-local",
    });
    expect(JSON.stringify(parsed.body)).not.toContain("apiKey");
  });

  it("saves and tests through the orchestration assignment endpoints", async () => {
    let savedBody: any;
    let testedBody: any;
    harness.setFetchHandler(async (url, opts) => {
      if (url === "/api/orchestration-models/effective") return jsonResponse(samplePayload());
      if (url === "/api/orchestration-models/assignments/planner" && opts.method === "PUT") {
        savedBody = JSON.parse(opts.body);
        return jsonResponse({ assignment: { role: "planner", providerId: savedBody.providerId } });
      }
      if (url === "/api/orchestration-models/assignments/planner/test" && opts.method === "POST") {
        testedBody = JSON.parse(opts.body);
        return jsonResponse({ ok: true, providerId: testedBody.providerId, model: testedBody.modelId, networkAttempted: false });
      }
      return jsonResponse(samplePayload());
    });

    await harness.sandbox.loadOrchestrationModelConfig();
    const row = harness.getEl("orchestration-model-rows").children[0];

    await harness.sandbox.saveOrchestrationModelRow(row);
    await flush();
    expect(savedBody.providerId).toBe("openai-compatible:main");
    expect(savedBody.modelId).toBe("gpt-json");
    expect(savedBody.apiKey).toBeUndefined();

    await harness.sandbox.testOrchestrationModelRow(row);
    expect(testedBody.providerId).toBe("openai-compatible:main");
    expect(testedBody.apiKey).toBeUndefined();
    expect(harness.getEl("orchestration-model-status").textContent).toContain("planner route is ready");
  });
});
