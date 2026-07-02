import { z } from "zod";

import { FactValidationErrorReportSchema } from "./factReport";

export const LIVE_FACT_SHADOW_REPORT_SCHEMA_VERSION = "rector.live-fact-shadow-report.v2";
export const LIVE_FACT_SHADOW_SUMMARY_SCHEMA_VERSION = "rector.live-fact-shadow-summary.v2";

export const LIVE_FACT_SHADOW_PASS_CLASSIFICATIONS = [
  "first_pass",
  "repair_pass",
  "failed_after_repair",
  "skipped",
] as const;

export type LiveFactShadowPassClassification = (typeof LIVE_FACT_SHADOW_PASS_CLASSIFICATIONS)[number];

const LiveFactShadowTokenUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    modelCalls: z.number().int().nonnegative(),
  })
  .strict();

export const LiveFactShadowSafeDiagnosticSchema = z
  .object({
    kind: z.enum([
      "json_syntax",
      "schema",
      "semantic_invariant",
      "provenance",
      "grounding",
      "scope",
      "redaction",
      "truncation",
      "provider_runtime",
    ]),
    code: z.string().min(1),
    path: z.string().min(1),
    severity: z.enum(["error", "warning", "info"]),
  })
  .strict();

export const LiveFactShadowAttemptSummarySchema = z
  .object({
    attemptNumber: z.union([z.literal(1), z.literal(2)]),
    attemptKind: z.enum(["first", "repair"]),
    jsonParsed: z.boolean(),
    safeDiagnostics: z.array(LiveFactShadowSafeDiagnosticSchema),
  })
  .strict();

export const LiveFactShadowFailureCategoryCountsSchema = z
  .object({
    semanticOrSchema: z.number().int().nonnegative(),
    groundingOrProvenance: z.number().int().nonnegative(),
    providerOrRuntime: z.number().int().nonnegative(),
  })
  .strict();

export const LiveFactShadowCaseReportSchema = z
  .object({
    caseId: z.string().min(1),
    title: z.string().min(1),
    status: z.enum(["passed", "failed", "skipped"]),
    passClassification: z.enum(LIVE_FACT_SHADOW_PASS_CLASSIFICATIONS),
    providerId: z.string().min(1).nullable(),
    modelId: z.string().min(1).nullable(),
    route: z.string().min(1),
    schemaValidity: z.boolean(),
    provenanceCompleteness: z.boolean(),
    hallucinatedRefs: z.array(z.string().min(1)),
    insufficientEvidenceCorrect: z.boolean().nullable(),
    tokenUsage: LiveFactShadowTokenUsageSchema,
    estimatedCostUsd: z.number().nonnegative(),
    latencyMs: z.number().int().nonnegative(),
    rawArtifactRefs: z.array(z.string().min(1)),
    factRefs: z.array(z.object({ factId: z.string().min(1), kind: z.string().min(1), trustLevel: z.string().min(1) }).strict()),
    validationErrors: z.array(FactValidationErrorReportSchema),
    failureReasons: z.array(z.string().min(1)),
    attempts: z.array(LiveFactShadowAttemptSummarySchema),
  })
  .strict();

export const LiveFactShadowReportSchema = z
  .object({
    schemaVersion: z.literal(LIVE_FACT_SHADOW_REPORT_SCHEMA_VERSION),
    generatedAt: z.string().datetime(),
    status: z.enum(["completed", "skipped"]),
    liveEvidenceStatus: z.enum(["live_provider", "test_only_injected", "skipped"]),
    skippedReason: z.string().min(1).optional(),
    providerId: z.string().min(1).nullable(),
    modelId: z.string().min(1).nullable(),
    route: z.string().min(1).nullable(),
    caseCount: z.number().int().nonnegative(),
    passedCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(),
    skippedCount: z.number().int().nonnegative(),
    firstPassCases: z.number().int().nonnegative(),
    repairPassCases: z.number().int().nonnegative(),
    failedAfterRepairCases: z.number().int().nonnegative(),
    failureCategoryCounts: LiveFactShadowFailureCategoryCountsSchema,
    cases: z.array(LiveFactShadowCaseReportSchema),
    notes: z.array(z.string().min(1)),
  })
  .strict();

export const LiveFactShadowSummarySchema = z
  .object({
    schemaVersion: z.literal(LIVE_FACT_SHADOW_SUMMARY_SCHEMA_VERSION),
    generatedAt: z.string().datetime(),
    status: z.enum(["completed", "skipped"]),
    liveEvidenceStatus: z.enum(["live_provider", "test_only_injected", "skipped"]),
    caseCount: z.number().int().nonnegative(),
    passedCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(),
    skippedCount: z.number().int().nonnegative(),
    firstPassCases: z.number().int().nonnegative(),
    repairPassCases: z.number().int().nonnegative(),
    failedAfterRepairCases: z.number().int().nonnegative(),
    failureCategoryCounts: LiveFactShadowFailureCategoryCountsSchema,
    totalTokenUsage: LiveFactShadowTokenUsageSchema,
    totalEstimatedCostUsd: z.number().nonnegative(),
    reportJson: z.string().min(1),
    reportMarkdown: z.string().min(1),
  })
  .strict();

export type LiveFactShadowReport = Readonly<z.infer<typeof LiveFactShadowReportSchema>>;
export type LiveFactShadowCaseReport = Readonly<z.infer<typeof LiveFactShadowCaseReportSchema>>;
export type LiveFactShadowAttemptSummary = Readonly<z.infer<typeof LiveFactShadowAttemptSummarySchema>>;
export type LiveFactShadowFailureCategoryCounts = Readonly<z.infer<typeof LiveFactShadowFailureCategoryCountsSchema>>;