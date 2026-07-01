import { describe, expect, it } from "vitest";

import { zaiHarnessScenarios } from "../../src/live/harnessScenarios";
import {
  HARNESS_PREFLIGHT_STRUCTURED_ROLES,
  estimateScenarioPreflight,
} from "../../src/live/liveHarnessPreflight";
import type { DiscoveredLiveProvider } from "../../src/live/liveProviderDiscovery";
import {
  ProviderCapabilityMetadataSchema,
  type LLMProvider,
  type LLMRequest,
  type LLMUsage,
} from "../../src/providers/llm";

const USAGE: LLMUsage = {
  inputTokens: 10,
  outputTokens: 5,
  totalTokens: 15,
  estimatedUsd: 0,
  modelCalls: 1,
};

describe("estimateScenarioPreflight", () => {
  it("reserves planner, skeptic, synthesizer, and one repair estimate", () => {
    const roles: string[] = [];
    const provider: LLMProvider = {
      metadata: ProviderCapabilityMetadataSchema.parse({
        id: "openai-compatible",
        displayName: "OpenAI-Compatible",
        routes: ["cheap"],
        models: { cheap: "glm-4.5-air" },
        supportsJson: true,
        supportsStreaming: false,
        maxContextTokens: 16_000,
        estimatedUsdPer1kInputTokens: 0.001,
        estimatedUsdPer1kOutputTokens: 0.001,
      }),
      validateConfig() {},
      estimateRequest(request: LLMRequest): LLMUsage {
        const role = request.metadata?.structuredRole;
        if (typeof role === "string") roles.push(role);
        return USAGE;
      },
      invoke() {
        throw new Error("not used");
      },
    };
    const selected: DiscoveredLiveProvider = {
      requestedProvider: "zai",
      provider,
      providerId: "zai:test",
      adapterId: "openai-compatible",
      displayName: "OpenAI-Compatible",
      modelId: "glm-4.5-air",
      route: "cheap",
      host: "api.example.com",
      source: "env",
      liveEvidence: false,
      discoveryLabel: "preflight-test",
    };
    const scenario = zaiHarnessScenarios()[0];
    const total = estimateScenarioPreflight(selected, scenario, { harnessId: "zai" });

    expect(roles).toEqual([...HARNESS_PREFLIGHT_STRUCTURED_ROLES]);
    expect(roles).toContain("repair");
    expect(total.totalTokens).toBe(USAGE.totalTokens * HARNESS_PREFLIGHT_STRUCTURED_ROLES.length);
  });
});