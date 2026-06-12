import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

import { redactString } from "../security/redaction";
import { FakeLLMProvider, type LLMProvider, type ModelRoute, type ModelRouter, type ModelRouterInput, type ModelSelection } from "./llm";
import type { ProviderConfigRecord, ProviderConfigState } from "./config";
import type { ProviderConfigStore } from "./configStore";
import { resolveTestProvider } from "./configBridge";
import type { SecretStore } from "../security/secretStore";

const NonEmptyStringSchema = z.string().min(1);

/** Canonical orchestration roles that may be assigned to a provider/model. */
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

export const ORCHESTRATION_ASSIGNMENT_VERSION = 1 as const;

export const AssignmentProviderIdSchema = z.union([
  z.literal("deterministic"),
  z.literal("disabled"),
  NonEmptyStringSchema,
]);
export type AssignmentProviderId = z.infer<typeof AssignmentProviderIdSchema>;

// Chunk 045 templates use provider-selection naming; keep it as an alias of the richer Chunk 043 schema.
export const OrchestrationProviderSelectionSchema = AssignmentProviderIdSchema;
export type OrchestrationProviderSelection = AssignmentProviderId;

export const ModelCapabilitiesSchema = z
  .object({
    text: z.boolean(),
    jsonMode: z.boolean().optional(),
    toolCalling: z.boolean().optional(),
    streaming: z.boolean().optional(),
    vision: z.boolean().optional(),
    embeddings: z.boolean().optional(),
    maxContextTokens: z.number().int().positive().optional(),
    reasoning: z.enum(["none", "low", "medium", "high"]).optional(),
    costTier: z.enum(["free", "low", "medium", "high"]).optional(),
  })
  .strict();
export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;

export const CapabilityMismatchWarningSchema = z
  .object({
    role: OrchestrationRoleSchema,
    providerId: AssignmentProviderIdSchema,
    modelId: z.string().min(1).optional(),
    severity: z.enum(["warning", "blocker"]),
    code: z.enum([
      "provider_missing",
      "provider_disabled",
      "json_mode_missing",
      "tool_calling_missing",
      "streaming_missing",
      "embeddings_missing",
      "context_window_low",
      "reasoning_low",
      "cost_tier_high",
      "fallback_used",
      "deterministic_fallback",
    ]),
    message: z.string().min(1),
    requiredCapability: z.string().min(1).optional(),
  })
  .strict();
export type CapabilityMismatchWarning = z.infer<typeof CapabilityMismatchWarningSchema>;

