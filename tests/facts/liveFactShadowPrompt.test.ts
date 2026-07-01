import { describe, expect, it } from "vitest";

import {
  LIVE_FACT_SHADOW_ALLOWED_KINDS,
  buildLiveFactShadowScenarioGuidance,
  buildLiveFactShadowSystemContract,
} from "../../src/facts/liveFactShadowPrompt";
import {
  diagnosticsFromShadowCaseEvaluation,
  factValidationErrorToDiagnostic,
} from "../../src/facts/reports/liveFactShadowClassification";
import { repairHintForDiagnostic } from "../../src/orchestration/strictJsonRepairCards";
import { runLiveFactShadow, liveFactShadowScenarios } from "../../scripts/facts/run-live-fact-shadow";
import { LLMResponseSchema, ProviderCapabilityMetadataSchema, type LLMProvider, type LLMRequest, type LLMResponse } from "../../src/providers/llm";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("liveFactShadowPrompt contract", () => {
  it("lists only runner-accepted fact kinds in the system contract", () => {
    const contract = buildLiveFactShadowSystemContract();
    expect(contract).toContain(`ONLY allowed values for facts[].kind: ${LIVE_FACT_SHADOW_ALLOWED_KINDS.join(", ")}`);
    expect(contract).toContain("capability_evidence");
    expect(contract).toContain("source_span");
    expect(contract).not.toContain("cartographer_snapshot");
  });

  it("includes TypeScript diagnostic mapping guidance for tsc_diagnostic_grouping", () => {
    const guidance = buildLiveFactShadowScenarioGuidance({
      id: "tsc_diagnostic_grouping",
      expectedKinds: ["capability_evidence", "capability_warning"],
    });
    expect(guidance).toContain("capability_evidence");
    expect(guidance).toContain("capability_warning");
    expect(guidance).toContain("Never use kind diagnostic, root_cause, cascade");
  });
});

describe("live fact shadow invalid discriminator handling", () => {
  it("still fails validation for invented fact kinds (no schema relaxation)", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "rector-live-fact-shadow-prompt-"));
    const USAGE = { inputTokens: 10, outputTokens: 10, totalTokens: 20, estimatedUsd: 0, modelCalls: 1 };

    class InventedKindProvider implements LLMProvider {
      readonly metadata = ProviderCapabilityMetadataSchema.parse({
        id: "invented-kind-provider",
        displayName: "Invented Kind Provider",
        routes: ["fast"],
        models: { fast: "test-model" },
        supportsJson: true,
        supportsStreaming: false,
        maxContextTokens: 16_000,
        estimatedUsdPer1kInputTokens: 0,
        estimatedUsdPer1kOutputTokens: 0,
      });

      validateConfig(): void {
        return undefined;
      }

      estimateRequest() {
        return USAGE;
      }

      async invoke(request: LLMRequest): Promise<LLMResponse> {
        const caseId = String(request.metadata?.caseId ?? "");
        if (caseId === "tsc_diagnostic_grouping") {
          return LLMResponseSchema.parse({
            provider: this.metadata.id,
            model: "test-model",
            content: JSON.stringify({
              facts: [
                {
                  kind: "typescript_diagnostic",
                  capabilityId: "live_shadow.tsc",
                  summary: "root cause",
                  evidence: [{ refType: "source_span", path: "src/index.ts", startLine: 2, endLine: 2 }],
                },
              ],
            }),
            finishReason: "stop",
            usage: USAGE,
          });
        }
        return LLMResponseSchema.parse({
          provider: this.metadata.id,
          model: "test-model",
          content: JSON.stringify({ facts: [{ kind: "intent", intent: "ok" }] }),
          finishReason: "stop",
          usage: USAGE,
        });
      }
    }

    try {
      const report = await runLiveFactShadow({
        outputDir,
        env: { LIVE_FACT_EVALS: "1" },
        providerDiscovery: () => [
          {
            provider: new InventedKindProvider(),
            route: "fast",
            modelId: "test-model",
            liveEvidence: false,
            discoveryLabel: "prompt contract test",
          },
        ],
      });

      const tscCase = report.cases.find((entry) => entry.caseId === "tsc_diagnostic_grouping");
      expect(tscCase?.status).toBe("failed");
      expect(tscCase?.schemaValidity).toBe(false);
      expect(tscCase?.validationErrors.some((entry) => entry.code === "invalid_union_discriminator")).toBe(true);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("projects shadow allowed kinds into repair hints for invalid_union_discriminator", () => {
    const diagnostic = factValidationErrorToDiagnostic({
      code: "invalid_union_discriminator",
      message: "Invalid discriminator value",
      path: ["kind"],
      severity: "error",
    });
    const hint = repairHintForDiagnostic(diagnostic);
    expect(hint).toContain("capability_evidence");
    expect(hint).toContain("capability_warning");
    for (const kind of LIVE_FACT_SHADOW_ALLOWED_KINDS) {
      expect(hint).toContain(kind);
    }
  });

  it("includes tsc mapping language in shadow diagnostics repair cards path", () => {
    const evaluation = {
      facts: [],
      errors: [
        {
          code: "invalid_union_discriminator",
          message: "Invalid discriminator value",
          path: ["kind"],
          severity: "error" as const,
        },
      ],
      schemaValidity: false,
      provenanceCompleteness: false,
      hallucinatedRefs: [],
      insufficientEvidenceCorrect: null,
    };
    const diagnostics = diagnosticsFromShadowCaseEvaluation(evaluation);
    const discriminator = diagnostics.find((entry) => entry.code === "invalid_union_discriminator");
    expect(discriminator).toBeDefined();
    expect(repairHintForDiagnostic(discriminator!)).toContain("Map TypeScript root diagnostics");
  });
});

