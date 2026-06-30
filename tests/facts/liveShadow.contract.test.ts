import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  LIVE_FACT_SHADOW_REPORT_SCHEMA_VERSION,
  LiveFactShadowReportSchema,
  discoverLiveFactProviders,
  isAcceptableLiveShadowProvider,
  runLiveFactShadow,
} from "../../scripts/facts/run-live-fact-shadow";
import {
  FakeLLMProvider,
  LLMResponseSchema,
  LLMUsageSchema,
  ProviderCapabilityMetadataSchema,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  type LLMUsage,
} from "../../src/providers/llm";
import { SpyLLMProvider } from "../support/byokArbitraries";

const USAGE: LLMUsage = LLMUsageSchema.parse({ inputTokens: 50, outputTokens: 25, totalTokens: 75, estimatedUsd: 0.000075, modelCalls: 1 });

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "rector-live-fact-shadow-"));
}

class ContractLiveProvider implements LLMProvider {
  readonly metadata = ProviderCapabilityMetadataSchema.parse({
    id: "contract-live-provider",
    displayName: "Contract Live Provider",
    routes: ["fast", "flagship"],
    models: { fast: "contract-live-model", flagship: "contract-live-model" },
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
    return LLMResponseSchema.parse({
      provider: this.metadata.id,
      model: request.model ?? this.metadata.models.fast,
      content: JSON.stringify(responseForCase(String(request.metadata?.caseId ?? "unknown"))),
      finishReason: "stop",
      usage: USAGE,
    });
  }
}

class SpyNamedProvider extends ContractLiveProvider {
  override readonly metadata = ProviderCapabilityMetadataSchema.parse({
    id: "spy",
    displayName: "Spy Provider",
    routes: ["fast"],
    models: { fast: "spy-model" },
    supportsJson: true,
    supportsStreaming: false,
    maxContextTokens: 16_000,
    estimatedUsdPer1kInputTokens: 0,
    estimatedUsdPer1kOutputTokens: 0,
  });
}

describe("Phase 2F live fact shadow contract", () => {
  it("is opt-in and writes an honest skipped report when LIVE_FACT_EVALS is absent", async () => {
    const outputDir = await tempDir();
    try {
      const report = await runLiveFactShadow({ outputDir, env: {}, now: fixedNow });
      expect(report.status).toBe("skipped");
      expect(report.liveEvidenceStatus).toBe("skipped");
      expect(report.skippedReason).toContain("LIVE_FACT_EVALS");
      expect(report.skippedCount).toBeGreaterThanOrEqual(5);
      const written = LiveFactShadowReportSchema.parse(JSON.parse(await readFile(path.join(outputDir, "live-fact-shadow-report.json"), "utf8")));
      expect(written.schemaVersion).toBe(LIVE_FACT_SHADOW_REPORT_SCHEMA_VERSION);
      expect(await readFile(path.join(outputDir, "live-fact-shadow-report.md"), "utf8")).toContain("honest skipped report");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("skips successfully with LIVE_FACT_EVALS=1 when no provider credentials/config are available", async () => {
    const outputDir = await tempDir();
    try {
      const report = await runLiveFactShadow({ outputDir, env: { LIVE_FACT_EVALS: "1" }, now: fixedNow });
      expect(report.status).toBe("skipped");
      expect(report.skippedReason).toContain("No configured non-fake live provider");
      expect(report.failedCount).toBe(0);
      expect(report.cases.every((caseReport) => caseReport.status === "skipped")).toBe(true);
      const markdown = await readFile(path.join(outputDir, "live-fact-shadow-report.md"), "utf8");
      expect(markdown).toContain("No case failures recorded.");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("uses shared Z.ai live discovery when RECTOR_LIVE_PROVIDER requests Z.ai", async () => {
    const discovered = await discoverLiveFactProviders({
      RECTOR_LIVE_PROVIDER: "zai",
      OPENAI_COMPATIBLE_API_KEY: "sk-zai-secret-1234567890",
      OPENAI_COMPATIBLE_BASE_URL: "https://api.z.ai/api/paas/v4",
      OPENAI_COMPATIBLE_MODEL: "glm-4.5",
    });

    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({
      providerId: "zai:env",
      modelId: "glm-4.5",
      route: "cheap",
      liveEvidence: true,
    });
  });

  it("rejects a requested Z.ai live shadow provider when the OpenAI-compatible host is not Z.ai", async () => {
    const discovered = await discoverLiveFactProviders({
      RECTOR_LIVE_PROVIDER: "zai",
      OPENAI_COMPATIBLE_API_KEY: "sk-zai-secret-1234567890",
      OPENAI_COMPATIBLE_BASE_URL: "https://example.com/v1/private",
      OPENAI_COMPATIBLE_MODEL: "glm-4.5",
    });

    expect(discovered).toEqual([]);
  });

  it("rejects FakeLLMProvider and SpyLLMProvider-shaped doubles as live evidence", async () => {
    expect(isAcceptableLiveShadowProvider(new FakeLLMProvider())).toBe(false);
    expect(isAcceptableLiveShadowProvider(new SpyLLMProvider())).toBe(false);
    expect(isAcceptableLiveShadowProvider(new SpyNamedProvider())).toBe(false);

    const outputDir = await tempDir();
    try {
      const report = await runLiveFactShadow({
        outputDir,
        env: { LIVE_FACT_EVALS: "1" },
        now: fixedNow,
        providerDiscovery: () => [{ provider: new SpyNamedProvider(), liveEvidence: false, discoveryLabel: "test-only spy" }],
      });
      expect(report.status).toBe("skipped");
      expect(report.skippedReason).toContain("No configured non-fake live provider");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("never labels dependency-injected discovery as live_provider even if liveEvidence is true", async () => {
    const outputDir = await tempDir();
    const provider = new ContractLiveProvider();
    try {
      const report = await runLiveFactShadow({
        outputDir,
        env: { LIVE_FACT_EVALS: "1" },
        now: fixedNow,
        providerDiscovery: () => [{ provider, route: "fast", modelId: "contract-live-model", liveEvidence: true, discoveryLabel: "mislabeled injection" }],
      });
      expect(report.liveEvidenceStatus).toBe("test_only_injected");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("validates deterministic injected provider outputs without counting them as live verification", async () => {
    const outputDir = await tempDir();
    const provider = new ContractLiveProvider();
    try {
      const report = await runLiveFactShadow({
        outputDir,
        env: { LIVE_FACT_EVALS: "1" },
        now: fixedNow,
        providerDiscovery: () => [{ provider, route: "fast", modelId: "contract-live-model", liveEvidence: false, discoveryLabel: "contract test injection" }],
      });

      expect(report.status).toBe("completed");
      expect(report.liveEvidenceStatus).toBe("test_only_injected");
      expect(report.caseCount).toBe(5);
      expect(report.failedCount).toBe(0);
      expect(report.cases.map((caseReport) => caseReport.caseId)).toEqual([
        "intent_extraction_stress",
        "rg_artifact_evidence_extraction",
        "test_log_diagnosis",
        "tsc_diagnostic_grouping",
        "insufficient_evidence",
      ]);
      expect(report.cases.every((caseReport) => caseReport.schemaValidity)).toBe(true);
      expect(report.cases.every((caseReport) => caseReport.provenanceCompleteness)).toBe(true);
      expect(report.cases.every((caseReport) => caseReport.hallucinatedRefs.length === 0)).toBe(true);
      expect(report.cases.find((caseReport) => caseReport.caseId === "insufficient_evidence")?.insufficientEvidenceCorrect).toBe(true);
      expect(provider.requests).toHaveLength(5);
      expect(provider.requests.every((request) => request.metadata?.nonMutating === true)).toBe(true);
      const markdown = await readFile(path.join(outputDir, "live-fact-shadow-report.md"), "utf8");
      expect(markdown).toContain("test_only_injected");
      expect(markdown).not.toContain("Partial incident note only");
      const summary = JSON.parse(await readFile(path.join(outputDir, "live-fact-shadow-summary.json"), "utf8"));
      expect(summary.reportJson).toBe("live-fact-shadow-report.json");
      expect(summary.totalTokenUsage.totalTokens).toBe(375);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("redacts response content before writing raw shadow artifacts", async () => {
    const outputDir = await tempDir();

    class SecretEchoProvider extends ContractLiveProvider {
      override async invoke(request: LLMRequest): Promise<LLMResponse> {
        this.requests.push(request);
        return LLMResponseSchema.parse({
          provider: this.metadata.id,
          model: request.model ?? this.metadata.models.fast,
          content: JSON.stringify({
            facts: [
              {
                kind: "capability_failure",
                capabilityId: "live_shadow.secret",
                reason: "api_key=sk-test-secret1234567890 leaked by model",
                retryable: false,
                evidence: [
                  {
                    refType: "insufficient_evidence",
                    reason: "api_key=sk-test-secret1234567890",
                    missing: ["safe artifact"],
                    searched: [],
                  },
                ],
              },
            ],
          }),
          finishReason: "stop",
          usage: USAGE,
        });
      }
    }

    try {
      await runLiveFactShadow({
        outputDir,
        env: { LIVE_FACT_EVALS: "1" },
        now: fixedNow,
        providerDiscovery: () => [
          {
            provider: new SecretEchoProvider(),
            route: "fast",
            modelId: "contract-live-model",
            liveEvidence: false,
            discoveryLabel: "contract test injection",
          },
        ],
      });

      const artifact = await readFile(
        path.join(outputDir, "live-fact-shadow-artifacts", "intent_extraction_stress.json"),
        "utf8",
      );
      expect(artifact).not.toContain("sk-test-secret1234567890");
      expect(artifact).toContain("[REDACTED]");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("does not mutate source files while writing only evidence reports", async () => {
    const outputDir = await tempDir();
    const sourcePath = path.join(process.cwd(), "src/facts/schemas.ts");
    const before = await readFile(sourcePath, "utf8");
    try {
      await runLiveFactShadow({ outputDir, env: { LIVE_FACT_EVALS: "1" }, now: fixedNow });
      const after = await readFile(sourcePath, "utf8");
      expect(after).toBe(before);
      expect(await readFile(path.join(outputDir, "live-fact-shadow-report.json"), "utf8")).toContain("skipped");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});

function fixedNow(): Date {
  return new Date("2026-06-28T00:00:00.000Z");
}

function responseForCase(caseId: string): unknown {
  if (caseId === "intent_extraction_stress") {
    return {
      facts: [
        { kind: "intent", intent: "Make Rector less flaky around provider behavior without changing billing or memory", confidence: 0.74 },
        { kind: "task_constraint", constraint: "Do not touch billing or memory" },
        { kind: "unknown_or_ambiguity", question: "Which provider failure mode is in scope?", options: ["configuration", "runtime timeout", "routing"] },
      ],
    };
  }
  if (caseId === "rg_artifact_evidence_extraction") {
    return {
      facts: [
        { kind: "capability_evidence", capabilityId: "live_shadow.rg", summary: "Artifact references configured orchestration and runOrchestratedChatRun", evidence: [{ refType: "source_span", path: "src/notes.md", startLine: 1, endLine: 1 }] },
      ],
    };
  }
  if (caseId === "test_log_diagnosis") {
    return {
      facts: [
        { kind: "capability_failure", capabilityId: "live_shadow.vitest", reason: "The log says no test files matched, so the root failing assertion is unavailable", retryable: false, evidence: [{ refType: "insufficient_evidence", reason: "No actual failing test body or assertion appears in the fixture log", missing: ["failing test body", "assertion"], searched: ["vitest log"] }] },
      ],
    };
  }
  if (caseId === "tsc_diagnostic_grouping") {
    return {
      facts: [
        { kind: "capability_evidence", capabilityId: "live_shadow.tsc", summary: "Root candidate is RuntimeMode assignment of local at src/index.ts line 2", evidence: [{ refType: "source_span", path: "src/index.ts", startLine: 2, endLine: 2 }] },
        { kind: "capability_warning", capabilityId: "live_shadow.tsc", warning: "No fix is claimed because only the diagnostic artifact is available", severity: "medium" },
      ],
    };
  }
  return {
    facts: [
      { kind: "capability_failure", capabilityId: "live_shadow.insufficient", reason: "The artifact lacks a stack trace, file path, command, and test name", retryable: false, evidence: [{ refType: "insufficient_evidence", reason: "ambiguous partial incident note", missing: ["stack trace", "file path", "command", "test name"], searched: ["partial incident note"] }] },
    ],
  };
}
