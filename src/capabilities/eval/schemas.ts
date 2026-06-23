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

export const CapabilityEvalResultSchema = z
  .object({
    schemaVersion: z.literal(CAPABILITY_EVAL_SCHEMA_VERSION).default(CAPABILITY_EVAL_SCHEMA_VERSION),
    caseId: NonEmptyTextSchema,
    capabilityId: NonEmptyTextSchema,
    passed: z.boolean(),
    metricScores: z.record(z.number().finite()),
    omissions: z.array(NonEmptyTextSchema),
    rawArtifactRefs: z.array(NonEmptyTextSchema),
    failureReason: NonEmptyTextSchema.optional(),
  })
  .strict();

export type CapabilityEvalCase = Readonly<z.infer<typeof CapabilityEvalCaseSchema>>;
export type CapabilityEvalResult = Readonly<z.infer<typeof CapabilityEvalResultSchema>>;
