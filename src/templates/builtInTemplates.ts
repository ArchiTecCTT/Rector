import { RectorTemplateSchema, type RectorTemplate } from "./templateSchema";
import { ORCHESTRATION_ROLES, type OrchestrationRole } from "../providers/orchestrationAssignments";
import { MEMORY_ROLES, type MemoryRole } from "../providers/memoryAssignments";

const BUILTIN_TIMESTAMP = "2026-06-12T00:00:00.000Z";

function deterministicRole(role: OrchestrationRole): RectorTemplate["orchestrationAssignments"][number] {
  return {
    role,
    providerId: role === "ponder" || role === "embedding" || role === "reranker" ? "disabled" : "deterministic",
    enabled: !(role === "ponder" || role === "embedding" || role === "reranker"),
    fallbackProviderId: "deterministic",
    timeoutMs: 5_000,
    notes: "Provider-free deterministic baseline.",
  };
}

function localMemory(role: MemoryRole): RectorTemplate["memoryAssignments"][number] {
  return {
    role,
    providerRecordId: role === "vectorSearch" ? "disabled" : "local",
    providerKind: role === "vectorSearch" ? "local-keyword-fallback" : "local-sqlite-mem",
    enabled: role !== "vectorSearch",
    fallbackProviderRecordId: "local",
    retentionPolicy: role === "conversationStore" ? "session" : "durable",
    maxUsdPerDay: 0,
    notes: role === "vectorSearch" ? "Vector search disabled; keyword/local recall remains available." : "Local-only memory.",
  };
}

function roleAssignment(
  role: OrchestrationRole,
  providerId: string,
  modelId: string,
  opts: Partial<RectorTemplate["orchestrationAssignments"][number]> = {},
): RectorTemplate["orchestrationAssignments"][number] {
  return {
    role,
    providerId,
    modelId,
    enabled: true,
    fallbackProviderId: "deterministic",
    timeoutMs: 30_000,
    ...opts,
  };
}

function memoryAssignment(
  role: MemoryRole,
  providerRecordId: string,
  providerKind: string,
  opts: Partial<RectorTemplate["memoryAssignments"][number]> = {},
): RectorTemplate["memoryAssignments"][number] {
  return {
    role,
    providerRecordId,
    providerKind,
    enabled: true,
    fallbackProviderRecordId: "local",
    retentionPolicy: "durable",
    maxUsdPerDay: 0,
    ...opts,
  };
}

/** Internal test/contributor profile — excluded from user-facing template list APIs. */
const testProfile: RectorTemplate = {
  schemaVersion: "rector.template.v1",
  id: "__test_profile__",
  name: "Test Profile",
  description: "Deterministic orchestration and local memory for contributor tests and CI spy pipelines. Not shown in the product template picker.",
  author: "Rector",
  tags: ["built-in", "internal", "tests", "zero-network"],
  intendedUse: ["contributor baseline", "tests", "CI spy pipeline"],
  riskLevel: "local",
  orchestrationAssignments: ORCHESTRATION_ROLES.map(deterministicRole),
  memoryAssignments: MEMORY_ROLES.map(localMemory),
  moduleToggles: [
    { moduleId: "neuro-alive", enabled: false, notes: "Disables ponder/proactive background enrichments for zero-cost local mode." },
    { moduleId: "neuro-planning", enabled: true },
    { moduleId: "neuro-preprocess", enabled: true },
  ],
  sandboxPolicy: {
    mode: "fake",
    network: "disabled",
    allowlist: [],
    requireApprovalFor: ["write", "delete", "shell"],
    notes: "No external sandbox or network calls.",
  },
  budgets: {
    estimatedCostTier: "free",
    maxUsdPerRun: 0,
    maxUsdPerDay: 0,
    maxUsdPerMonth: 0,
    maxPonderUsdPerDay: 0,
  },
  requiredProviderKinds: [],
  requiredCapabilities: [],
  createdAt: BUILTIN_TIMESTAMP,
  updatedAt: BUILTIN_TIMESTAMP,
};

