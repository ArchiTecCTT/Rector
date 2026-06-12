import { z } from "zod";

/**
 * Additive role-assignment contracts for Chunk 045 templates.
 *
 * Chunk 043's durable assignment stores may land in a sibling wave. Until then this file provides
 * the canonical role ids plus a tiny in-memory store that the template system can write to without
 * touching provider secrets or legacy active-route maps. The stitcher can replace the store backing
 * later while keeping this interface shape.
 */

const NonEmptyStringSchema = z.string().min(1);

export const ORCHESTRATION_ROLES = [
  "triage",
  "preprocessor",
  "planner",
  "skeptic",
  "crucible",
  "deepPlanner",
  "taskDecomposer",
  "validator",
  "healer",
  "synthesizer",
  "directAnswer",
  "ponder",
  "embedding",
  "reranker",
] as const;

export const OrchestrationRoleSchema = z.enum(ORCHESTRATION_ROLES);
export type OrchestrationRole = z.infer<typeof OrchestrationRoleSchema>;

export const OrchestrationProviderSelectionSchema = z.union([
  z.literal("deterministic"),
  z.literal("disabled"),
  NonEmptyStringSchema,
]);
export type OrchestrationProviderSelection = z.infer<typeof OrchestrationProviderSelectionSchema>;

export const OrchestrationModelAssignmentSchema = z
  .object({
    id: NonEmptyStringSchema,
    userId: NonEmptyStringSchema.optional(),
    workspaceId: NonEmptyStringSchema.optional(),
    role: OrchestrationRoleSchema,
    providerId: OrchestrationProviderSelectionSchema,
    modelId: NonEmptyStringSchema.optional(),
    fallbackProviderId: OrchestrationProviderSelectionSchema.optional(),
    fallbackModelId: NonEmptyStringSchema.optional(),
    enabled: z.boolean(),
    maxUsdPerCall: z.number().nonnegative().finite().optional(),
    maxTokens: z.number().int().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
    requiresJsonMode: z.boolean().optional(),
    requiresToolCalling: z.boolean().optional(),
    requiresStreaming: z.boolean().optional(),
    notes: z.string().max(1000).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type OrchestrationModelAssignment = z.infer<typeof OrchestrationModelAssignmentSchema>;

export interface OrchestrationAssignmentStore {
  listAssignments(scopeId?: string): Promise<OrchestrationModelAssignment[]>;
  upsertAssignment(
    assignment: OrchestrationModelAssignment,
    scopeId?: string,
  ): Promise<OrchestrationModelAssignment>;
  replaceAssignments(
    assignments: readonly OrchestrationModelAssignment[],
    scopeId?: string,
  ): Promise<OrchestrationModelAssignment[]>;
  resetAssignments(scopeId?: string): Promise<void>;
}

function scopeKey(scopeId: string | undefined): string {
  return scopeId && scopeId.trim().length > 0 ? scopeId : "default";
}

export function createInMemoryOrchestrationAssignmentStore(
  initial: readonly OrchestrationModelAssignment[] = [],
): OrchestrationAssignmentStore {
  const byScope = new Map<string, OrchestrationModelAssignment[]>();
  byScope.set("default", initial.map((assignment) => OrchestrationModelAssignmentSchema.parse(assignment)));

  return {
    async listAssignments(scopeId?: string): Promise<OrchestrationModelAssignment[]> {
      return structuredClone(byScope.get(scopeKey(scopeId)) ?? []);
    },

    async upsertAssignment(
      assignment: OrchestrationModelAssignment,
      scopeId?: string,
    ): Promise<OrchestrationModelAssignment> {
      const parsed = OrchestrationModelAssignmentSchema.parse(assignment);
      const key = scopeKey(scopeId);
      const current = [...(byScope.get(key) ?? [])];
      const index = current.findIndex((existing) => existing.role === parsed.role);
      if (index >= 0) current[index] = parsed;
      else current.push(parsed);
      byScope.set(key, current);
      return structuredClone(parsed);
    },

    async replaceAssignments(
      assignments: readonly OrchestrationModelAssignment[],
      scopeId?: string,
    ): Promise<OrchestrationModelAssignment[]> {
      const parsed = assignments.map((assignment) => OrchestrationModelAssignmentSchema.parse(assignment));
      byScope.set(scopeKey(scopeId), parsed);
      return structuredClone(parsed);
    },

    async resetAssignments(scopeId?: string): Promise<void> {
      byScope.delete(scopeKey(scopeId));
    },
  };
}
