import { z } from "zod";

/**
 * Additive memory-role assignment contracts for Chunk 045 templates.
 *
 * Chunk 044's durable provider-role routing may land in a sibling wave. This file supplies the
 * canonical role ids and a secret-free in-memory assignment store so template apply can update role
 * assignments without deleting or mutating configured memory provider records.
 */

const NonEmptyStringSchema = z.string().min(1);

export const MEMORY_ROLES = [
  "conversationStore",
  "episodicMemory",
  "semanticMemory",
  "truthLibrary",
  "vectorSearch",
  "reflectionLessons",
  "artifactIndex",
] as const;

export const MemoryRoleSchema = z.enum(MEMORY_ROLES);
export type MemoryRole = z.infer<typeof MemoryRoleSchema>;

export const MemoryProviderSelectionSchema = z.union([
  z.literal("local"),
  z.literal("disabled"),
  NonEmptyStringSchema,
]);
export type MemoryProviderSelection = z.infer<typeof MemoryProviderSelectionSchema>;

export const MemoryRoleAssignmentSchema = z
  .object({
    id: NonEmptyStringSchema,
    userId: NonEmptyStringSchema.optional(),
    workspaceId: NonEmptyStringSchema.optional(),
    role: MemoryRoleSchema,
    providerRecordId: MemoryProviderSelectionSchema,
    enabled: z.boolean(),
    readPriority: z.number().int().nonnegative().optional(),
    writePriority: z.number().int().nonnegative().optional(),
    fallbackProviderRecordId: MemoryProviderSelectionSchema.optional(),
    retentionPolicy: z.enum(["ephemeral", "session", "durable", "longTerm"]).optional(),
    maxEntries: z.number().int().positive().optional(),
    maxUsdPerDay: z.number().nonnegative().finite().optional(),
    notes: z.string().max(1000).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type MemoryRoleAssignment = z.infer<typeof MemoryRoleAssignmentSchema>;

export interface MemoryRoleAssignmentStore {
  listAssignments(scopeId?: string): Promise<MemoryRoleAssignment[]>;
  upsertAssignment(assignment: MemoryRoleAssignment, scopeId?: string): Promise<MemoryRoleAssignment>;
  replaceAssignments(
    assignments: readonly MemoryRoleAssignment[],
    scopeId?: string,
  ): Promise<MemoryRoleAssignment[]>;
  resetAssignments(scopeId?: string): Promise<void>;
}

function scopeKey(scopeId: string | undefined): string {
  return scopeId && scopeId.trim().length > 0 ? scopeId : "default";
}

export function createInMemoryMemoryRoleAssignmentStore(
  initial: readonly MemoryRoleAssignment[] = [],
): MemoryRoleAssignmentStore {
  const byScope = new Map<string, MemoryRoleAssignment[]>();
  byScope.set("default", initial.map((assignment) => MemoryRoleAssignmentSchema.parse(assignment)));

  return {
    async listAssignments(scopeId?: string): Promise<MemoryRoleAssignment[]> {
      return structuredClone(byScope.get(scopeKey(scopeId)) ?? []);
    },

    async upsertAssignment(
      assignment: MemoryRoleAssignment,
      scopeId?: string,
    ): Promise<MemoryRoleAssignment> {
      const parsed = MemoryRoleAssignmentSchema.parse(assignment);
      const key = scopeKey(scopeId);
      const current = [...(byScope.get(key) ?? [])];
      const index = current.findIndex((existing) => existing.role === parsed.role);
      if (index >= 0) current[index] = parsed;
      else current.push(parsed);
      byScope.set(key, current);
      return structuredClone(parsed);
    },

    async replaceAssignments(
      assignments: readonly MemoryRoleAssignment[],
      scopeId?: string,
    ): Promise<MemoryRoleAssignment[]> {
      const parsed = assignments.map((assignment) => MemoryRoleAssignmentSchema.parse(assignment));
      byScope.set(scopeKey(scopeId), parsed);
      return structuredClone(parsed);
    },

    async resetAssignments(scopeId?: string): Promise<void> {
      byScope.delete(scopeKey(scopeId));
    },
  };
}