const cheapByok: RectorTemplate = {
  schemaVersion: "rector.template.v1",
  id: "cheap-byok",
  name: "Cheap BYOK",
  description: "Low-cost daily setup: fast cheap models for triage/preprocessing/ponder and mid-tier models for planning, review, and synthesis.",
  author: "Rector",
  tags: ["built-in", "byok", "low-cost"],
  intendedUse: ["daily coding", "cost-conscious external mode"],
  riskLevel: "low",
  orchestrationAssignments: [
    roleAssignment("triage", "openai-compatible:cheap", "fast-small", { maxUsdPerCall: 0.002, maxTokens: 2_000 }),
    roleAssignment("preprocessor", "openai-compatible:cheap", "fast-json", { requiresJsonMode: true, maxUsdPerCall: 0.003 }),
    roleAssignment("planner", "openai-compatible:mid", "mid-reasoning", { requiresJsonMode: true, maxUsdPerCall: 0.04, maxTokens: 8_000 }),
    roleAssignment("skeptic", "openai-compatible:mid", "mid-critic", { requiresJsonMode: true, maxUsdPerCall: 0.025 }),
    roleAssignment("crucible", "deterministic", "local-policy", { providerId: "deterministic", maxUsdPerCall: 0 }),
    roleAssignment("deepPlanner", "disabled", "disabled", { enabled: false }),
    roleAssignment("taskDecomposer", "openai-compatible:cheap", "fast-json", { requiresJsonMode: true, maxUsdPerCall: 0.004 }),
    roleAssignment("validator", "deterministic", "local-validator", { providerId: "deterministic", maxUsdPerCall: 0 }),
    roleAssignment("healer", "openai-compatible:mid", "mid-coder", { maxUsdPerCall: 0.03 }),
    roleAssignment("synthesizer", "openai-compatible:mid", "mid-prose", { requiresStreaming: true, maxUsdPerCall: 0.02 }),
    roleAssignment("directAnswer", "openai-compatible:cheap", "fast-small", { maxUsdPerCall: 0.004 }),
    roleAssignment("ponder", "openai-compatible:cheap", "fast-summary", { maxUsdPerCall: 0.001, maxTokens: 1_500 }),
    roleAssignment("embedding", "disabled", "disabled", { enabled: false }),
    roleAssignment("reranker", "disabled", "disabled", { enabled: false }),
  ],
  memoryAssignments: [
    memoryAssignment("conversationStore", "local", "local-sqlite-mem"),
    memoryAssignment("episodicMemory", "local", "local-sqlite-mem"),
    memoryAssignment("semanticMemory", "local", "local-sqlite-mem"),
    memoryAssignment("truthLibrary", "local", "local-sqlite-mem"),
    memoryAssignment("vectorSearch", "chroma:optional", "chroma", { enabled: false, fallbackProviderRecordId: "local" }),
    memoryAssignment("reflectionLessons", "local", "local-sqlite-mem"),
    memoryAssignment("artifactIndex", "local", "local-sqlite-mem"),
  ],
  moduleToggles: [{ moduleId: "neuro-alive", enabled: true }, { moduleId: "neuro-planning", enabled: true }],
  sandboxPolicy: {
    mode: "local-safe",
    network: "disabled",
    allowlist: [],
    requireApprovalFor: ["write", "delete", "shell"],
    notes: "Use local safe sandbox unless an external sandbox is configured later.",
  },
  budgets: {
    estimatedCostTier: "low",
    maxUsdPerRun: 0.15,
    maxUsdPerDay: 3,
    maxUsdPerMonth: 50,
    maxPonderUsdPerDay: 0.25,
  },
  requiredProviderKinds: ["openai-compatible"],
  requiredCapabilities: ["text", "jsonMode"],
  createdAt: BUILTIN_TIMESTAMP,
  updatedAt: BUILTIN_TIMESTAMP,
};

