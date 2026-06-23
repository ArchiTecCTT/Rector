import { z } from "zod";

export const EvalCorpusArtifactKindSchema = z.enum(["rg_output", "tsc_no_emit_error", "git_diff"]);
export type EvalCorpusArtifactKind = z.infer<typeof EvalCorpusArtifactKindSchema>;

export const EvalCorpusCommandToolSchema = z.enum(["rg", "tsc", "git"]);
export type EvalCorpusCommandTool = z.infer<typeof EvalCorpusCommandToolSchema>;

const RelativeCorpusPathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith("/") && !value.startsWith("./") && !value.includes(".."), {
    message: "Corpus paths must be relative to the eval-corpus root",
  });

const CASE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const EvalCorpusCommandSchema = z
  .object({
    tool: EvalCorpusCommandToolSchema,
    recordedCommand: z.string().min(1),
    exitCode: z.number().int().min(0).max(255),
  })
  .strict();

export const EvalCorpusCaseSchema = z
  .object({
    id: z.string().regex(CASE_ID_PATTERN),
    title: z.string().min(1),
    artifactKind: EvalCorpusArtifactKindSchema,
    commandPath: RelativeCorpusPathSchema,
    artifactPath: RelativeCorpusPathSchema,
    oraclePath: RelativeCorpusPathSchema,
    inputPaths: z.array(RelativeCorpusPathSchema).min(1),
    generatedFrom: EvalCorpusCommandSchema,
  })
  .strict()
  .refine((fixtureCase) => expectedToolForArtifact(fixtureCase.artifactKind) === fixtureCase.generatedFrom.tool, {
    message: "Artifact kind must match the recorded command tool",
    path: ["generatedFrom", "tool"],
  });

export const EvalCorpusManifestSchema = z
  .object({
    schemaVersion: z.literal("phase0.eval-corpus.v1"),
    description: z.string().min(1),
    cases: z.array(EvalCorpusCaseSchema).min(3),
  })
  .strict();

export const EvalCorpusOracleSchema = z
  .object({
    caseId: z.string().regex(CASE_ID_PATTERN),
    artifactKind: EvalCorpusArtifactKindSchema,
    expectedExitCode: z.number().int().min(0).max(255),
    expectedLineCount: z.number().int().positive(),
    mustContain: z.array(z.string().min(1)).min(1),
    mustNotContain: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type EvalCorpusManifest = z.infer<typeof EvalCorpusManifestSchema>;
export type EvalCorpusCase = z.infer<typeof EvalCorpusCaseSchema>;
export type EvalCorpusOracle = z.infer<typeof EvalCorpusOracleSchema>;

export function expectedToolForArtifact(kind: EvalCorpusArtifactKind): EvalCorpusCommandTool {
  switch (kind) {
    case "rg_output":
      return "rg";
    case "tsc_no_emit_error":
      return "tsc";
    case "git_diff":
      return "git";
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}
