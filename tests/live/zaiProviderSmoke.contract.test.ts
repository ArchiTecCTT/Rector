import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ProviderCapabilityMetadataSchema,
  ProviderError,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  type LLMUsage,
} from "../../src/providers/llm";
import {
  runZaiProviderSmoke,
  ZAI_PROVIDER_SMOKE_REPORT_SCHEMA_VERSION,
  ZaiProviderSmokeReportSchema,
} from "../../src/live/zaiProviderSmokeReport";
import type { DiscoveredLiveProvider } from "../../src/live/liveProviderDiscovery";

const USAGE: LLMUsage = {
  inputTokens: 12,
  outputTokens: 8,
  totalTokens: 20,
  estimatedUsd: 0.00002,
  modelCalls: 1,
};

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "rector-zai-smoke-"));
}

class SmokeProvider implements LLMProvider {
  readonly metadata = ProviderCapabilityMetadataSchema.parse({
    id: "openai-compatible",
    displayName: "OpenAI-Compatible",
    routes: ["cheap", "fast"],
    models: { cheap: "glm-4.5-air", fast: "glm-4.5" },
    supportsJson: true,
    supportsStreaming: false,
    maxContextTokens: 16_000,
    estimatedUsdPer1kInputTokens: 0.001,
    estimatedUsdPer1kOutputTokens: 0.001,
  });

  readonly requests: LLMRequest[] = [];

  validateConfig(): void {
    return undefined;
  }

  estimateRequest(): LLMUsage {
    return USAGE;
  }

  async invoke(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push(request);
    return {
      provider: this.metadata.id,
      model: request.model ?? this.metadata.models.cheap,
      content: "{\"ok\":true,\"provider\":\"zai\"}",
      finishReason: "stop",
      usage: USAGE,
    };
  }
}

function discovered(provider: LLMProvider = new SmokeProvider()): DiscoveredLiveProvider {
  return {
    requestedProvider: "zai",
    provider,
    providerId: "zai:contract",
    adapterId: "openai-compatible",
    displayName: "OpenAI-Compatible",
    modelId: "glm-4.5-air",
    route: "cheap",
    host: "api.z.ai",
    source: "env",
    liveEvidence: false,
    discoveryLabel: "contract-test",
  };
}