const premiumEngineering: RectorTemplate = {
  schemaVersion: "rector.template.v1",
  id: "premium-engineering",
  name: "Premium Engineering",
  description: "High-quality autonomous coding setup with strong reasoning for planning/review, polished synthesis, external sandbox when configured, and durable/vector memory when available.",
  author: "Rector",
  tags: ["built-in", "premium", "engineering", "autonomous"],
  intendedUse: ["complex coding", "autonomous engineering", "review-heavy work"],
  riskLevel: "high",
  orchestrationAssignments: [
    roleAssignment("triage", "openai-compatible:fast", "fast-small", { maxUsdPerCall: 0.004 }),
    roleAssignment("preprocessor", "openai-compatible:fast", "fast-json", { requiresJsonMode: true, maxUsdPerCall: 0.006 }),
    roleAssignment("planner", "azure-openai:flagship", "strong-reasoning", { requiresJsonMode: true, requiresToolCalling: true, maxUsdPerCall: 0.25, maxTokens: 16_000 }),
    roleAssignment("skeptic", "azure-openai:critic", "strong-critic", { requiresJsonMode: true, maxUsdPerCall: 0.18 }),
    roleAssignment("crucible", "azure-openai:critic", "strong-arbiter", { requiresJsonMode: true, maxUsdPerCall: 0.12 }),
    roleAssignment("deepPlanner", "azure-openai:flagship", "strong-reasoning-high", { requiresJsonMode: true, maxUsdPerCall: 0.5, maxTokens: 32_000 }),
    roleAssignment("taskDecomposer", "azure-openai:flagship", "strong-json", { requiresJsonMode: true, maxUsdPerCall: 0.12 }),
    roleAssignment("validator", "openai-compatible:mid", "mid-validator", { requiresJsonMode: true, maxUsdPerCall: 0.03 }),
    roleAssignment("healer", "azure-openai:flagship", "strong-coder", { maxUsdPerCall: 0.25 }),
    roleAssignment("synthesizer", "azure-openai:prose", "polished-prose", { requiresStreaming: true, maxUsdPerCall: 0.12 }),
    roleAssignment("directAnswer", "openai-compatible:mid", "mid-prose", { maxUsdPerCall: 0.03 }),
    roleAssignment("ponder", "openai-compatible:cheap", "fast-summary", { maxUsdPerCall: 0.002, maxTokens: 2_000 }),
    roleAssignment("embedding", "openai-compatible:embedding", "text-embedding", { maxUsdPerCall: 0.002 }),
    roleAssignment("reranker", "openai-compatible:reranker", "reranker", { maxUsdPerCall: 0.004 }),
  ],
  memoryAssignments: [
    memoryAssignment("conversationStore", "local", "local-sqlite-mem"),
    memoryAssignment("episodicMemory", "mem0:main", "mem0", { maxUsdPerDay: 2 }),
    memoryAssignment("semanticMemory", "chroma:main", "chroma", { maxUsdPerDay: 1 }),
    memoryAssignment("truthLibrary", "tidb-memory:main", "tidb-memory", { maxUsdPerDay: 2 }),
    memoryAssignment("vectorSearch", "chroma:main", "chroma", { maxUsdPerDay: 1 }),
    memoryAssignment("reflectionLessons", "mem0:main", "mem0", { maxUsdPerDay: 1 }),
    memoryAssignment("artifactIndex", "local", "local-sqlite-mem"),
  ],
  moduleToggles: [
    { moduleId: "neuro-alive", enabled: true },
    { moduleId: "neuro-planning", enabled: true },
    { moduleId: "neuro-preprocess", enabled: true },
  ],
  sandboxPolicy: {
    mode: "e2b",
    network: "allowlisted",
    allowlist: ["package registries", "documentation domains"],
    requireApprovalFor: ["delete", "shell", "network-egress"],
    notes: "Use E2B if configured; otherwise keep local safe fallback.",
  },
  budgets: {
    estimatedCostTier: "high",
    maxUsdPerRun: 2.5,
    maxUsdPerDay: 25,
    maxUsdPerMonth: 400,
    maxPonderUsdPerDay: 1,
  },
  requiredProviderKinds: ["azure-openai", "openai-compatible", "mem0", "chroma", "tidb-memory"],
  requiredCapabilities: ["text", "jsonMode", "toolCalling", "streaming", "reasoning", "vectorSearch"],
  createdAt: BUILTIN_TIMESTAMP,
  updatedAt: BUILTIN_TIMESTAMP,
};