describe("live fact shadow runner prompts", () => {
  it("embeds scenario guidance in provider requests for tsc_diagnostic_grouping", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "rector-live-fact-shadow-request-"));
    const captured: LLMRequest[] = [];
    const USAGE = { inputTokens: 10, outputTokens: 10, totalTokens: 20, estimatedUsd: 0, modelCalls: 1 };

    class CaptureProvider implements LLMProvider {
      readonly metadata = ProviderCapabilityMetadataSchema.parse({
        id: "capture-provider",
        displayName: "Capture Provider",
        routes: ["fast"],
        models: { fast: "test-model" },
        supportsJson: true,
        supportsStreaming: false,
        maxContextTokens: 16_000,
        estimatedUsdPer1kInputTokens: 0,
        estimatedUsdPer1kOutputTokens: 0,
      });

      validateConfig(): void {
        return undefined;
      }

      estimateRequest() {
        return USAGE;
      }

      async invoke(request: LLMRequest): Promise<LLMResponse> {
        captured.push(request);
        return LLMResponseSchema.parse({
          provider: this.metadata.id,
          model: "test-model",
          content: JSON.stringify({
            facts: [
              {
                kind: "capability_evidence",
                capabilityId: "live_shadow.tsc",
                summary: "TS2322 at src/index.ts:2",
                evidence: [{ refType: "source_span", path: "src/index.ts", startLine: 2, endLine: 2 }],
              },
              {
                kind: "capability_warning",
                capabilityId: "live_shadow.tsc",
                warning: "No fix claimed",
                severity: "low",
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
        providerDiscovery: () => [
          {
            provider: new CaptureProvider(),
            route: "fast",
            modelId: "test-model",
            liveEvidence: false,
            discoveryLabel: "capture",
          },
        ],
      });

      const tscScenario = liveFactShadowScenarios().find((entry) => entry.id === "tsc_diagnostic_grouping");
      expect(tscScenario).toBeDefined();
      const tscRequest = captured.find((entry) => entry.metadata?.caseId === "tsc_diagnostic_grouping");
      expect(tscRequest?.messages[0]?.content).toContain(LIVE_FACT_SHADOW_ALLOWED_KINDS.join(", "));
      const userContent = tscRequest?.messages[1]?.content ?? "";
      expect(userContent).toContain("capability_evidence");
      expect(userContent).toContain("capability_warning");
      expect(userContent).toContain("Never use kind diagnostic");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});