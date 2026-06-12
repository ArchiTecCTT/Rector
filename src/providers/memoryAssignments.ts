import { z } from "zod";

/**
 * Canonical memory roles (Chunk 044).
 *
 * Roles let Rector route different memory workloads to different configured
 * memory providers while preserving the zero-config local default when no
 * assignment exists.
 */
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

export const MemoryRetentionPolicySchema = z.enum(["ephemeral", "session", "durable", "longTerm"]);
export type MemoryRetentionPolicy = z.infer<typeof MemoryRetentionPolicySchema>;

export const MemoryAssignmentProviderRefSchema = z.string().min(1);
export type MemoryAssignmentProviderRef = z.infer<typeof MemoryAssignmentProviderRefSchema>;

// Chunk 045 templates use provider-selection naming; keep it as an alias of the Chunk 044 provider ref.
export const MemoryProviderSelectionSchema = MemoryAssignmentProviderRefSchema;
export type MemoryProviderSelection = MemoryAssignmentProviderRef;

export interface MemoryRoleDefinition {
  role: MemoryRole;
  label: string;
  purpose: string;
  defaultProviderRecordId: "local" | "disabled";
  optional: boolean;
}

export const MEMORY_ROLE_DEFINITIONS: Record<MemoryRole, MemoryRoleDefinition> = {
  conversationStore: {
    role: "conversationStore",
    label: "Conversation store",
    purpose: "Conversations, messages, runs, and event history.",
    defaultProviderRecordId: "local",
    optional: false,
  },
  episodicMemory: {
    role: "episodicMemory",
    label: "Episodic memory",
    purpose: "Run and user experience memories used for recall.",
    defaultProviderRecordId: "local",
    optional: false,
  },
  semanticMemory: {
    role: "semanticMemory",
    label: "Semantic memory",
    purpose: "Summarized knowledge and durable high-signal memory.",
    defaultProviderRecordId: "local",
    optional: false,
  },
  truthLibrary: {
    role: "truthLibrary",
    label: "Truth library",
    purpose: "Trusted documents, facts, citations, and provenance.",
    defaultProviderRecordId: "local",
    optional: false,
  },
  vectorSearch: {
    role: "vectorSearch",
    label: "Vector search",
    purpose: "Embedding-based recall with local keyword fallback when no vector provider is assigned.",
    defaultProviderRecordId: "local",
    optional: true,
  },
  reflectionLessons: {
    role: "reflectionLessons",
    label: "Reflection lessons",
    purpose: "Ponder/subconscious lessons and long-term reflections.",
    defaultProviderRecordId: "local",
    optional: false,
  },
  artifactIndex: {
    role: "artifactIndex",
    label: "Artifact index",
    purpose: "File, document, and generated artifact metadata.",
    defaultProviderRecordId: "local",
    optional: false,
  },
};

