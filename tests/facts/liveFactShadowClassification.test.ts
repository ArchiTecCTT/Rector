import { describe, expect, it } from "vitest";

import {
  aggregateFailureCategoryCounts,
  attemptSummariesFromStrictJsonAttempts,
  diagnosticsFromShadowCaseEvaluation,
  failureCategoryFlags,
  passClassificationFromRepairLoop,
  rollupPassOutcomeCounts,
} from "../../src/facts/reports/liveFactShadowClassification";
import { LiveFactShadowCaseReportSchema } from "../../src/facts/reports/liveFactShadowReport";
import { createStrictOutputDiagnostic } from "../../src/orchestration/strictOutputDiagnostics";
import type { StrictJsonAttemptReport } from "../../src/orchestration/strictJsonRepairLoop";

describe("live fact shadow classification", () => {
  it("maps evaluation failures into semantic and grounding categories", () => {
    const diagnostics = diagnosticsFromShadowCaseEvaluation({
      facts: [],
      errors: [{ code: "missing_provenance", message: "missing", path: ["provenance"], severity: "error" }],
      schemaValidity: false,
      provenanceCompleteness: false,
      hallucinatedRefs: [],
      insufficientEvidenceCorrect: null,
    });
    const flags = failureCategoryFlags(diagnostics.map((entry) => ({ kind: entry.kind })));
    expect(flags.semanticOrSchema).toBe(true);
    expect(flags.groundingOrProvenance).toBe(true);
  });

  it("rolls up first-pass, repair-pass, and failed-after-repair case counts", () => {
    const cases = [
      LiveFactShadowCaseReportSchema.parse(caseFixture({ caseId: "a", status: "passed", passClassification: "first_pass" })),
      LiveFactShadowCaseReportSchema.parse(caseFixture({ caseId: "b", status: "passed", passClassification: "repair_pass" })),
      LiveFactShadowCaseReportSchema.parse(caseFixture({ caseId: "c", status: "failed", passClassification: "failed_after_repair" })),
    ];
    expect(rollupPassOutcomeCounts(cases)).toEqual({
      firstPassCases: 1,
      repairPassCases: 1,
      failedAfterRepairCases: 1,
    });
  });

  it("aggregates failure category counts for failed cases only", () => {
    const cases = [
      LiveFactShadowCaseReportSchema.parse(
        caseFixture({
          caseId: "failed-schema",
          status: "failed",
          passClassification: "failed_after_repair",
          attempts: [
            {
              attemptNumber: 2,
              attemptKind: "repair",
              jsonParsed: false,
              safeDiagnostics: [{ kind: "json_syntax", code: "json_syntax_error", path: "(root)", severity: "error" }],
            },
          ],
        }),
      ),
      LiveFactShadowCaseReportSchema.parse(caseFixture({ caseId: "passed", status: "passed", passClassification: "first_pass" })),
    ];
    expect(aggregateFailureCategoryCounts(cases)).toEqual({
      semanticOrSchema: 1,
      groundingOrProvenance: 0,
      providerOrRuntime: 0,
    });
  });

  it("projects safe attempt summaries from strict JSON repair attempts", () => {
    const attempts: StrictJsonAttemptReport[] = [
      {
        attemptNumber: 1,
        attemptKind: "first",
        evidenceStatus: "live_provider",
        jsonParsed: false,
        diagnostics: [
          createStrictOutputDiagnostic({
            kind: "json_syntax",
            code: "json_syntax_error",
            message: "not json",
          }),
        ],
        diagnosticSummary: "json_syntax/json_syntax_error",
      },
      {
        attemptNumber: 2,
        attemptKind: "repair",
        evidenceStatus: "live_provider",
        jsonParsed: true,
        diagnostics: [],
        diagnosticSummary: "No strict output diagnostics.",
      },
    ];
    const summaries = attemptSummariesFromStrictJsonAttempts(attempts);
    expect(summaries).toHaveLength(2);
    expect(summaries[0]?.safeDiagnostics[0]?.code).toBe("json_syntax_error");
    expect(summaries[1]?.safeDiagnostics).toEqual([]);
  });

  it("maps repair loop classifications to shadow pass classifications", () => {
    expect(passClassificationFromRepairLoop("passed", "first_pass")).toBe("first_pass");
    expect(passClassificationFromRepairLoop("passed", "repair_pass")).toBe("repair_pass");
    expect(passClassificationFromRepairLoop("failed", "failed_after_repair")).toBe("failed_after_repair");
  });
});

function caseFixture(input: {
  readonly caseId: string;
  readonly status: "passed" | "failed" | "skipped";
  readonly passClassification: "first_pass" | "repair_pass" | "failed_after_repair" | "skipped";
  readonly attempts?: Array<{
    attemptNumber: 1 | 2;
    attemptKind: "first" | "repair";
    jsonParsed: boolean;
    safeDiagnostics: Array<{ kind: "json_syntax"; code: string; path: string; severity: "error" }>;
  }>;
}) {
  return {
    caseId: input.caseId,
    title: input.caseId,
    status: input.status,
    passClassification: input.passClassification,
    providerId: "contract-live-provider",
    modelId: "contract-live-model",
    route: "fast",
    schemaValidity: input.status === "passed",
    provenanceCompleteness: input.status === "passed",
    hallucinatedRefs: [],
    insufficientEvidenceCorrect: null,
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, modelCalls: 0 },
    estimatedCostUsd: 0,
    latencyMs: 0,
    rawArtifactRefs: [],
    factRefs: [],
    validationErrors: [],
    failureReasons: input.status === "failed" ? ["failed"] : [],
    attempts: input.attempts ?? [],
  };
}