import { z } from "zod";

export const CAPABILITY_EVAL_SCHEMA_VERSION = "rector.capability-eval.v1";

const NonEmptyTextSchema = z.string().min(1);

const EvalRequestSchema = z
  .object({
    intent: NonEmptyTextSchema,
    scope: z.array(NonEmptyTextSchema),
    queryHints: z.array(NonEmptyTextSchema),
  })
  .strict();

const EvalOracleSchema = z
  .object({
    mustIncludePaths: z.array(NonEmptyTextSchema),
    mustIncludeLineContains: z.array(NonEmptyTextSchema),
    mustNotClaimPaths: z.array(NonEmptyTextSchema),
  })
  .strict();

export const CapabilityEvalCaseSchema = z
  .object({
    schemaVersion: z.literal(CAPABILITY_EVAL_SCHEMA_VERSION).default(CAPABILITY_EVAL_SCHEMA_VERSION),
    id: NonEmptyTextSchema,
    capabilityId: NonEmptyTextSchema,
    workspaceRef: NonEmptyTextSchema,
    request: EvalRequestSchema,
    oracle: EvalOracleSchema,
  })
  .strict();

// Hardcoded (not derived from CAPABILITY_EVAL_METRIC_IDS in metrics.ts) to avoid a runtime
// circular import: metrics.ts imports the CapabilityEvalResult type from this module. The
// contract test in capabilitySchemas.test.ts iterates CAPABILITY_EVAL_METRIC_IDS to keep these
// in lockstep.
export const CapabilityMetricScoresSchema = z
  .object({
    schema_valid: z.number().finite(),
    recall: z.number().finite(),
    omission: z.number().finite(),
    secret_leak: z.number().finite(),
    compression: z.number().finite(),
    raw_token_reduction: z.number().finite(),
    line_ref_accuracy: z.number().finite(),
    root_cause_accuracy: z.number().finite(),
  })
  .strict();

export const CapabilityEvalResultSchema = z
  .object({
    schemaVersion: z.literal(CAPABILITY_EVAL_SCHEMA_VERSION).default(CAPABILITY_EVAL_SCHEMA_VERSION),
    caseId: NonEmptyTextSchema,
    capabilityId: NonEmptyTextSchema,
    passed: z.boolean(),
    metricScores: CapabilityMetricScoresSchema,
    omissions: z.array(NonEmptyTextSchema),
    rawArtifactRefs: z.array(NonEmptyTextSchema),
    failureReason: NonEmptyTextSchema.optional(),
  })
  .strict();

export type CapabilityEvalCase = Readonly<z.infer<typeof CapabilityEvalCaseSchema>>;
export type CapabilityEvalResult = Readonly<z.infer<typeof CapabilityEvalResultSchema>>;
export type CapabilityMetricScores = Readonly<z.infer<typeof CapabilityMetricScoresSchema>>;