export const MemoryRoleAssignmentSchema = z
  .object({
    id: z.string().min(1),
    userId: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
    role: MemoryRoleSchema,
    /** Provider record id, or the built-in sentinels `local` / `disabled`. */
    providerRecordId: MemoryAssignmentProviderRefSchema,
    enabled: z.boolean(),
    readPriority: z.number().int().optional(),
    writePriority: z.number().int().optional(),
    fallbackProviderRecordId: MemoryAssignmentProviderRefSchema.optional(),
    retentionPolicy: MemoryRetentionPolicySchema.optional(),
    maxEntries: z.number().int().positive().optional(),
    maxUsdPerDay: z.number().nonnegative().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type MemoryRoleAssignment = z.infer<typeof MemoryRoleAssignmentSchema>;

export const MEMORY_ASSIGNMENT_CONFIG_VERSION = 1 as const;

export const MemoryAssignmentStateSchema = z
  .object({
    version: z.literal(MEMORY_ASSIGNMENT_CONFIG_VERSION),
    assignments: z.array(MemoryRoleAssignmentSchema),
  })
  .strict();

export type MemoryAssignmentState = z.infer<typeof MemoryAssignmentStateSchema>;

export function emptyMemoryAssignmentState(): MemoryAssignmentState {
  return { version: MEMORY_ASSIGNMENT_CONFIG_VERSION, assignments: [] };
}

export interface MemoryProviderCapabilities {
  durable: boolean;
  vectorSearch: boolean;
  keywordSearch: boolean;
  metadataFilters: boolean;
  delete: boolean;
  update: boolean;
  prune: boolean;
  externalNetwork: boolean;
  estimatedCostTier: "free" | "low" | "medium" | "high";
}

export const MemoryProviderCapabilitiesSchema = z
  .object({
    durable: z.boolean(),
    vectorSearch: z.boolean(),
    keywordSearch: z.boolean(),
    metadataFilters: z.boolean(),
    delete: z.boolean(),
    update: z.boolean(),
    prune: z.boolean(),
    externalNetwork: z.boolean(),
    estimatedCostTier: z.enum(["free", "low", "medium", "high"]),
  })
  .strict();

const DISABLED_CAPABILITIES: MemoryProviderCapabilities = {
  durable: false,
  vectorSearch: false,
  keywordSearch: false,
  metadataFilters: false,
  delete: false,
  update: false,
  prune: false,
  externalNetwork: false,
  estimatedCostTier: "free",
};

export function memoryProviderCapabilitiesForKind(kind: string | undefined): MemoryProviderCapabilities {
  switch (kind) {
    case "local-sqlite-mem":
      return {
        durable: true,
        vectorSearch: false,
        keywordSearch: true,
        metadataFilters: true,
        delete: true,
        update: true,
        prune: true,
        externalNetwork: false,
        estimatedCostTier: "free",
      };
    case "tidb-memory":
      return {
        durable: true,
        vectorSearch: false,
        keywordSearch: true,
        metadataFilters: true,
        delete: true,
        update: true,
        prune: true,
        externalNetwork: true,
        estimatedCostTier: "low",
      };
    case "mem0":
      return {
        durable: true,
        vectorSearch: true,
        keywordSearch: true,
        metadataFilters: true,
        delete: true,
        update: true,
        prune: true,
        externalNetwork: true,
        estimatedCostTier: "medium",
      };
    case "chroma":
      return {
        durable: true,
        vectorSearch: true,
        keywordSearch: true,
        metadataFilters: true,
        delete: true,
        update: true,
        prune: true,
        externalNetwork: true,
        estimatedCostTier: "low",
      };
    case "disabled":
      return { ...DISABLED_CAPABILITIES };
    case "local-inmemory":
    case "local":
    default:
      return {
        durable: false,
        vectorSearch: false,
        keywordSearch: true,
        metadataFilters: true,
        delete: true,
        update: true,
        prune: true,
        externalNetwork: false,
        estimatedCostTier: "free",
      };
  }
}

export interface MemoryCapabilityWarning {
  code:
    | "VECTOR_UNAVAILABLE"
    | "NON_DURABLE_PROVIDER"
    | "EXTERNAL_MEMORY"
    | "PROVIDER_DISABLED"
    | "METADATA_FILTERS_UNAVAILABLE";
  severity: "info" | "warning" | "error";
  message: string;
}

export function memoryCapabilityWarningsForRole(input: {
  role: MemoryRole;
  capabilities: MemoryProviderCapabilities;
  providerKind?: string;
  providerLabel?: string;
  providerRecordId?: string;
  mode?: "local" | "external";
}): MemoryCapabilityWarning[] {
  const { role, capabilities, providerLabel, providerKind, providerRecordId, mode } = input;
  const label = providerLabel || providerKind || providerRecordId || "provider";
  const warnings: MemoryCapabilityWarning[] = [];

  if (providerRecordId === "disabled" || providerKind === "disabled") {
    warnings.push({
      code: "PROVIDER_DISABLED",
      severity: MEMORY_ROLE_DEFINITIONS[role].optional ? "info" : "warning",
      message: `${MEMORY_ROLE_DEFINITIONS[role].label} is disabled.`,
    });
    return warnings;
  }

  if (role === "vectorSearch" && !capabilities.vectorSearch) {
    warnings.push({
      code: "VECTOR_UNAVAILABLE",
      severity: "warning",
      message: `${label} does not support vector search; Rector will use keyword-style local recall for this role.`,
    });
  }

  if ((role === "conversationStore" || role === "artifactIndex") && !capabilities.durable) {
    warnings.push({
      code: "NON_DURABLE_PROVIDER",
      severity: "info",
      message: `${label} is not durable. Use Local SQLite or a durable provider for persistence beyond this process.`,
    });
  }

  if ((role === "truthLibrary" || role === "semanticMemory") && !capabilities.metadataFilters) {
    warnings.push({
      code: "METADATA_FILTERS_UNAVAILABLE",
      severity: "warning",
      message: `${label} does not advertise metadata filters, which can reduce recall precision for ${MEMORY_ROLE_DEFINITIONS[role].label}.`,
    });
  }

  if (mode === "external" && capabilities.externalNetwork) {
    warnings.push({
      code: "EXTERNAL_MEMORY",
      severity: "info",
      message: `${label} may use an external network-backed memory service. Check provider costs and data policy before enabling this role.`,
    });
  }

  return warnings;
}

export function memoryAssignmentIdFor(input: {
  role: MemoryRole;
  userId?: string;
  workspaceId?: string;
}): string {
  const userPart = input.userId?.trim() || "global";
  const workspacePart = input.workspaceId?.trim() || "all-workspaces";
  return `memory-assignment:${userPart}:${workspacePart}:${input.role}`;
}

export function createMemoryRoleAssignment(input: {
  role: MemoryRole;
  providerRecordId: string;
  now: string;
  existing?: MemoryRoleAssignment;
  userId?: string;
  workspaceId?: string;
  enabled?: boolean;
  readPriority?: number;
  writePriority?: number;
  fallbackProviderRecordId?: string;
  retentionPolicy?: MemoryRetentionPolicy;
  maxEntries?: number;
  maxUsdPerDay?: number;
}): MemoryRoleAssignment {
  return MemoryRoleAssignmentSchema.parse({
    id: input.existing?.id ?? memoryAssignmentIdFor(input),
    userId: input.userId ?? input.existing?.userId,
    workspaceId: input.workspaceId ?? input.existing?.workspaceId,
    role: input.role,
    providerRecordId: input.providerRecordId,
    enabled: input.enabled ?? input.existing?.enabled ?? true,
    readPriority: input.readPriority ?? input.existing?.readPriority,
    writePriority: input.writePriority ?? input.existing?.writePriority,
    fallbackProviderRecordId: input.fallbackProviderRecordId ?? input.existing?.fallbackProviderRecordId,
    retentionPolicy: input.retentionPolicy ?? input.existing?.retentionPolicy,
    maxEntries: input.maxEntries ?? input.existing?.maxEntries,
    maxUsdPerDay: input.maxUsdPerDay ?? input.existing?.maxUsdPerDay,
    createdAt: input.existing?.createdAt ?? input.now,
    updatedAt: input.now,
  });
}