describe("Z.ai provider smoke report", () => {
  it("is opt-in and writes an honest skipped report when the smoke flag is absent", async () => {
    const outputDir = await tempDir();
    const provider = new SmokeProvider();
    try {
      const report = await runZaiProviderSmoke({
        outputDir,
        env: { RECTOR_LIVE_PROVIDER: "zai" },
        now: fixedNow,
        providerDiscovery: async () => ({ selected: discovered(provider), rejections: [] }),
      });

      expect(report.status).toBe("skipped");
      expect(report.skippedReason).toContain("RECTOR_ZAI_PROVIDER_SMOKE");
      expect(provider.requests).toHaveLength(0);
      const written = ZaiProviderSmokeReportSchema.parse(JSON.parse(await readFile(path.join(outputDir, "provider-smoke.json"), "utf8")));
      expect(written.schemaVersion).toBe(ZAI_PROVIDER_SMOKE_REPORT_SCHEMA_VERSION);
      expect(await readFile(path.join(outputDir, "provider-smoke.md"), "utf8")).toContain("skipped");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("sends one cheap JSON-only chat completion and records sanitized live metrics", async () => {
    const outputDir = await tempDir();
    const provider = new SmokeProvider();
    try {
      const report = await runZaiProviderSmoke({
        outputDir,
        env: { RECTOR_LIVE_PROVIDER: "zai", RECTOR_ZAI_PROVIDER_SMOKE: "1" },
        now: fixedNow,
        providerDiscovery: async () => ({ selected: discovered(provider), rejections: [] }),
      });

      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]).toMatchObject({
        modelRoute: "cheap",
        model: "glm-4.5-air",
        maxOutputTokens: 64,
        temperature: 0,
        responseFormat: { type: "json_object" },
      });
      expect(report).toMatchObject({
        status: "passed",
        liveEvidenceStatus: "test_only_injected",
        providerId: "zai:contract",
        adapterId: "openai-compatible",
        modelId: "glm-4.5-air",
        host: "api.z.ai",
        tokenUsage: { totalTokens: 20, modelCalls: 1 },
        estimatedCostUsd: 0.00002,
      });
      expect(report.latencyMs).toBeGreaterThanOrEqual(0);
      const written = await readFile(path.join(outputDir, "provider-smoke.json"), "utf8");
      expect(written).not.toContain("Authorization");
      expect(written).not.toContain("api/paas/v4");
      expect(written).not.toContain("sk-zai");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("classifies provider configuration errors from discovery without claiming success", async () => {
    const outputDir = await tempDir();
    try {
      const report = await runZaiProviderSmoke({
        outputDir,
        env: { RECTOR_LIVE_PROVIDER: "zai", RECTOR_ZAI_PROVIDER_SMOKE: "1" },
        now: fixedNow,
        providerDiscovery: async () => ({
          selected: undefined,
          rejections: [{ provider: "zai", source: "env", reason: "zai_host_required", host: "example.com" }],
        }),
      });

      expect(report.status).toBe("failed");
      expect(report.error?.kind).toBe("provider_config");
      expect(report.error?.host).toBe("example.com");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("classifies HTTP provider errors", async () => {
    class HttpFailureProvider extends SmokeProvider {
      override async invoke(request: LLMRequest): Promise<LLMResponse> {
        this.requests.push(request);
        throw new ProviderError({
          code: "PROVIDER_HTTP_ERROR",
          provider: "openai-compatible",
          status: 401,
          retryable: false,
          message: "OpenAI-Compatible request failed with HTTP 401",
        });
      }
    }

    const outputDir = await tempDir();
    try {
      const report = await runZaiProviderSmoke({
        outputDir,
        env: { RECTOR_LIVE_PROVIDER: "zai", RECTOR_ZAI_PROVIDER_SMOKE: "1" },
        now: fixedNow,
        providerDiscovery: async () => ({ selected: discovered(new HttpFailureProvider()), rejections: [] }),
      });

      expect(report.status).toBe("failed");
      expect(report.error).toMatchObject({ kind: "provider_http", status: 401, retryable: false });
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("classifies timeout errors", async () => {
    class TimeoutProvider extends SmokeProvider {
      override async invoke(request: LLMRequest): Promise<LLMResponse> {
        this.requests.push(request);
        throw new ProviderError({
          code: "ABORTED",
          provider: "openai-compatible",
          message: "Provider request aborted",
        });
      }
    }

    const outputDir = await tempDir();
    try {
      const report = await runZaiProviderSmoke({
        outputDir,
        env: { RECTOR_LIVE_PROVIDER: "zai", RECTOR_ZAI_PROVIDER_SMOKE: "1" },
        now: fixedNow,
        providerDiscovery: async () => ({ selected: discovered(new TimeoutProvider()), rejections: [] }),
      });

      expect(report.status).toBe("failed");
      expect(report.error?.kind).toBe("provider_timeout");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("classifies non-JSON model content as a JSON error", async () => {
    class BadJsonProvider extends SmokeProvider {
      override async invoke(request: LLMRequest): Promise<LLMResponse> {
        this.requests.push(request);
        return {
          provider: this.metadata.id,
          model: request.model ?? this.metadata.models.cheap,
          content: "not json",
          finishReason: "stop",
          usage: USAGE,
        };
      }
    }

    const outputDir = await tempDir();
    try {
      const report = await runZaiProviderSmoke({
        outputDir,
        env: { RECTOR_LIVE_PROVIDER: "zai", RECTOR_ZAI_PROVIDER_SMOKE: "1" },
        now: fixedNow,
        providerDiscovery: async () => ({ selected: discovered(new BadJsonProvider()), rejections: [] }),
      });

      expect(report.status).toBe("failed");
      expect(report.error?.kind).toBe("provider_json");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});

function fixedNow(): Date {
  return new Date("2026-06-30T00:00:00.000Z");
}
