import { z } from "zod";

export const SkillRiskSchema = z.enum(["low", "medium", "high"]);
export type SkillRisk = z.infer<typeof SkillRiskSchema>;

export const SkillPrerequisitesSchema = z
  .object({
    commands: z.array(z.string().min(1)).optional(),
    env_vars: z.array(z.string().min(1)).optional(),
    platforms: z.array(z.string().min(1)).optional(),
  })
  .passthrough();
export type SkillPrerequisites = z.infer<typeof SkillPrerequisitesSchema>;

export const SkillMetadataSchema = z
  .object({
    tags: z.array(z.string().min(1)).optional(),
    related_skills: z.array(z.string().min(1)).optional(),
    risk: SkillRiskSchema.optional(),
  })
  .passthrough();
export type SkillMetadata = z.infer<typeof SkillMetadataSchema>;

export const SkillFrontmatterSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    prerequisites: SkillPrerequisitesSchema.optional(),
    metadata: SkillMetadataSchema.optional(),
  })
  .passthrough();
export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

export const SkillFileSchema = z.object({
  relativePath: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
});
export type SkillFile = z.infer<typeof SkillFileSchema>;

export const SkillManifestSchema = z.object({
  id: z.string().min(1),
  frontmatter: SkillFrontmatterSchema,
  skillPath: z.string().min(1),
  bundled: z.boolean(),
  files: z.array(SkillFileSchema),
});
export type SkillManifest = z.infer<typeof SkillManifestSchema>;

export const SkillManifestSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  tags: z.array(z.string().min(1)),
  risk: SkillRiskSchema,
  bundled: z.boolean(),
  skillPath: z.string().min(1),
});
export type SkillManifestSummary = z.infer<typeof SkillManifestSummarySchema>;

export const SkillActivationDecisionSchema = z.object({
  skillId: z.string().min(1),
  decision: z.enum(["approved", "denied", "deferred"]),
  reason: z.string().min(1),
});
export type SkillActivationDecision = z.infer<typeof SkillActivationDecisionSchema>;

export function skillRiskOf(manifest: SkillManifest): SkillRisk {
  return manifest.frontmatter.metadata?.risk ?? "low";
}

export function skillTagsOf(manifest: SkillManifest): string[] {
  return normalizeSkillStrings(manifest.frontmatter.metadata?.tags ?? []);
}

export function normalizeSkillStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}
