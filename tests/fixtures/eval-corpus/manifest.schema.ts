import { z } from "zod";

export const EvalCorpusArtifactKindSchema = z.enum([
  "rg_output",
  "tsc_no_emit_error",
  "git_diff",
  "test_log",
  "fake_audit_report",
  "package_diagnostic",
  "cartographer_inventory",
]);
export type EvalCorpusArtifactKind = z.infer<typeof EvalCorpusArtifactKindSchema>;

export const EvalCorpusCommandToolSchema = z.enum(["rg", "tsc", "git", "vitest", "npm", "audit_no_fakes", "git_ls_files"]);
export type EvalCorpusCommandTool = z.infer<typeof EvalCorpusCommandToolSchema>;

const RelativeCorpusPathSchema = z
  .string()
  .min(1)
  .refine(isSafeRelativeCorpusPath, {
    message:
      "Corpus paths must be relative to the eval-corpus root (no leading '/', './', or '../', no '/../' segment, no Windows/UNC absolute prefixes)",
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
    expectedEvidencePath: RelativeCorpusPathSchema.optional(),
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
  .strict()
  .refine((manifest) => new Set(manifest.cases.map((fixtureCase) => fixtureCase.id)).size === manifest.cases.length, {
    message: "Case IDs must be unique",
    path: ["cases"],
  });

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
    case "test_log":
      return "vitest";
    case "fake_audit_report":
      return "audit_no_fakes";
    case "package_diagnostic":
      return "npm";
    case "cartographer_inventory":
      return "git_ls_files";
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}

/**
 * Accepts only paths that resolve inside the eval-corpus root. Backslashes are normalized to forward
 * slashes first so Windows absolute (`C:\` / `C:/`) and UNC (`\\` -> `//`) prefixes are caught by the
 * leading-slash check. A leading `./` or `../` and any `..` path segment (the `/../` traversal case,
 * including a trailing `..`) are rejected; a bare `..` inside a filename (e.g. `foo..bar`) is allowed.
 */
function isSafeRelativeCorpusPath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/")) return false;
  if (/^[a-zA-Z]:\//.test(normalized)) return false;
  const segments = normalized.split("/");
  if (segments[0] === "." || segments[0] === "..") return false;
  return !segments.some((segment) => segment === "..");
}