const privacyFirst: RectorTemplate = {
  schemaVersion: "rector.template.v1",
  id: "privacy-first",
  name: "Privacy First",
  description: "Local-first configuration with external model and memory calls disabled unless the user explicitly replaces assignments later.",
  author: "Rector",
  tags: ["built-in", "privacy", "local", "zero-network"],
  intendedUse: ["sensitive code", "offline/local workflows", "auditable baseline"],
  riskLevel: "local",
  orchestrationAssignments: ORCHESTRATION_ROLES.map((role) => ({
    ...deterministicRole(role),
    providerId: role === "directAnswer" || role === "synthesizer" ? "deterministic" : deterministicRole(role).providerId,
    notes: "External model calls disabled by privacy-first preset.",
  })),
  memoryAssignments: MEMORY_ROLES.map(localMemory),
  moduleToggles: [
    { moduleId: "neuro-alive", enabled: false, notes: "Avoid background external-style activity." },
    { moduleId: "neuro-planning", enabled: true },
    { moduleId: "neuro-preprocess", enabled: true },
  ],
  sandboxPolicy: {
    mode: "local-safe",
    network: "disabled",
    allowlist: [],
    requireApprovalFor: ["write", "delete", "shell", "network-egress"],
    notes: "Strict no-network sandbox defaults.",
  },
  budgets: {
    estimatedCostTier: "free",
    maxUsdPerRun: 0,
    maxUsdPerDay: 0,
    maxUsdPerMonth: 0,
    maxPonderUsdPerDay: 0,
    notes: "External services disabled by default.",
  },
  requiredProviderKinds: [],
  requiredCapabilities: [],
  createdAt: BUILTIN_TIMESTAMP,
  updatedAt: BUILTIN_TIMESTAMP,
};

