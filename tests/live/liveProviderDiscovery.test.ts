import { describe, expect, it } from "vitest";

import { defaultRuntimeSettings, createInMemoryRuntimeSettingsStore } from "../../src/config/runtimeSettings";
import {
  PROVIDER_CONFIG_VERSION,
  type ProviderConfigState,
} from "../../src/providers/config";
import { createInMemoryProviderConfigStore } from "../../src/providers/configStore";
import {
  FakeLLMProvider,
  ProviderCapabilityMetadataSchema,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  type LLMUsage,
} from "../../src/providers/llm";
import type { SecretStore } from "../../src/security/secretStore";
import {
  discoverLiveProvider,
  isAcceptableLiveEvidenceProvider,
  isZaiCompatibleHost,
} from "../../src/live/liveProviderDiscovery";
import { SpyLLMProvider } from "../support/byokArbitraries";

const GENERATED_AT = "2026-06-30T00:00:00.000Z";
const SECRET = "sk-zai-secret-1234567890";

class ContractProvider implements LLMProvider {
  readonly metadata = ProviderCapabilityMetadataSchema.parse({
    id: "contract-live-provider",
    displayName: "Contract Live Provider",
    routes: ["cheap", "fast"],
    models: { cheap: "contract-model", fast: "contract-model" },
    supportsJson: true,
    supportsStreaming: false,
    maxContextTokens: 16_000,
    estimatedUsdPer1kInputTokens: 0.001,
    estimatedUsdPer1kOutputTokens: 0.001,
  });

  validateConfig(): void {
    return undefined;
  }

  estimateRequest(): LLMUsage {
    return { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedUsd: 0.000002, modelCalls: 1 };
  }

  async invoke(request: LLMRequest): Promise<LLMResponse> {
    return {
      provider: this.metadata.id,
      model: request.model ?? this.metadata.models.cheap,
      content: "{\"ok\":true}",
      finishReason: "stop",
      usage: this.estimateRequest(),
    };
  }
}

class ScriptedFixtureProvider extends ContractProvider {}

describe("live provider discovery", () => {
  it("does not select a provider when Z.ai is not explicitly requested", async () => {
    const result = await discoverLiveProvider({
      env: {
        OPENAI_COMPATIBLE_API_KEY: SECRET,
        OPENAI_COMPATIBLE_BASE_URL: "https://api.z.ai/api/paas/v4",
        OPENAI_COMPATIBLE_MODEL: "glm-4.5",
      },
    });

    expect(result.selected).toBeUndefined();
    expect(result.rejections).toEqual([]);
  });

  it("selects explicit Z.ai env configuration as an OpenAI-compatible live provider and records host only", async () => {
    const result = await discoverLiveProvider({
      env: {
        RECTOR_LIVE_PROVIDER: "zai",
        OPENAI_COMPATIBLE_API_KEY: SECRET,
        OPENAI_COMPATIBLE_BASE_URL: "https://api.z.ai/api/paas/v4",
        OPENAI_COMPATIBLE_MODEL: "glm-4.5",
      },
    });

    expect(result.selected).toMatchObject({
      requestedProvider: "zai",
      providerId: "zai:env",
      adapterId: "openai-compatible",
      modelId: "glm-4.5",
      host: "api.z.ai",
      source: "env",
      liveEvidence: true,
    });
    expect(result.selected?.provider.metadata.id).toBe("openai-compatible");
    expect(JSON.stringify({ host: result.selected?.host })).not.toContain("/api/paas/v4");
    expect(JSON.stringify({ host: result.selected?.host })).not.toContain(SECRET);
  });

  it("rejects Z.ai claims whose OpenAI-compatible base URL is not a Z.ai host without echoing secrets or URL paths", async () => {
    const result = await discoverLiveProvider({
      env: {
        RECTOR_LIVE_PROVIDER: "zai",
        OPENAI_COMPATIBLE_API_KEY: SECRET,
        OPENAI_COMPATIBLE_BASE_URL: "https://example.com/secret/path",
        OPENAI_COMPATIBLE_MODEL: "glm-4.5",
      },
    });

    expect(result.selected).toBeUndefined();
    expect(result.rejections).toHaveLength(1);
    expect(result.rejections[0]).toMatchObject({
      provider: "zai",
      reason: "zai_host_required",
      host: "example.com",
    });
    const serialized = JSON.stringify(result.rejections);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("/secret/path");
  });

  it("selects a configured-product Z.ai OpenAI-compatible provider when runtime settings are configured", async () => {
    const state: ProviderConfigState = {
      version: PROVIDER_CONFIG_VERSION,
      activeRoutes: { slm: "openai-compatible:zai" },
      providers: [
        {
          id: "openai-compatible:zai",
          kind: "openai-compatible",
          label: "Z.ai",
          baseUrl: "https://api.z.ai/api/paas/v4",
          model: "glm-4.5",
          secretRef: "secret:zai",
          createdAt: GENERATED_AT,
          updatedAt: GENERATED_AT,
        },
      ],
    };
    const runtimeSettingsStore = createInMemoryRuntimeSettingsStore({
      ...defaultRuntimeSettings(GENERATED_AT),
      orchestrationProfile: "configured",
      updatedAt: GENERATED_AT,
    });
    const secretStore: SecretStore = {
      async setSecret() {
        return { ok: true, value: undefined };
      },
      async getSecret(secretRef: string) {
        return secretRef === "secret:zai"
          ? { ok: true, value: SECRET }
          : { ok: false, error: "missing" };
      },
      async hasSecret(secretRef: string) {
        return secretRef === "secret:zai";
      },
    };

    const result = await discoverLiveProvider({
      env: { RECTOR_LIVE_PROVIDER: "zai" },
      runtimeSettingsStore,
      providerConfigStore: createInMemoryProviderConfigStore(state),
      secretStore,
    });

    expect(result.selected).toMatchObject({
      requestedProvider: "zai",
      providerId: "openai-compatible:zai",
      adapterId: "openai-compatible",
      host: "api.z.ai",
      modelId: "glm-4.5",
      source: "runtime-settings",
      liveEvidence: true,
    });
  });

  it("rejects fake, deterministic, spy, mock, fixture, scripted, and test-double provider identities", () => {
    expect(isAcceptableLiveEvidenceProvider({ provider: new FakeLLMProvider() })).toBe(false);
    expect(isAcceptableLiveEvidenceProvider({ provider: new SpyLLMProvider() })).toBe(false);
    expect(isAcceptableLiveEvidenceProvider({ provider: new ScriptedFixtureProvider() })).toBe(false);
    expect(isAcceptableLiveEvidenceProvider({
      provider: new ContractProvider(),
      reportMetadata: { source: "test-double contract" },
    })).toBe(false);
    expect(isAcceptableLiveEvidenceProvider({ provider: new ContractProvider() })).toBe(true);
  });

  it("matches only Z.ai-compatible hosts", () => {
    expect(isZaiCompatibleHost("api.z.ai")).toBe(true);
    expect(isZaiCompatibleHost("gateway.z.ai")).toBe(true);
    expect(isZaiCompatibleHost("evilz.ai")).toBe(false);
    expect(isZaiCompatibleHost("example.com")).toBe(false);
  });
});
