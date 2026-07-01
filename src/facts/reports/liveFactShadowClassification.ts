import {
  createStrictOutputDiagnostic,
  diagnosticFromSemanticInvariant,
  projectSafeStrictOutputDiagnostics,
  zodDiagnostics,
  type SafeStrictOutputDiagnostic,
  type StrictOutputDiagnostic,
  type StrictOutputDiagnosticKind,
} from "../../orchestration/strictOutputDiagnostics";
import type { StrictJsonAttemptReport, StrictJsonPassClassification } from "../../orchestration/strictJsonRepairLoop";
import type { FactValidationError, RectorFact } from "../types";
import type {
  LiveFactShadowAttemptSummary,
  LiveFactShadowCaseReport,
  LiveFactShadowFailureCategoryCounts,
  LiveFactShadowPassClassification,
} from "./liveFactShadowReport";

export type LiveFactShadowCaseEvaluation = Readonly<{
  facts: readonly RectorFact[];
  errors: readonly FactValidationError[];
  schemaValidity: boolean;
  provenanceCompleteness: boolean;
  hallucinatedRefs: readonly string[];
  insufficientEvidenceCorrect: boolean | null;
}>;

export function factValidationErrorToDiagnostic(error: FactValidationError): StrictOutputDiagnostic {
  return createStrictOutputDiagnostic({
    kind: factValidationGateToKind(error),
    code: error.code,
    path: error.path,
    message: error.message,
    severity: error.severity,
  });
}

export function diagnosticsFromFactValidationErrors(errors: readonly FactValidationError[]): readonly StrictOutputDiagnostic[] {
  return errors.map((entry) => factValidationErrorToDiagnostic(entry));
}

export function diagnosticsFromShadowCaseEvaluation(
  evaluation: LiveFactShadowCaseEvaluation,
  options: Readonly<{ expectInsufficientEvidence?: boolean }> = {},
): readonly StrictOutputDiagnostic[] {
  const diagnostics: StrictOutputDiagnostic[] = [...diagnosticsFromFactValidationErrors(evaluation.errors)];
  if (!evaluation.schemaValidity) {
    diagnostics.push(
      diagnosticFromSemanticInvariant({
        code: "shadow_schema_validity_failed",
        message: "No schema-valid fact of the expected kind was produced for this shadow case",
      }),
    );
  }
  if (!evaluation.provenanceCompleteness) {
    diagnostics.push(
      createStrictOutputDiagnostic({
        kind: "provenance",
        code: "shadow_provenance_incomplete",
        message: "Provenance completeness check failed for live shadow output",
      }),
    );
  }
  if (evaluation.hallucinatedRefs.length > 0) {
    diagnostics.push(
      diagnosticFromSemanticInvariant({
        code: "shadow_hallucinated_reference",
        message: `Hallucinated references detected: ${evaluation.hallucinatedRefs.join(", ")}`,
      }),
    );
  }
  if (options.expectInsufficientEvidence && evaluation.insufficientEvidenceCorrect !== true) {
    diagnostics.push(
      diagnosticFromSemanticInvariant({
        code: "shadow_insufficient_evidence_incorrect",
        message: "Case required correct insufficient_evidence handling",
      }),
    );
  }
  return diagnostics;
}

export function failureCategoryFlags(
  diagnostics: readonly Pick<SafeStrictOutputDiagnostic, "kind">[],
): Readonly<{ semanticOrSchema: boolean; groundingOrProvenance: boolean; providerOrRuntime: boolean }> {
  let semanticOrSchema = false;
  let groundingOrProvenance = false;
  let providerOrRuntime = false;
  for (const diagnostic of diagnostics) {
    if (diagnostic.kind === "json_syntax" || diagnostic.kind === "schema" || diagnostic.kind === "semantic_invariant") {
      semanticOrSchema = true;
    }
    if (diagnostic.kind === "grounding" || diagnostic.kind === "provenance") {
      groundingOrProvenance = true;
    }
    if (diagnostic.kind === "provider_runtime" || diagnostic.kind === "truncation") {
      providerOrRuntime = true;
    }
  }
  return { semanticOrSchema, groundingOrProvenance, providerOrRuntime };
}

export function aggregateFailureCategoryCounts(
  cases: readonly Pick<LiveFactShadowCaseReport, "status" | "attempts">[],
): LiveFactShadowFailureCategoryCounts {
  const totals = { semanticOrSchema: 0, groundingOrProvenance: 0, providerOrRuntime: 0 };
  for (const caseReport of cases) {
    if (caseReport.status !== "failed") continue;
    const lastAttempt = caseReport.attempts[caseReport.attempts.length - 1];
    if (!lastAttempt) continue;
    const flags = failureCategoryFlags(lastAttempt.safeDiagnostics);
    if (flags.semanticOrSchema) totals.semanticOrSchema += 1;
    if (flags.groundingOrProvenance) totals.groundingOrProvenance += 1;
    if (flags.providerOrRuntime) totals.providerOrRuntime += 1;
  }
  return totals;
}

export function rollupPassOutcomeCounts(
  cases: readonly Pick<LiveFactShadowCaseReport, "passClassification" | "status">[],
): Readonly<{ firstPassCases: number; repairPassCases: number; failedAfterRepairCases: number }> {
  let firstPassCases = 0;
  let repairPassCases = 0;
  let failedAfterRepairCases = 0;
  for (const caseReport of cases) {
    if (caseReport.passClassification === "first_pass" && caseReport.status === "passed") firstPassCases += 1;
    if (caseReport.passClassification === "repair_pass" && caseReport.status === "passed") repairPassCases += 1;
    if (caseReport.passClassification === "failed_after_repair") failedAfterRepairCases += 1;
  }
  return { firstPassCases, repairPassCases, failedAfterRepairCases };
}

export function passClassificationFromRepairLoop(
  loopStatus: "passed" | "failed",
  loopClassification: StrictJsonPassClassification,
): LiveFactShadowPassClassification {
  if (loopStatus === "passed") {
    return loopClassification === "repair_pass" ? "repair_pass" : "first_pass";
  }
  return "failed_after_repair";
}

export function attemptSummariesFromStrictJsonAttempts(
  attempts: readonly StrictJsonAttemptReport[],
): LiveFactShadowAttemptSummary[] {
  return attempts.map((attempt) => ({
    attemptNumber: attempt.attemptNumber === 2 ? 2 : 1,
    attemptKind: attempt.attemptKind,
    jsonParsed: attempt.jsonParsed,
    safeDiagnostics: [...projectSafeStrictOutputDiagnostics(attempt.diagnostics)],
  }));
}

export function classifySkippedCasePassClassification(): LiveFactShadowPassClassification {
  return "skipped";
}

function factValidationGateToKind(error: FactValidationError): StrictOutputDiagnosticKind {
  const code = error.code.toLowerCase();
  if (code.includes("ground") || code.includes("span") || code.includes("not_found")) return "grounding";
  if (code.includes("provenance")) return "provenance";
  if (code.includes("scope")) return "scope";
  if (code.includes("redact") || code.includes("secret")) return "redaction";
  if (code.includes("trust")) return "semantic_invariant";
  if (error.code === "model_json_invalid" || error.code.startsWith("zod_") || error.code === "invalid_type") return "schema";
  return "semantic_invariant";
}

export function zodIssuesToDiagnostics(error: import("zod").ZodError): readonly StrictOutputDiagnostic[] {
  return zodDiagnostics(error);
}