const researchHeavy: RectorTemplate = {
  schemaVersion: "rector.template.v1",
  id: "research-heavy",
  name: "Research Heavy",
  description: "Context and research-focused setup with strong long-context planning, citation-aware synthesis, vector recall, and truth-library emphasis.",
  author: "Rector",
  tags: ["built-in", "research", "context", "citations"],
  intendedUse: ["research", "large context gathering", "citation-heavy answers"],
  riskLevel: "medium",
  orchestrationAssignments: [
    roleAssignment("triage", "openai-compatible:cheap", "fast-small", { maxUsdPerCall: 0.003 }),
    roleAssignment("preprocessor", "openai-compatible:context", "context-json", { requiresJsonMode: true, maxUsdPerCall: 0.02 }),
    roleAssignment("planner", "openai-compatible:context", "long-context-reasoning", { requiresJsonMode: true, maxUsdPerCall: 0.2, maxTokens: 24_000 }),
    roleAssignment("skeptic", "openai-compatible:critic", "research-critic", { requiresJsonMode: true, maxUsdPerCall: 0.08 }),
    roleAssignment("crucible", "openai-compatible:critic", "research-arbiter", { requiresJsonMode: true, maxUsdPerCall: 0.08 }),
    roleAssignment("deepPlanner", "openai-compatible:context", "long-context-deep", { requiresJsonMode: true, maxUsdPerCall: 0.35, maxTokens: 48_000 }),
    roleAssignment("taskDecomposer", "openai-compatible:context", "context-json", { requiresJsonMode: true, maxUsdPerCall: 0.03 }),
    roleAssignment("validator", "deterministic", "local-validator", { providerId: "deterministic", maxUsdPerCall: 0 }),
    roleAssignment("healer", "openai-compatible:mid", "mid-coder", { maxUsdPerCall: 0.04 }),
    roleAssignment("synthesizer", "openai-compatible:citation", "citation-aware-prose", { requiresStreaming: true, maxUsdPerCall: 0.1 }),
    roleAssignment("directAnswer", "openai-compatible:citation", "citation-aware-prose", { maxUsdPerCall: 0.06 }),
    roleAssignment("ponder", "openai-compatible:cheap", "fast-summary", { maxUsdPerCall: 0.002 }),
    roleAssignment("embedding", "openai-compatible:embedding", "text-embedding", { maxUsdPerCall: 0.002 }),
    roleAssignment("reranker", "openai-compatible:reranker", "reranker", { maxUsdPerCall: 0.004 }),
  ],
  memoryAssignments: [
    memoryAssignment("conversationStore", "local", "local-sqlite-mem"),
    memoryAssignment("episodicMemory", "local", "local-sqlite-mem"),
    memoryAssignment("semanticMemory", "chroma:research", "chroma", { maxUsdPerDay: 1 }),
    memoryAssignment("truthLibrary", "tidb-memory:research", "tidb-memory", { maxUsdPerDay: 2 }),
    memoryAssignment("vectorSearch", "chroma:research", "chroma", { maxUsdPerDay: 1 }),
    memoryAssignment("reflectionLessons", "local", "local-sqlite-mem"),
    memoryAssignment("artifactIndex", "local", "local-sqlite-mem"),
  ],
  moduleToggles: [
    { moduleId: "neuro-alive", enabled: true },
    { moduleId: "neuro-planning", enabled: true },
    { moduleId: "neuro-preprocess", enabled: true },
  ],
  sandboxPolicy: {
    mode: "local-safe",
    network: "allowlisted",
    allowlist: ["documentation domains", "research sources"],
    requireApprovalFor: ["shell", "delete", "network-egress"],
    notes: "Research workflows may need selected outbound fetches; keep them allowlisted.",
  },
  budgets: {
    estimatedCostTier: "medium",
    maxUsdPerRun: 1.25,
    maxUsdPerDay: 15,
    maxUsdPerMonth: 200,
    maxPonderUsdPerDay: 0.75,
  },
  requiredProviderKinds: ["openai-compatible", "chroma", "tidb-memory"],
  requiredCapabilities: ["text", "jsonMode", "streaming", "longContext", "vectorSearch"],
  createdAt: BUILTIN_TIMESTAMP,
  updatedAt: BUILTIN_TIMESTAMP,
};

const personalPlaceholder: RectorTemplate = {
  schemaVersion: "rector.template.v1",
  id: "personal-template-placeholder",
  name: "Personal Template Placeholder",
  description: "Starter/example slot for a user's exported setup. Save current configuration to create a real personal template.",
  author: "Rector",
  tags: ["built-in", "personal", "placeholder"],
  intendedUse: ["starting point", "export example"],
  riskLevel: "low",
  orchestrationAssignments: [],
  memoryAssignments: [],
  moduleToggles: [],
  sandboxPolicy: {
    mode: "local-safe",
    network: "disabled",
    allowlist: [],
    requireApprovalFor: ["write", "delete", "shell"],
  },
  budgets: {
    estimatedCostTier: "free",
    maxUsdPerRun: 0,
    maxUsdPerDay: 0,
    maxUsdPerMonth: 0,
  },
  requiredProviderKinds: [],
  requiredCapabilities: [],
  createdAt: BUILTIN_TIMESTAMP,
  updatedAt: BUILTIN_TIMESTAMP,
};

export const BUILT_IN_TEMPLATES: readonly RectorTemplate[] = Object.freeze(
  [testProfile, cheapByok, premiumEngineering, privacyFirst, researchHeavy, personalPlaceholder].map((template) =>
    RectorTemplateSchema.parse(template),
  ),
);

/** Built-in templates hidden from user-facing list/picker APIs (tests/internal only). */
export const INTERNAL_TEMPLATE_IDS = new Set<string>(["__test_profile__"]);

export function getBuiltInTemplate(id: string): RectorTemplate | undefined {
  const found = BUILT_IN_TEMPLATES.find((template) => template.id === id);
  return found ? structuredClone(found) : undefined;
}

export function listBuiltInTemplates(): RectorTemplate[] {
  return structuredClone([...BUILT_IN_TEMPLATES]);
}
