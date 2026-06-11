import { z } from "zod";

export const NeuroFeatureFlagsSchema = z.object({
  preprocessor: z.boolean().default(true),
  deepPlanning: z.boolean().default(false),
  decomposition: z.boolean().default(true),
  proactive: z.boolean().default(true),
  ponder: z.boolean().default(true),
});
export type NeuroFeatureFlags = z.infer<typeof NeuroFeatureFlagsSchema>;

export const DEFAULT_NEURO_FEATURE_FLAGS: NeuroFeatureFlags = NeuroFeatureFlagsSchema.parse({});

export function resolveNeuroFeatureFlags(
  input: Partial<NeuroFeatureFlags> | undefined,
): NeuroFeatureFlags {
  return NeuroFeatureFlagsSchema.parse({ ...DEFAULT_NEURO_FEATURE_FLAGS, ...input });
}