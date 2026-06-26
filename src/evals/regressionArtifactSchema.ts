import { z } from "zod";

export const ValidatorRunSnapshotSchema = z.object({
  id: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  exitCode: z.number(),
  stdoutRedacted: z.string(),
  stderrRedacted: z.string(),
  durationMs: z.number(),
  timedOut: z.boolean(),
});

export const HashEntrySchema = z.object({ path: z.string(), sha256: z.string() });

export const RegressionArtifactSchema = z.object({
  schemaVersion: z.literal("rector.regression-artifact.v1"),
  scenarioId: z.string(),
  workspace: z.string(),
  tempWorkspace: z.string().optional(),
  operation: z
    .object({
      kind: z.string(),
      patchFile: z.string().optional(),
    })
    .optional(),
  failedValidators: z.array(ValidatorRunSnapshotSchema),
  beforeHashes: z.array(HashEntrySchema),
  afterHashes: z.array(HashEntrySchema),
  manifestDiffSummary: z.string(),
  failedDimensions: z.array(z.string()),
  replayCommand: z.string(),
  generatedAt: z.string(),
});

export type RegressionArtifact = z.infer<typeof RegressionArtifactSchema>;
