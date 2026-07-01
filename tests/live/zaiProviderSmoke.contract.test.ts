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

  it("accepts additional keys when ok and provider match the smoke contract", async () => {
    class ExtraKeysProvider extends SmokeProvider {
      override async invoke(request: LLMRequest): Promise<LLMResponse> {
        this.requests.push(request);
        return {
          provider: this.metadata.id,
          model: request.model ?? this.metadata.models.cheap,
          content: "{\"ok\":true,\"provider\":\"zai\",\"trace\":\"contract\"}",
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
        providerDiscovery: async () => ({ selected: discovered(new ExtraKeysProvider()), rejections: [] }),
      });

      expect(report.status).toBe("passed");
      expect(report.passClassification).toBe("first_pass");
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
        passClassification: "first_pass",
        liveEvidenceStatus: "test_only_injected",
        providerId: "zai:contract",
        adapterId: "openai-compatible",
        modelId: "glm-4.5-air",
        host: "api.z.ai",
        tokenUsage: { totalTokens: 20, modelCalls: 1 },
        estimatedCostUsd: 0.00002,
      });
      expect(report.attempts).toHaveLength(1);
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

  it("classifies HTTP 429 as rate_limit", async () => {
    class RateLimitedProvider extends SmokeProvider {
      override async invoke(request: LLMRequest): Promise<LLMResponse> {
        this.requests.push(request);
        throw new ProviderError({
          code: "PROVIDER_HTTP_ERROR",
          provider: "openai-compatible",
          status: 429,
          retryable: true,
          message: "OpenAI-Compatible request failed with HTTP 429",
        });
      }
    }

    const outputDir = await tempDir();
    try {
      const report = await runZaiProviderSmoke({
        outputDir,
        env: { RECTOR_LIVE_PROVIDER: "zai", RECTOR_ZAI_PROVIDER_SMOKE: "1" },
        now: fixedNow,
        providerDiscovery: async () => ({ selected: discovered(new RateLimitedProvider()), rejections: [] }),
      });

      expect(report.status).toBe("failed");
      expect(report.error).toMatchObject({ kind: "rate_limit", taxonomy: "rate_limit", status: 429, retryable: true });
      expect(report.diagnostics.failureTaxonomy.rate_limit).toBe(1);
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

  it("classifies non-JSON model content as a JSON error after bounded repair", async () => {
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
    const provider = new BadJsonProvider();
    try {
      const report = await runZaiProviderSmoke({
        outputDir,
        env: { RECTOR_LIVE_PROVIDER: "zai", RECTOR_ZAI_PROVIDER_SMOKE: "1" },
        now: fixedNow,
        providerDiscovery: async () => ({ selected: discovered(provider), rejections: [] }),
      });

      expect(provider.requests).toHaveLength(2);
      expect(report.status).toBe("failed");
      expect(report.passClassification).toBe("failed_after_repair");
      expect(report.attempts).toHaveLength(2);
      expect(report.error?.kind).toBe("provider_json");
      expect(report.liveEvidenceStatus).toBe("test_only_injected");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("fails with failed_after_repair and provider_json when the model returns an empty object on every attempt", async () => {
    class EmptyObjectProvider extends SmokeProvider {
      override async invoke(request: LLMRequest): Promise<LLMResponse> {
        this.requests.push(request);
        return {
          provider: this.metadata.id,
          model: request.model ?? this.metadata.models.cheap,
          content: "{}",
          finishReason: "stop",
          usage: USAGE,
        };
      }
    }

    const outputDir = await tempDir();
    const provider = new EmptyObjectProvider();
    try {
      const report = await runZaiProviderSmoke({
        outputDir,
        env: { RECTOR_LIVE_PROVIDER: "zai", RECTOR_ZAI_PROVIDER_SMOKE: "1" },
        now: fixedNow,
        providerDiscovery: async () => ({ selected: discovered(provider), rejections: [] }),
      });

      expect(provider.requests).toHaveLength(2);
      expect(report.status).toBe("failed");
      expect(report.passClassification).toBe("failed_after_repair");
      expect(report.error?.kind).toBe("provider_json");
      expect(report.error?.message).toContain("required JSON contract");
      expect(report.attempts?.[1]?.safeDiagnostics.map((d) => d.code)).toEqual(
        expect.arrayContaining(["smoke_json_ok_missing", "smoke_json_provider_missing"]),
      );
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("fails with provider_json when parsed JSON is null, an array, or the wrong contract shape", async () => {
    const cases: ReadonlyArray<{ readonly label: string; readonly content: string; readonly expectedCodes: string[] }> = [
      { label: "null", content: "null", expectedCodes: ["smoke_json_not_object"] },
      { label: "array", content: "[]", expectedCodes: ["smoke_json_not_object"] },
      {
        label: "wrong provider",
        content: "{\"ok\":true,\"provider\":\"openai\"}",
        expectedCodes: ["smoke_json_provider_invalid"],
      },
    ];

    for (const testCase of cases) {
      class FixedShapeProvider extends SmokeProvider {
        override async invoke(request: LLMRequest): Promise<LLMResponse> {
          this.requests.push(request);
          return {
            provider: this.metadata.id,
            model: request.model ?? this.metadata.models.cheap,
            content: testCase.content,
            finishReason: "stop",
            usage: USAGE,
          };
        }
      }

      const outputDir = await tempDir();
      const provider = new FixedShapeProvider();
      try {
        const report = await runZaiProviderSmoke({
          outputDir,
          env: { RECTOR_LIVE_PROVIDER: "zai", RECTOR_ZAI_PROVIDER_SMOKE: "1" },
          now: fixedNow,
          providerDiscovery: async () => ({ selected: discovered(provider), rejections: [] }),
        });

        expect(report.status, testCase.label).toBe("failed");
        expect(report.passClassification, testCase.label).toBe("failed_after_repair");
        expect(report.error?.kind, testCase.label).toBe("provider_json");
        const lastAttempt = report.attempts?.[report.attempts.length - 1];
        for (const code of testCase.expectedCodes) {
          expect(lastAttempt?.safeDiagnostics.some((d) => d.code === code), `${testCase.label}:${code}`).toBe(true);
        }
      } finally {
        await rm(outputDir, { recursive: true, force: true });
      }
    }
  });

  it("passes with repair_pass when the first attempt violates the smoke contract and the repair attempt is valid", async () => {
    class ContractRepairProvider extends SmokeProvider {
      private calls = 0;

      override async invoke(request: LLMRequest): Promise<LLMResponse> {
        this.calls += 1;
        this.requests.push(request);
        const content = this.calls === 1 ? "{}" : "{\"ok\":true,\"provider\":\"zai\"}";
        return {
          provider: this.metadata.id,
          model: request.model ?? this.metadata.models.cheap,
          content,
          finishReason: "stop",
          usage: USAGE,
        };
      }
    }

    const outputDir = await tempDir();
    const provider = new ContractRepairProvider();
    try {
      const report = await runZaiProviderSmoke({
        outputDir,
        env: { RECTOR_LIVE_PROVIDER: "zai", RECTOR_ZAI_PROVIDER_SMOKE: "1" },
        now: fixedNow,
        providerDiscovery: async () => ({ selected: discovered(provider), rejections: [] }),
      });

      expect(provider.requests).toHaveLength(2);
      expect(report.status).toBe("passed");
      expect(report.passClassification).toBe("repair_pass");
      expect(report.attempts).toHaveLength(2);
      expect(report.attempts?.[0]?.safeDiagnostics.map((d) => d.code)).toEqual(
        expect.arrayContaining(["smoke_json_ok_missing", "smoke_json_provider_missing"]),
      );
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("passes with repair_pass when the first attempt is malformed JSON and the repair attempt is valid", async () => {
    class RepairOnSecondAttemptProvider extends SmokeProvider {
      private calls = 0;

      override async invoke(request: LLMRequest): Promise<LLMResponse> {
        this.calls += 1;
        this.requests.push(request);
        if (this.calls === 1) {
          return {
            provider: this.metadata.id,
            model: request.model ?? this.metadata.models.cheap,
            content: "not-json",
            finishReason: "stop",
            usage: USAGE,
          };
        }
        return {
          provider: this.metadata.id,
          model: request.model ?? this.metadata.models.cheap,
          content: "{\"ok\":true,\"provider\":\"zai\"}",
          finishReason: "stop",
          usage: USAGE,
        };
      }
    }

    const outputDir = await tempDir();
    const provider = new RepairOnSecondAttemptProvider();
    try {
      const report = await runZaiProviderSmoke({
        outputDir,
        env: { RECTOR_LIVE_PROVIDER: "zai", RECTOR_ZAI_PROVIDER_SMOKE: "1" },
        now: fixedNow,
        providerDiscovery: async () => ({ selected: discovered(provider), rejections: [] }),
      });

      expect(provider.requests).toHaveLength(2);
      expect(report.status).toBe("passed");
      expect(report.passClassification).toBe("repair_pass");
      expect(report.attempts).toHaveLength(2);
      expect(report.liveEvidenceStatus).toBe("test_only_injected");
      expect(report.tokenUsage.modelCalls).toBe(2);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});

function fixedNow(): Date {
  return new Date("2026-06-30T00:00:00.000Z");
}