export const OrchestrationModelAssignmentSchema = z
  .object({
    id: NonEmptyStringSchema,
    userId: NonEmptyStringSchema.optional(),
    workspaceId: NonEmptyStringSchema.optional(),
    role: OrchestrationRoleSchema,
    providerId: AssignmentProviderIdSchema,
    modelId: NonEmptyStringSchema.optional(),
    fallbackProviderId: AssignmentProviderIdSchema.optional(),
    fallbackModelId: NonEmptyStringSchema.optional(),
    enabled: z.boolean(),
    maxUsdPerCall: z.number().nonnegative().optional(),
    maxTokens: z.number().int().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
    requiresJsonMode: z.boolean().optional(),
    requiresToolCalling: z.boolean().optional(),
    requiresStreaming: z.boolean().optional(),
    notes: z.string().max(2_000).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type OrchestrationModelAssignment = z.infer<typeof OrchestrationModelAssignmentSchema>;

export const OrchestrationAssignmentUpsertSchema = z
  .object({
    providerId: AssignmentProviderIdSchema,
    modelId: NonEmptyStringSchema.optional(),
    fallbackProviderId: AssignmentProviderIdSchema.optional(),
    fallbackModelId: NonEmptyStringSchema.optional(),
    enabled: z.boolean().optional(),
    maxUsdPerCall: z.number().nonnegative().optional(),
    maxTokens: z.number().int().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
    requiresJsonMode: z.boolean().optional(),
    requiresToolCalling: z.boolean().optional(),
    requiresStreaming: z.boolean().optional(),
    workspaceId: NonEmptyStringSchema.optional(),
    notes: z.string().max(2_000).optional(),
  })
  .strict();
export type OrchestrationAssignmentUpsert = z.infer<typeof OrchestrationAssignmentUpsertSchema>;

export const OrchestrationAssignmentStateSchema = z
  .object({
    version: z.literal(ORCHESTRATION_ASSIGNMENT_VERSION),
    assignments: z.array(OrchestrationModelAssignmentSchema),
  })
  .strict();
export type OrchestrationAssignmentState = z.infer<typeof OrchestrationAssignmentStateSchema>;

export function emptyOrchestrationAssignmentState(): OrchestrationAssignmentState {
  return { version: ORCHESTRATION_ASSIGNMENT_VERSION, assignments: [] };
}

export type OrchestrationAssignmentResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export interface OrchestrationAssignmentScope {
  userId?: string;
  workspaceId?: string;
}

export interface OrchestrationAssignmentStore {
  getState(): Promise<OrchestrationAssignmentState>;
  listAssignments(scope?: OrchestrationAssignmentScope): Promise<OrchestrationModelAssignment[]>;
  getAssignment(role: OrchestrationRole, scope?: OrchestrationAssignmentScope): Promise<OrchestrationModelAssignment | undefined>;
  upsertAssignment(role: OrchestrationRole, input: OrchestrationAssignmentUpsert, scope?: OrchestrationAssignmentScope): Promise<OrchestrationAssignmentResult<OrchestrationModelAssignment>>;
  removeAssignment(role: OrchestrationRole, scope?: OrchestrationAssignmentScope): Promise<OrchestrationAssignmentResult<void>>;
  resetAssignments(scope?: OrchestrationAssignmentScope): Promise<OrchestrationAssignmentResult<void>>;
}

export interface OrchestrationAssignmentFs {
  readFile(path: string): Promise<string | undefined>;
  writeFile(path: string, data: string): Promise<void>;
  rename(fromPath: string, toPath: string): Promise<void>;
  mkdir(dirPath: string): Promise<void>;
}

export interface LocalOrchestrationAssignmentStoreOptions {
  filePath: string;
  fsImpl?: OrchestrationAssignmentFs;
}

function defaultAssignmentFs(): OrchestrationAssignmentFs {
  return {
    async readFile(path: string): Promise<string | undefined> {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
        throw error;
      }
    },
    async writeFile(path: string, data: string): Promise<void> {
      await writeFile(path, data, "utf8");
    },
    async rename(fromPath: string, toPath: string): Promise<void> {
      await rename(fromPath, toPath);
    },
    async mkdir(dirPath: string): Promise<void> {
      await mkdir(dirPath, { recursive: true });
    },
  };
}

function toRedactedError(error: unknown): string {
  return redactString(error instanceof Error ? error.message : String(error));
}

function scopeMatches(assignment: OrchestrationModelAssignment, scope: OrchestrationAssignmentScope = {}): boolean {
  return assignment.userId === scope.userId && assignment.workspaceId === scope.workspaceId;
}

export function orchestrationAssignmentId(
  role: OrchestrationRole,
  scope: OrchestrationAssignmentScope = {},
): string {
  const user = scope.userId ?? "default";
  const workspace = scope.workspaceId ?? "default";
  return `${user}:${workspace}:${role}`;
}

function normalizeUpsert(
  role: OrchestrationRole,
  input: OrchestrationAssignmentUpsert,
  existing: OrchestrationModelAssignment | undefined,
  scope: OrchestrationAssignmentScope = {},
  now: string,
): OrchestrationModelAssignment {
  const record: OrchestrationModelAssignment = {
    id: existing?.id ?? orchestrationAssignmentId(role, scope),
    ...(scope.userId ? { userId: scope.userId } : {}),
    ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
    role,
    providerId: input.providerId,
    ...(input.modelId ? { modelId: input.modelId } : {}),
    ...(input.fallbackProviderId ? { fallbackProviderId: input.fallbackProviderId } : {}),
    ...(input.fallbackModelId ? { fallbackModelId: input.fallbackModelId } : {}),
    enabled: input.enabled ?? existing?.enabled ?? true,
    ...(input.maxUsdPerCall !== undefined ? { maxUsdPerCall: input.maxUsdPerCall } : {}),
    ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.requiresJsonMode !== undefined ? { requiresJsonMode: input.requiresJsonMode } : {}),
    ...(input.requiresToolCalling !== undefined ? { requiresToolCalling: input.requiresToolCalling } : {}),
    ...(input.requiresStreaming !== undefined ? { requiresStreaming: input.requiresStreaming } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  return OrchestrationModelAssignmentSchema.parse(record);
}

function createStoreFromAccessors(accessors: {
  readState: () => Promise<OrchestrationAssignmentState>;
  writeState: (state: OrchestrationAssignmentState) => Promise<void>;
}): OrchestrationAssignmentStore {
  return {
    async getState(): Promise<OrchestrationAssignmentState> {
      try {
        return await accessors.readState();
      } catch {
        return emptyOrchestrationAssignmentState();
      }
    },

    async listAssignments(scope: OrchestrationAssignmentScope = {}): Promise<OrchestrationModelAssignment[]> {
      const state = await this.getState();
      return state.assignments.filter((assignment) => scopeMatches(assignment, scope));
    },

    async getAssignment(role: OrchestrationRole, scope: OrchestrationAssignmentScope = {}): Promise<OrchestrationModelAssignment | undefined> {
      const state = await this.getState();
      return findAssignment(state.assignments, role, scope);
    },

    async upsertAssignment(
      role: OrchestrationRole,
      input: OrchestrationAssignmentUpsert,
      scope: OrchestrationAssignmentScope = {},
    ): Promise<OrchestrationAssignmentResult<OrchestrationModelAssignment>> {
      try {
        const parsedRole = OrchestrationRoleSchema.parse(role);
        const parsedInput = OrchestrationAssignmentUpsertSchema.parse(input);
        const state = await accessors.readState();
        const now = new Date().toISOString();
        const existing = findAssignment(state.assignments, parsedRole, scope);
        const nextRecord = normalizeUpsert(parsedRole, parsedInput, existing, scope, now);
        const assignments = state.assignments.filter(
          (assignment) => !(assignment.role === parsedRole && scopeMatches(assignment, scope)),
        );
        assignments.push(nextRecord);
        await accessors.writeState({ version: ORCHESTRATION_ASSIGNMENT_VERSION, assignments });
        return { ok: true, value: nextRecord };
      } catch (error) {
        return { ok: false, error: toRedactedError(error) };
      }
    },

    async removeAssignment(role: OrchestrationRole, scope: OrchestrationAssignmentScope = {}): Promise<OrchestrationAssignmentResult<void>> {
      try {
        const parsedRole = OrchestrationRoleSchema.parse(role);
        const state = await accessors.readState();
        const assignments = state.assignments.filter(
          (assignment) => !(assignment.role === parsedRole && scopeMatches(assignment, scope)),
        );
        await accessors.writeState({ version: ORCHESTRATION_ASSIGNMENT_VERSION, assignments });
        return { ok: true, value: undefined };
      } catch (error) {
        return { ok: false, error: toRedactedError(error) };
      }
    },

    async resetAssignments(scope: OrchestrationAssignmentScope = {}): Promise<OrchestrationAssignmentResult<void>> {
      try {
        const state = await accessors.readState();
        const assignments = state.assignments.filter((assignment) => !scopeMatches(assignment, scope));
        await accessors.writeState({ version: ORCHESTRATION_ASSIGNMENT_VERSION, assignments });
        return { ok: true, value: undefined };
      } catch (error) {
        return { ok: false, error: toRedactedError(error) };
      }
    },
  };
}

function findAssignment(
  assignments: OrchestrationModelAssignment[],
  role: OrchestrationRole,
  scope: OrchestrationAssignmentScope = {},
): OrchestrationModelAssignment | undefined {
  // Workspace-specific assignment wins, then user/default workspace assignment.
  const exact = assignments.find(
    (assignment) => assignment.role === role && scopeMatches(assignment, scope),
  );
  if (exact) return exact;
  if (scope.workspaceId !== undefined) {
    return assignments.find(
      (assignment) =>
        assignment.role === role &&
        assignment.userId === scope.userId &&
        assignment.workspaceId === undefined,
    );
  }
  return undefined;
}

export function createLocalOrchestrationAssignmentStore(
  options: LocalOrchestrationAssignmentStoreOptions,
): OrchestrationAssignmentStore {
  const fsImpl = options.fsImpl ?? defaultAssignmentFs();
  const filePath = options.filePath;

  async function readState(): Promise<OrchestrationAssignmentState> {
    const raw = await fsImpl.readFile(filePath);
    if (raw === undefined || raw.trim() === "") return emptyOrchestrationAssignmentState();
    const parsed = OrchestrationAssignmentStateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : emptyOrchestrationAssignmentState();
  }

  async function writeState(state: OrchestrationAssignmentState): Promise<void> {
    await fsImpl.mkdir(dirname(filePath));
    const tempPath = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
    await fsImpl.writeFile(tempPath, JSON.stringify(state, null, 2));
    await fsImpl.rename(tempPath, filePath);
  }

  return createStoreFromAccessors({ readState, writeState });
}

export function createInMemoryOrchestrationAssignmentStore(
  initial?: OrchestrationAssignmentState,
): OrchestrationAssignmentStore {
  let state = initial ? OrchestrationAssignmentStateSchema.parse(initial) : emptyOrchestrationAssignmentState();
  return createStoreFromAccessors({
    async readState() {
      return structuredClone(state);
    },
    async writeState(next) {
      state = OrchestrationAssignmentStateSchema.parse(structuredClone(next));
    },
  });
}

export interface OrchestrationRoleDescriptor {
  id: OrchestrationRole;
  label: string;
  description: string;
  modelRoute: ModelRoute;
  requiredCapabilities: string[];
  preferredCapabilities: string[];
  optional: boolean;
}

const ROLE_LABELS: Record<OrchestrationRole, string> = {
  triage: "Triage",
  preprocessor: "Preprocessor",
  planner: "Planner",
  skeptic: "Skeptic",
  crucible: "Crucible",
  deepPlanner: "Deep planner",
  taskDecomposer: "Task decomposer",
  validator: "Validator",
  healer: "Healer",
  synthesizer: "Synthesizer",
  directAnswer: "Direct answer",
  ponder: "Ponder",
  embedding: "Embedding",
  reranker: "Reranker",
};

const ROLE_DESCRIPTIONS: Record<OrchestrationRole, string> = {
  triage: "Classifies the request before expensive work starts.",
  preprocessor: "Distills prompt/context into strict JSON and safe tool proposals.",
  planner: "Produces the structured execution plan.",
  skeptic: "Critiques the plan and finds blockers before execution.",
  crucible: "Arbitrates planner and skeptic decisions.",
  deepPlanner: "Explores alternative plans for high-complexity work.",
  taskDecomposer: "Splits high-complexity requests into smaller sub-goals.",
  validator: "Checks execution results and validation evidence.",
  healer: "Repairs failed validation or execution outcomes.",
  synthesizer: "Writes the final evidence-grounded user response.",
  directAnswer: "Answers simple direct questions with a cheap/fast model.",
  ponder: "Reflects on recent memory and extracts lessons.",
  embedding: "Embeds text for memory/search backends.",
  reranker: "Reranks retrieved context before planning.",
};

export const ROLE_MODEL_ROUTES: Readonly<Record<OrchestrationRole, ModelRoute>> = Object.freeze({
  triage: "cheap",
  preprocessor: "cheap",
  planner: "flagship",
  skeptic: "flagship",
  crucible: "flagship",
  deepPlanner: "research",
  taskDecomposer: "fast",
  validator: "fast",
  healer: "flagship",
  synthesizer: "flagship",
  directAnswer: "cheap",
  ponder: "cheap",
  embedding: "cheap",
  reranker: "fast",
});

interface RoleRequirement {
  required: string[];
  preferred: string[];
  optional?: boolean;
  minReasoning?: ModelCapabilities["reasoning"];
  maxCostTier?: ModelCapabilities["costTier"];
  minContextTokens?: number;
}

const ROLE_REQUIREMENTS: Readonly<Record<OrchestrationRole, RoleRequirement>> = Object.freeze({
  triage: { required: ["text"], preferred: ["low-cost"] },
  preprocessor: { required: ["text", "jsonMode"], preferred: ["low-cost"] },
  planner: { required: ["text", "jsonMode"], preferred: ["reasoning", "large-context"], minReasoning: "medium", minContextTokens: 64_000 },
  skeptic: { required: ["text", "jsonMode"], preferred: ["critique", "reasoning"], minReasoning: "medium" },
  crucible: { required: ["text", "jsonMode"], preferred: ["reasoning"], minReasoning: "medium" },
  deepPlanner: { required: ["text", "jsonMode"], preferred: ["high-reasoning", "large-context"], minReasoning: "high", minContextTokens: 64_000 },
  taskDecomposer: { required: ["text", "jsonMode"], preferred: ["fast"] },
  validator: { required: ["text", "jsonMode"], preferred: ["fast"] },
  healer: { required: ["text", "jsonMode"], preferred: ["tool-calling", "reasoning"], minReasoning: "medium" },
  synthesizer: { required: ["text"], preferred: ["prose", "streaming"] },
  directAnswer: { required: ["text"], preferred: ["low-cost", "fast"], maxCostTier: "medium" },
  ponder: { required: ["text"], preferred: ["low-cost"], optional: true, maxCostTier: "low" },
  embedding: { required: ["embeddings"], preferred: ["low-cost"] },
  reranker: { required: ["text"], preferred: ["fast"] },
});

export const ORCHESTRATION_ROLE_DESCRIPTORS: readonly OrchestrationRoleDescriptor[] = ORCHESTRATION_ROLES.map(
  (role) => ({
    id: role,
    label: ROLE_LABELS[role],
    description: ROLE_DESCRIPTIONS[role],
    modelRoute: ROLE_MODEL_ROUTES[role],
    requiredCapabilities: ROLE_REQUIREMENTS[role].required,
    preferredCapabilities: ROLE_REQUIREMENTS[role].preferred,
    optional: ROLE_REQUIREMENTS[role].optional === true,
  }),
);

export interface ProviderModelOption {
  id: string;
  label: string;
  capabilities: ModelCapabilities;
}

export interface ProviderAssignmentOption {
  id: string;
  label: string;
  kind: string;
  models: ProviderModelOption[];
  capabilities: ModelCapabilities;
}

export function providerOptionsFromConfigState(state: ProviderConfigState): ProviderAssignmentOption[] {
  return state.providers.map((record) => {
    const models = availableModelsForRecord(record);
    const capabilities = capabilitiesForProviderRecord(record, record.model);
    return {
      id: record.id,
      label: record.label,
      kind: record.kind,
      models: models.map((modelId) => ({
        id: modelId,
        label: modelId,
        capabilities: capabilitiesForProviderRecord(record, modelId),
      })),
      capabilities,
    };
  });
}

function availableModelsForRecord(record: ProviderConfigRecord): string[] {
  const values = [
    record.model,
    record.models?.flagship,
    record.models?.slm,
    record.azure?.deployment,
    ...(record.manualModels ?? []),
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  const defaults: Record<ProviderConfigRecord["kind"], string[]> = {
    together: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "Qwen/Qwen2.5-Coder-7B-Instruct"],
    cloudflare: ["@cf/meta/llama-3.1-8b-instruct"],
    "azure-openai": ["gpt-4o-mini", "gpt-5"],
    "openai-compatible": [record.model ?? "openai-compatible-model"],
  };
  const all = [...values, ...defaults[record.kind]];
  return [...new Set(all.map((value) => value.trim()).filter(Boolean))];
}

function reasoningRank(value: ModelCapabilities["reasoning"]): number {
  switch (value) {
    case "high": return 3;
    case "medium": return 2;
    case "low": return 1;
    default: return 0;
  }
}

function costTierRank(value: ModelCapabilities["costTier"]): number {
  switch (value) {
    case "high": return 3;
    case "medium": return 2;
    case "low": return 1;
    default: return 0;
  }
}

export function capabilitiesForProviderRecord(
  record: ProviderConfigRecord | undefined,
  modelId?: string,
): ModelCapabilities {
  if (!record) {
    return deterministicCapabilities();
  }
  const model = (modelId ?? record.model ?? "").toLowerCase();
  const embeddings = /embed|embedding|text-embedding/.test(model);
  const highReasoning = /gpt-5|o1|o3|reason|glm|claude|sonnet|opus|deepseek/.test(model);
  const mediumReasoning = highReasoning || /70b|large|gpt-4|qwen2\.5|llama-3\.3/.test(model);

  switch (record.kind) {
    case "cloudflare":
      return ModelCapabilitiesSchema.parse({
        text: !embeddings,
        jsonMode: false,
        toolCalling: false,
        streaming: false,
        embeddings,
        maxContextTokens: 32_000,
        reasoning: "low",
        costTier: "low",
      });
    case "together":
      return ModelCapabilitiesSchema.parse({
        text: !embeddings,
        jsonMode: true,
        toolCalling: false,
        streaming: false,
        embeddings,
        maxContextTokens: 128_000,
        reasoning: mediumReasoning ? "medium" : "low",
        costTier: "low",
      });
    case "azure-openai":
      return ModelCapabilitiesSchema.parse({
        text: !embeddings,
        jsonMode: true,
        toolCalling: true,
        streaming: false,
        embeddings,
        maxContextTokens: 128_000,
        reasoning: highReasoning ? "high" : "medium",
        costTier: highReasoning ? "high" : "medium",
      });
    case "openai-compatible":
      return ModelCapabilitiesSchema.parse({
        text: !embeddings,
        jsonMode: true,
        toolCalling: true,
        streaming: false,
        embeddings,
        maxContextTokens: 128_000,
        reasoning: highReasoning ? "high" : mediumReasoning ? "medium" : "low",
        costTier: "medium",
      });
  }
}

export function deterministicCapabilities(): ModelCapabilities {
  return ModelCapabilitiesSchema.parse({
    text: true,
    jsonMode: true,
    toolCalling: false,
    streaming: false,
    embeddings: true,
    maxContextTokens: 1_000_000,
    reasoning: "none",
    costTier: "free",
  });
}

export interface EffectiveModelRoute {
  role: OrchestrationRole;
  providerId: AssignmentProviderId;
  modelId?: string;
  modelRoute: ModelRoute;
  fallbackProviderId?: AssignmentProviderId;
  fallbackModelId?: string;
  enabled: boolean;
  source: "assignment" | "workspace-default" | "builtin-template" | "deterministic-fallback";
  assignment?: OrchestrationModelAssignment;
  capabilities: ModelCapabilities;
  warnings: CapabilityMismatchWarning[];
  budgetProjection: {
    maxUsdPerCall?: number;
    maxTokens?: number;
    timeoutMs?: number;
    temperature?: number;
    estimatedUsdPerCall?: number;
  };
  deterministicFallbackReason?: string;
}

export const EffectiveModelRouteSchema: z.ZodType<EffectiveModelRoute> = z.lazy(() => z.object({
  role: OrchestrationRoleSchema,
  providerId: AssignmentProviderIdSchema,
  modelId: NonEmptyStringSchema.optional(),
  modelRoute: z.enum(["cheap", "fast", "flagship", "research", "fake"]),
  fallbackProviderId: AssignmentProviderIdSchema.optional(),
  fallbackModelId: NonEmptyStringSchema.optional(),
  enabled: z.boolean(),
  source: z.enum(["assignment", "workspace-default", "builtin-template", "deterministic-fallback"]),
  assignment: OrchestrationModelAssignmentSchema.optional(),
  capabilities: ModelCapabilitiesSchema,
  warnings: z.array(CapabilityMismatchWarningSchema),
  budgetProjection: z.object({
    maxUsdPerCall: z.number().nonnegative().optional(),
    maxTokens: z.number().int().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
    estimatedUsdPerCall: z.number().nonnegative().optional(),
  }).strict(),
  deterministicFallbackReason: z.string().min(1).optional(),
}).strict());

export interface ResolveEffectiveAssignmentInput {
  role: OrchestrationRole;
  assignments?: OrchestrationModelAssignment[];
  providerState?: ProviderConfigState;
  scope?: OrchestrationAssignmentScope;
  includeBuiltInDefault?: boolean;
}

export function resolveEffectiveAssignment(input: ResolveEffectiveAssignmentInput): EffectiveModelRoute {
  const role = OrchestrationRoleSchema.parse(input.role);
  const assignments = input.assignments ?? [];
  const providerState = input.providerState;
  const assignment = findAssignment(assignments, role, input.scope);
  const source: EffectiveModelRoute["source"] = assignment ? "assignment" : "builtin-template";
  const chosen = assignment ?? builtinAssignment(role, input.scope);

  return resolveAssignmentRecord(chosen, source, providerState);
}

function builtinAssignment(role: OrchestrationRole, scope: OrchestrationAssignmentScope = {}): OrchestrationModelAssignment {
  const now = "1970-01-01T00:00:00.000Z";
  return OrchestrationModelAssignmentSchema.parse({
    id: `builtin:${role}`,
    ...(scope.userId ? { userId: scope.userId } : {}),
    ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
    role,
    providerId: "deterministic",
    fallbackProviderId: role === "ponder" ? "disabled" : "deterministic",
    enabled: role !== "ponder",
    maxUsdPerCall: 0,
    createdAt: now,
    updatedAt: now,
  });
}

function resolveAssignmentRecord(
  assignment: OrchestrationModelAssignment,
  source: EffectiveModelRoute["source"],
  providerState?: ProviderConfigState,
): EffectiveModelRoute {
  const providerRecords = providerState?.providers ?? [];
  const modelRoute = ROLE_MODEL_ROUTES[assignment.role];
  const primaryProvider = providerRecords.find((record) => record.id === assignment.providerId);
  const fallbackProvider = providerRecords.find((record) => record.id === assignment.fallbackProviderId);
  const warnings: CapabilityMismatchWarning[] = [];
  let providerId: AssignmentProviderId = assignment.providerId;
  let modelId = assignment.modelId;
  let capabilities = capabilitiesForSelection(assignment.providerId, primaryProvider, modelId);
  let deterministicFallbackReason: string | undefined;

  if (!assignment.enabled || assignment.providerId === "disabled") {
    warnings.push(warning(assignment.role, assignment.providerId, modelId, "provider_disabled", "warning", "Role is disabled; no provider will be called."));
    providerId = "disabled";
  } else if (assignment.providerId !== "deterministic" && !primaryProvider) {
    warnings.push(warning(assignment.role, assignment.providerId, modelId, "provider_missing", "warning", `Provider ${assignment.providerId} is not configured.`));
    if (assignment.fallbackProviderId && assignment.fallbackProviderId !== "disabled") {
      providerId = assignment.fallbackProviderId;
      modelId = assignment.fallbackModelId;
      capabilities = capabilitiesForSelection(assignment.fallbackProviderId, fallbackProvider, modelId);
      warnings.push(warning(assignment.role, providerId, modelId, "fallback_used", "warning", "Primary provider is unavailable; fallback route is selected."));
      if (providerId === "deterministic") {
        deterministicFallbackReason = `Provider ${assignment.providerId} is not configured; deterministic fallback selected.`;
        warnings.push(warning(assignment.role, "deterministic", undefined, "deterministic_fallback", "warning", deterministicFallbackReason));
      }
    } else {
      providerId = "deterministic";
      modelId = undefined;
      capabilities = deterministicCapabilities();
      deterministicFallbackReason = `Provider ${assignment.providerId} is not configured; deterministic fallback selected.`;
      warnings.push(warning(assignment.role, "deterministic", undefined, "deterministic_fallback", "warning", deterministicFallbackReason));
    }
  }

  warnings.push(...capabilityWarnings(assignment, providerId, modelId, capabilities));

  const estimatedUsdPerCall = estimateUsdPerCall(providerId, providerState, modelId);
  return EffectiveModelRouteSchema.parse({
    role: assignment.role,
    providerId,
    ...(modelId ? { modelId } : {}),
    modelRoute,
    ...(assignment.fallbackProviderId ? { fallbackProviderId: assignment.fallbackProviderId } : {}),
    ...(assignment.fallbackModelId ? { fallbackModelId: assignment.fallbackModelId } : {}),
    enabled: assignment.enabled && providerId !== "disabled",
    source,
    ...(source === "assignment" ? { assignment } : {}),
    capabilities,
    warnings,
    budgetProjection: {
      ...(assignment.maxUsdPerCall !== undefined ? { maxUsdPerCall: assignment.maxUsdPerCall } : {}),
      ...(assignment.maxTokens !== undefined ? { maxTokens: assignment.maxTokens } : {}),
      ...(assignment.timeoutMs !== undefined ? { timeoutMs: assignment.timeoutMs } : {}),
      ...(assignment.temperature !== undefined ? { temperature: assignment.temperature } : {}),
      ...(estimatedUsdPerCall !== undefined ? { estimatedUsdPerCall } : {}),
    },
    ...(deterministicFallbackReason ? { deterministicFallbackReason } : {}),
  });
}

function capabilitiesForSelection(
  providerId: AssignmentProviderId,
  providerRecord: ProviderConfigRecord | undefined,
  modelId: string | undefined,
): ModelCapabilities {
  if (providerId === "deterministic") return deterministicCapabilities();
  if (providerId === "disabled") {
    return ModelCapabilitiesSchema.parse({ text: false, jsonMode: false, toolCalling: false, streaming: false, embeddings: false, reasoning: "none", costTier: "free" });
  }
  return capabilitiesForProviderRecord(providerRecord, modelId);
}

function warning(
  role: OrchestrationRole,
  providerId: AssignmentProviderId,
  modelId: string | undefined,
  code: CapabilityMismatchWarning["code"],
  severity: CapabilityMismatchWarning["severity"],
  message: string,
  requiredCapability?: string,
): CapabilityMismatchWarning {
  return CapabilityMismatchWarningSchema.parse({
    role,
    providerId,
    ...(modelId ? { modelId } : {}),
    code,
    severity,
    message,
    ...(requiredCapability ? { requiredCapability } : {}),
  });
}

function capabilityWarnings(
  assignment: OrchestrationModelAssignment,
  providerId: AssignmentProviderId,
  modelId: string | undefined,
  capabilities: ModelCapabilities,
): CapabilityMismatchWarning[] {
  if (providerId === "disabled") return [];
  const req = ROLE_REQUIREMENTS[assignment.role];
  const out: CapabilityMismatchWarning[] = [];
  const jsonRequired = assignment.requiresJsonMode ?? req.required.includes("jsonMode");
  const toolRequired = assignment.requiresToolCalling ?? req.required.includes("toolCalling");
  const streamingRequired = assignment.requiresStreaming ?? req.required.includes("streaming");

  if (req.required.includes("text") && !capabilities.text) {
    out.push(warning(assignment.role, providerId, modelId, "provider_missing", "blocker", "This role requires text generation.", "text"));
  }
  if (jsonRequired && capabilities.jsonMode !== true && assignment.fallbackProviderId !== "deterministic") {
    out.push(warning(assignment.role, providerId, modelId, "json_mode_missing", "blocker", "This role requires JSON mode or a deterministic JSON repair fallback.", "jsonMode"));
  } else if (jsonRequired && capabilities.jsonMode !== true) {
    out.push(warning(assignment.role, providerId, modelId, "json_mode_missing", "warning", "Model does not advertise JSON mode; deterministic repair fallback is configured.", "jsonMode"));
  }
  if (toolRequired && capabilities.toolCalling !== true) {
    out.push(warning(assignment.role, providerId, modelId, "tool_calling_missing", "warning", "Tool calling is preferred/required but not advertised.", "toolCalling"));
  }
  if (streamingRequired && capabilities.streaming !== true) {
    out.push(warning(assignment.role, providerId, modelId, "streaming_missing", "warning", "Streaming is requested but not advertised.", "streaming"));
  }
  if (req.required.includes("embeddings") && capabilities.embeddings !== true) {
    out.push(warning(assignment.role, providerId, modelId, "embeddings_missing", "blocker", "Embedding role requires an embeddings-capable model.", "embeddings"));
  }
  if (providerId === "deterministic") return out;
  if (req.minContextTokens && (capabilities.maxContextTokens ?? 0) < req.minContextTokens) {
    out.push(warning(assignment.role, providerId, modelId, "context_window_low", "warning", `Role prefers at least ${req.minContextTokens} context tokens.`, "maxContextTokens"));
  }
  if (req.minReasoning && reasoningRank(capabilities.reasoning) < reasoningRank(req.minReasoning)) {
    out.push(warning(assignment.role, providerId, modelId, "reasoning_low", "warning", `Role prefers ${req.minReasoning} reasoning or stronger.`, "reasoning"));
  }
  if (req.maxCostTier && costTierRank(capabilities.costTier) > costTierRank(req.maxCostTier)) {
    out.push(warning(assignment.role, providerId, modelId, "cost_tier_high", "warning", `Role prefers ${req.maxCostTier} cost tier or lower.`, "costTier"));
  }
  return out;
}

function estimateUsdPerCall(
  providerId: AssignmentProviderId,
  state: ProviderConfigState | undefined,
  modelId: string | undefined,
): number | undefined {
  if (providerId === "deterministic" || providerId === "disabled") return 0;
  const record = state?.providers.find((candidate) => candidate.id === providerId);
  const tier = capabilitiesForProviderRecord(record, modelId).costTier;
  switch (tier) {
    case "high": return 0.05;
    case "medium": return 0.01;
    case "low": return 0.001;
    case "free": return 0;
    default: return undefined;
  }
}

export function inferOrchestrationRole(input: ModelRouterInput = {}): OrchestrationRole | undefined {
  const task = (input.task ?? "").toLowerCase();
  const route = (input.route ?? "").toUpperCase();
  if (task.includes("preprocessor")) return "preprocessor";
  if (task.includes("deep-planner") || task.includes("deepplanner")) return "deepPlanner";
  if (task.includes("planner")) return "planner";
  if (task.includes("skeptic")) return "skeptic";
  if (task.includes("crucible")) return "crucible";
  if (task.includes("decompos")) return "taskDecomposer";
  if (task.includes("validator") || task.includes("validation")) return "validator";
  if (task.includes("repair") || task.includes("healer") || task.includes("healing")) return "healer";
  if (task.includes("synthesizer") || task.includes("synthesis")) return "synthesizer";
  if (task.includes("direct-answer") || route === "DIRECT_ANSWER") return "directAnswer";
  if (task.includes("ponder")) return "ponder";
  if (task.includes("embedding")) return "embedding";
  if (task.includes("rerank")) return "reranker";
  if (task.includes("triage")) return "triage";
  return undefined;
}

export interface BuildAssignmentAwareRouterInput {
  baseRouter: ModelRouter;
  assignments: OrchestrationModelAssignment[];
  providerState: ProviderConfigState;
  providersByRole?: Partial<Record<OrchestrationRole, LLMProvider>>;
  fallbackProvidersByRole?: Partial<Record<OrchestrationRole, LLMProvider>>;
  fakeProvider?: LLMProvider;
}

export function buildAssignmentAwareModelRouter(input: BuildAssignmentAwareRouterInput): ModelRouter {
  const fakeProvider = input.fakeProvider ?? new FakeLLMProvider();

  return {
    select(routerInput: ModelRouterInput = {}): ModelSelection {
      const role = inferOrchestrationRole(routerInput);
      if (!role) return input.baseRouter.select(routerInput);
      const assignment = input.assignments.find((candidate) => candidate.role === role);
      if (!assignment) return input.baseRouter.select(routerInput);
      const effective = resolveAssignmentRecord(assignment, "assignment", input.providerState);
      const modelRoute = effective.modelRoute;
      if (!effective.enabled || effective.providerId === "disabled" || effective.providerId === "deterministic") {
        return {
          provider: fakeProvider,
          modelRoute: "fake",
          model: effective.modelId ?? fakeProvider.metadata.models.fake,
          reason: `orchestration assignment ${role} uses ${effective.providerId}`,
        };
      }
      const assignedProvider = input.providersByRole?.[role];
      if (assignedProvider) {
        return {
          provider: assignedProvider,
          modelRoute,
          model: effective.modelId ?? assignedProvider.metadata.models[modelRoute] ?? Object.values(assignedProvider.metadata.models)[0] ?? assignedProvider.metadata.id,
          reason: `orchestration assignment ${role} -> ${effective.providerId}`,
        };
      }
      const fallbackProvider = input.fallbackProvidersByRole?.[role];
      if (fallbackProvider) {
        return {
          provider: fallbackProvider,
          modelRoute,
          model: effective.fallbackModelId ?? fallbackProvider.metadata.models[modelRoute] ?? Object.values(fallbackProvider.metadata.models)[0] ?? fallbackProvider.metadata.id,
          reason: `orchestration assignment ${role} fallback -> ${effective.fallbackProviderId}`,
        };
      }
      return input.baseRouter.select(routerInput);
    },
  };
}

export interface BuildConfiguredAssignmentAwareRouterOptions {
  baseRouter: ModelRouter;
  assignmentStore: OrchestrationAssignmentStore;
  providerConfigStore: ProviderConfigStore;
  secrets: SecretStore;
  scope?: OrchestrationAssignmentScope;
  enableNetwork?: boolean;
  fetchImpl?: typeof fetch;
}

export async function buildConfiguredAssignmentAwareRouter(
  options: BuildConfiguredAssignmentAwareRouterOptions,
): Promise<ModelRouter> {
  const assignments = await options.assignmentStore.listAssignments(options.scope);
  const providerState = await options.providerConfigStore.getState();
  const providersByRole: Partial<Record<OrchestrationRole, LLMProvider>> = {};
  const fallbackProvidersByRole: Partial<Record<OrchestrationRole, LLMProvider>> = {};

  await Promise.all(assignments.map(async (assignment) => {
    if (assignment.providerId !== "deterministic" && assignment.providerId !== "disabled") {
      const provider = await resolveTestProvider(
        assignment.providerId,
        options.providerConfigStore,
        options.secrets,
        { enableNetwork: options.enableNetwork, fetchImpl: options.fetchImpl },
        assignment.modelId ? { model: assignment.modelId, deployment: assignment.modelId } : {},
      );
      if (provider) providersByRole[assignment.role] = provider;
    }
    if (assignment.fallbackProviderId && assignment.fallbackProviderId !== "deterministic" && assignment.fallbackProviderId !== "disabled") {
      const provider = await resolveTestProvider(
        assignment.fallbackProviderId,
        options.providerConfigStore,
        options.secrets,
        { enableNetwork: options.enableNetwork, fetchImpl: options.fetchImpl },
        assignment.fallbackModelId ? { model: assignment.fallbackModelId, deployment: assignment.fallbackModelId } : {},
      );
      if (provider) fallbackProvidersByRole[assignment.role] = provider;
    }
  }));

  return buildAssignmentAwareModelRouter({
    baseRouter: options.baseRouter,
    assignments,
    providerState,
    providersByRole,
    fallbackProvidersByRole,
  });
}

export interface OrchestrationModelRouter {
  resolve(role: OrchestrationRole, context?: OrchestrationAssignmentScope): Promise<EffectiveModelRoute>;
}

export function createOrchestrationModelRouter(input: {
  store: OrchestrationAssignmentStore;
  providerConfigStore: ProviderConfigStore;
}): OrchestrationModelRouter {
  return {
    async resolve(role: OrchestrationRole, context: OrchestrationAssignmentScope = {}): Promise<EffectiveModelRoute> {
      const [assignments, providerState] = await Promise.all([
        input.store.listAssignments(context),
        input.providerConfigStore.getState(),
      ]);
      return resolveEffectiveAssignment({ role, assignments, providerState, scope: context });
    },
  };
}
