import { z } from "zod";
import {
  OrchestrationModelAssignmentSchema,
  type OrchestrationAssignmentScope,
  type OrchestrationAssignmentStore,
  type OrchestrationModelAssignment,
} from "../providers/orchestrationAssignments";
import {
  MemoryRoleAssignmentSchema,
  type MemoryRoleAssignment,
} from "../providers/memoryAssignments";
import type { MemoryAssignmentFilter, MemoryAssignmentStore } from "../providers/memoryAssignmentStore";
import type { ProviderConfigRecord } from "../providers/config";
import type { ProviderConfigStore } from "../providers/configStore";
import type { MemoryProviderRecord } from "../providers/memoryConfig";
import type { MemoryConfigStore } from "../providers/memoryConfigStore";
import type { SecretStore } from "../security/secretStore";
import type { ModuleConfigStore } from "../modules/moduleConfigStore";
import { ModuleConfigStateSchema } from "../modules/moduleConfig";
import { BUILT_IN_TEMPLATES, getBuiltInTemplate, INTERNAL_TEMPLATE_IDS, listBuiltInTemplates } from "./builtInTemplates";
import {
  RectorTemplateSchema,
  TEMPLATE_SCHEMA_VERSION,
  parseRectorTemplate,
  validateRectorTemplate,
  type RectorTemplate,
  type TemplateBudgetPolicy,
  type TemplateMemoryAssignment,
  type TemplateModuleToggle,
  type TemplateOrchestrationAssignment,
  type TemplateValidationIssue,
  type TemplateValidationResult,
} from "./templateSchema";

export type TemplateApplyMode = "previewOnly" | "mergeMissing" | "replaceAssignments" | "saveAsDraft";

export interface TemplatePreviewChange<TTemplateAssignment, TCurrentAssignment> {
  role: string;
  action: "add" | "replace" | "preserve" | "remove";
  from: TCurrentAssignment | null;
  to: TTemplateAssignment | null;
}

export interface TemplateMissingProviderConfig {
  providerId?: string;
  providerKind?: string;
  reason: string;
}

export interface TemplateMissingSecretRequirement {
  providerId?: string;
  providerKind?: string;
  label?: string;
  reason: string;
}

export interface TemplateCapabilityMismatch {
  capability: string;
  reason: string;
}

export interface TemplatePreview {
  template: RectorTemplate;
  valid: boolean;
  validationIssues: TemplateValidationIssue[];
  changes: {
    orchestrationAssignments: Array<TemplatePreviewChange<TemplateOrchestrationAssignment, OrchestrationModelAssignment>>;
    memoryAssignments: Array<TemplatePreviewChange<TemplateMemoryAssignment, MemoryRoleAssignment>>;
    moduleToggles: Array<TemplatePreviewChange<TemplateModuleToggle, TemplateModuleToggle>>;
  };
  missingProviderConfigs: TemplateMissingProviderConfig[];
  missingSecrets: TemplateMissingSecretRequirement[];
  capabilityMismatches: TemplateCapabilityMismatch[];
  externalNetworkImplications: string[];
  estimatedCostTier: "free" | "low" | "medium" | "high";
  warnings: string[];
  rollbackSnapshotId?: string;
}

export interface TemplateApplyResult {
  applied: boolean;
  mode: TemplateApplyMode;
  template: RectorTemplate;
  preview: TemplatePreview;
  changed: {
    orchestrationAssignments: number;
    memoryAssignments: number;
    moduleToggles: number;
  };
  skipped: string[];
  savedTemplate?: RectorTemplate;
}

export interface TemplateApplyOptions {
  mode?: TemplateApplyMode;
  confirmReplace?: boolean;
  scopeId?: string;
  saveAsId?: string;
  saveAsName?: string;
  description?: string;
}

export interface TemplateExportOptions {
  scopeId?: string;
  id?: string;
  name?: string;
  description?: string;
  author?: string;
  tags?: string[];
  intendedUse?: string[];
}

export interface TemplateSecretFinding {
  path: string;
  reason: string;
}

export interface TemplateSecretScanResult {
  ok: boolean;
  findings: TemplateSecretFinding[];
}

export class TemplateImportSecretError extends Error {
  readonly findings: TemplateSecretFinding[];

  constructor(findings: TemplateSecretFinding[]) {
    super(`Template import rejected because it contains secret-like fields or values.`);
    this.name = "TemplateImportSecretError";
    this.findings = findings;
  }
}

export interface UserTemplateStore {
  list(scopeId?: string): Promise<RectorTemplate[]>;
  get(id: string, scopeId?: string): Promise<RectorTemplate | undefined>;
  save(template: RectorTemplate, scopeId?: string): Promise<RectorTemplate>;
}

function scopeKey(scopeId: string | undefined): string {
  return scopeId && scopeId.trim().length > 0 ? scopeId : "default";
}

export function createInMemoryUserTemplateStore(initial: readonly RectorTemplate[] = []): UserTemplateStore {
  const byScope = new Map<string, Map<string, RectorTemplate>>();
  const defaultScope = new Map<string, RectorTemplate>();
  for (const template of initial) defaultScope.set(template.id, RectorTemplateSchema.parse(template));
  byScope.set("default", defaultScope);

  function mapFor(scopeId: string | undefined): Map<string, RectorTemplate> {
    const key = scopeKey(scopeId);
    let map = byScope.get(key);
    if (!map) {
      map = new Map<string, RectorTemplate>();
      byScope.set(key, map);
    }
    return map;
  }

  return {
    async list(scopeId?: string): Promise<RectorTemplate[]> {
      return structuredClone([...mapFor(scopeId).values()]);
    },
    async get(id: string, scopeId?: string): Promise<RectorTemplate | undefined> {
      const template = mapFor(scopeId).get(id);
      return template ? structuredClone(template) : undefined;
    },
    async save(template: RectorTemplate, scopeId?: string): Promise<RectorTemplate> {
      const parsed = RectorTemplateSchema.parse(template);
      mapFor(scopeId).set(parsed.id, parsed);
      return structuredClone(parsed);
    },
  };
}

export interface TemplateServiceDeps {
  orchestrationAssignmentStore: OrchestrationAssignmentStore;
  memoryAssignmentStore: MemoryAssignmentStore;
  providerConfigStore: ProviderConfigStore;
  memoryConfigStore: MemoryConfigStore;
  secretStore: SecretStore;
  moduleConfigStore?: ModuleConfigStore;
  userTemplateStore?: UserTemplateStore;
  now?: () => string;
}

export interface CurrentTemplateConfig {
  orchestrationAssignments: OrchestrationModelAssignment[];
  memoryAssignments: MemoryRoleAssignment[];
  moduleToggles: TemplateModuleToggle[];
  providerRecords: ProviderConfigRecord[];
  memoryProviderRecords: MemoryProviderRecord[];
}

const SECRET_KEYWORDS = [
  "apikey",
  "secret",
  "password",
  "passwd",
  "authorization",
  "cookie",
  "connectionstring",
  "privatekey",
  "accesskey",
  "refreshtoken",
  "clientsecret",
] as const;
const SECRET_VALUE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /(?:^|[^A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}(?:$|[^A-Za-z0-9_-])/, reason: "OpenAI-style API key" },
  { pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/, reason: "Google API key" },
  { pattern: /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/, reason: "GitHub token" },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, reason: "private key block" },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/i, reason: "Authorization bearer token" },
  { pattern: /\b(?:api[-_]?key|token|password|secret)=([^\s,;&]{8,})/i, reason: "inline credential assignment" },
  { pattern: /\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/, reason: "JWT-like token" },
];

function pathOf(parts: readonly string[]): string {
  return parts.length ? parts.join(".") : "template";
}

export function scanTemplateForSecrets(input: unknown): TemplateSecretScanResult {
  const findings: TemplateSecretFinding[] = [];
  const seen = new WeakSet<object>();

  function walk(value: unknown, parts: string[]): void {
    if (typeof value === "string") {
      for (const { pattern, reason } of SECRET_VALUE_PATTERNS) {
        if (pattern.test(value)) findings.push({ path: pathOf(parts), reason });
      }
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      value.forEach((child, index) => walk(child, [...parts, String(index)]));
      return;
    }

    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const compactKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      const tokenLike = compactKey === "token" || compactKey.endsWith("token");
      if (tokenLike || SECRET_KEYWORDS.some((keyword) => compactKey.includes(keyword))) {
        findings.push({ path: pathOf([...parts, key]), reason: `secret-like field name "${key}"` });
      }
      walk(child, [...parts, key]);
    }
  }

  walk(input, []);
  return { ok: findings.length === 0, findings };
}

class TemplateMalformedJsonError extends Error {
  constructor(message = "Template JSON is malformed.") {
    super(message);
    this.name = "TemplateMalformedJsonError";
  }
}

function parseTemplateJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new TemplateMalformedJsonError();
  }
}

function normalizeTemplateInput(input: unknown): unknown {
  if (typeof input === "string") return parseTemplateJson(input);
  if (input && typeof input === "object" && "template" in input) {
    const nested = (input as { template: unknown }).template;
    return typeof nested === "string" ? parseTemplateJson(nested) : nested;
  }
  return input;
}

function safeNormalizeTemplateInput(input: unknown): { ok: true; value: unknown } | { ok: false; issue: TemplateValidationIssue } {
  try {
    return { ok: true, value: normalizeTemplateInput(input) };
  } catch (error) {
    if (error instanceof TemplateMalformedJsonError) {
      return { ok: false, issue: { path: "template", message: error.message } };
    }
    throw error;
  }
}

function validateNormalizedTemplate(raw: unknown): TemplateValidationResult {
  const scan = scanTemplateForSecrets(raw);
  const schemaResult = validateRectorTemplate(raw);
  if (scan.ok && schemaResult.ok) return { ok: true, issues: [] };
  return {
    ok: false,
    issues: [
      ...scan.findings.map((finding) => ({ path: finding.path, message: finding.reason })),
      ...schemaResult.issues,
    ],
  };
}

function cloneTemplate(template: RectorTemplate): RectorTemplate {
  return structuredClone(template);
}

function costTierFromBudget(budget: TemplateBudgetPolicy | undefined): "free" | "low" | "medium" | "high" {
  return budget?.estimatedCostTier ?? "free";
}

function isExternalProviderKind(kind: string | undefined): boolean {
  if (!kind) return false;
  return !(kind === "deterministic" || kind === "disabled" || kind === "local" || kind.startsWith("local"));
}

function isExternalProviderId(providerId: string | undefined): boolean {
  if (!providerId) return false;
  return !(providerId === "deterministic" || providerId === "disabled" || providerId === "local");
}

const CAPABILITIES_BY_KIND: Record<string, readonly string[]> = {
  deterministic: ["text", "jsonMode"],
  "azure-openai": ["text", "jsonMode", "toolCalling", "streaming", "reasoning", "longContext"],
  "openai-compatible": ["text", "streaming"],
  together: ["text"],
  cloudflare: ["text"],
  "local-inmemory": ["keywordSearch"],
  "local-sqlite-mem": ["durable", "keywordSearch"],
  mem0: ["durable", "vectorSearch", "managedMemory"],
  chroma: ["durable", "vectorSearch", "metadataFilters"],
  "tidb-memory": ["durable", "keywordSearch", "metadataFilters"],
};

function providerKindForId(id: string, providers: readonly ProviderConfigRecord[]): string | undefined {
  return providers.find((provider) => provider.id === id)?.kind;
}

function memoryKindForId(id: string, providers: readonly MemoryProviderRecord[]): string | undefined {
  if (id === "local") return "local-sqlite-mem";
  if (id === "disabled") return "disabled";
  return providers.find((provider) => provider.id === id)?.kind;
}

function buildCapabilities(current: CurrentTemplateConfig, template: RectorTemplate): Set<string> {
  const capabilities = new Set<string>();
  const addKind = (kind: string | undefined): void => {
    for (const capability of CAPABILITIES_BY_KIND[kind ?? ""] ?? []) capabilities.add(capability);
  };

  addKind("deterministic");
  for (const provider of current.providerRecords) addKind(provider.kind);
  for (const provider of current.memoryProviderRecords) addKind(provider.kind);
  for (const kind of template.requiredProviderKinds ?? []) addKind(kind);
  for (const assignment of template.memoryAssignments) addKind(assignment.providerKind);
  return capabilities;
}

function toTemplateOrchestrationAssignment(
  assignment: OrchestrationModelAssignment,
): TemplateOrchestrationAssignment {
  return {
    role: assignment.role,
    providerId: assignment.providerId,
    ...(assignment.modelId ? { modelId: assignment.modelId } : {}),
    ...(assignment.fallbackProviderId ? { fallbackProviderId: assignment.fallbackProviderId } : {}),
    ...(assignment.fallbackModelId ? { fallbackModelId: assignment.fallbackModelId } : {}),
    enabled: assignment.enabled,
    ...(assignment.maxUsdPerCall !== undefined ? { maxUsdPerCall: assignment.maxUsdPerCall } : {}),
    ...(assignment.maxTokens !== undefined ? { maxTokens: assignment.maxTokens } : {}),
    ...(assignment.timeoutMs !== undefined ? { timeoutMs: assignment.timeoutMs } : {}),
    ...(assignment.temperature !== undefined ? { temperature: assignment.temperature } : {}),
    ...(assignment.requiresJsonMode !== undefined ? { requiresJsonMode: assignment.requiresJsonMode } : {}),
    ...(assignment.requiresToolCalling !== undefined ? { requiresToolCalling: assignment.requiresToolCalling } : {}),
    ...(assignment.requiresStreaming !== undefined ? { requiresStreaming: assignment.requiresStreaming } : {}),
    ...(assignment.notes ? { notes: assignment.notes } : {}),
  };
}

function toTemplateMemoryAssignment(assignment: MemoryRoleAssignment): TemplateMemoryAssignment {
  return {
    role: assignment.role,
    providerRecordId: assignment.providerRecordId,
    enabled: assignment.enabled,
    ...(assignment.readPriority !== undefined ? { readPriority: assignment.readPriority } : {}),
    ...(assignment.writePriority !== undefined ? { writePriority: assignment.writePriority } : {}),
    ...(assignment.fallbackProviderRecordId ? { fallbackProviderRecordId: assignment.fallbackProviderRecordId } : {}),
    ...(assignment.retentionPolicy ? { retentionPolicy: assignment.retentionPolicy } : {}),
    ...(assignment.maxEntries !== undefined ? { maxEntries: assignment.maxEntries } : {}),
    ...(assignment.maxUsdPerDay !== undefined ? { maxUsdPerDay: assignment.maxUsdPerDay } : {}),
  };
}

function orchestrationRecordFromTemplate(
  assignment: TemplateOrchestrationAssignment,
  scopeId: string,
  now: string,
): OrchestrationModelAssignment {
  return OrchestrationModelAssignmentSchema.parse({
    id: `${scopeId}:orchestration:${assignment.role}`,
    ...(scopeId !== "default" ? { userId: scopeId } : {}),
    role: assignment.role,
    providerId: assignment.providerId,
    modelId: assignment.modelId,
    fallbackProviderId: assignment.fallbackProviderId,
    fallbackModelId: assignment.fallbackModelId,
    enabled: assignment.enabled,
    maxUsdPerCall: assignment.maxUsdPerCall,
    maxTokens: assignment.maxTokens,
    timeoutMs: assignment.timeoutMs,
    temperature: assignment.temperature,
    requiresJsonMode: assignment.requiresJsonMode,
    requiresToolCalling: assignment.requiresToolCalling,
    requiresStreaming: assignment.requiresStreaming,
    notes: assignment.notes,
    createdAt: now,
    updatedAt: now,
  });
}

function memoryRecordFromTemplate(
  assignment: TemplateMemoryAssignment,
  scopeId: string,
  now: string,
): MemoryRoleAssignment {
  return MemoryRoleAssignmentSchema.parse({
    id: `${scopeId}:memory:${assignment.role}`,
    ...(scopeId !== "default" ? { userId: scopeId } : {}),
    role: assignment.role,
    providerRecordId: assignment.providerRecordId,
    enabled: assignment.enabled,
    readPriority: assignment.readPriority,
    writePriority: assignment.writePriority,
    fallbackProviderRecordId: assignment.fallbackProviderRecordId,
    retentionPolicy: assignment.retentionPolicy,
    maxEntries: assignment.maxEntries,
    maxUsdPerDay: assignment.maxUsdPerDay,
    createdAt: now,
    updatedAt: now,
  });
}

function orchestrationScopeFromId(scopeId: string | undefined): OrchestrationAssignmentScope {
  const key = scopeKey(scopeId);
  return key === "default" ? {} : { userId: key };
}

function memoryFilterFromScope(scopeId: string | undefined): MemoryAssignmentFilter {
  const key = scopeKey(scopeId);
  return key === "default" ? {} : { userId: key };
}

function orchestrationUpsertFromRecord(record: OrchestrationModelAssignment): Parameters<OrchestrationAssignmentStore["upsertAssignment"]>[1] {
  return {
    providerId: record.providerId,
    ...(record.modelId ? { modelId: record.modelId } : {}),
    ...(record.fallbackProviderId ? { fallbackProviderId: record.fallbackProviderId } : {}),
    ...(record.fallbackModelId ? { fallbackModelId: record.fallbackModelId } : {}),
    enabled: record.enabled,
    ...(record.maxUsdPerCall !== undefined ? { maxUsdPerCall: record.maxUsdPerCall } : {}),
    ...(record.maxTokens !== undefined ? { maxTokens: record.maxTokens } : {}),
    ...(record.timeoutMs !== undefined ? { timeoutMs: record.timeoutMs } : {}),
    ...(record.temperature !== undefined ? { temperature: record.temperature } : {}),
    ...(record.requiresJsonMode !== undefined ? { requiresJsonMode: record.requiresJsonMode } : {}),
    ...(record.requiresToolCalling !== undefined ? { requiresToolCalling: record.requiresToolCalling } : {}),
    ...(record.requiresStreaming !== undefined ? { requiresStreaming: record.requiresStreaming } : {}),
    ...(record.notes !== undefined ? { notes: record.notes } : {}),
  };
}

function assertStoreResult<T>(result: { ok: true; value: T } | { ok: false; error: string }, operation: string): T {
  if (result.ok) return result.value;
  throw new Error(`${operation} failed: ${result.error}`);
}

function slugifyTemplateId(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "personal-template";
}

type TemplatePreviewAnalysis = Pick<
  TemplatePreview,
  "missingProviderConfigs" | "missingSecrets" | "capabilityMismatches" | "externalNetworkImplications"
>;

function orchestrationPreviewChanges(
  template: RectorTemplate,
  current: CurrentTemplateConfig,
): Array<TemplatePreviewChange<TemplateOrchestrationAssignment, OrchestrationModelAssignment>> {
  const existingByRole = new Map(current.orchestrationAssignments.map((assignment) => [assignment.role, assignment]));
  const templateRoles = new Set(template.orchestrationAssignments.map((assignment) => assignment.role));
  return [
    ...template.orchestrationAssignments.map((assignment) => {
      const existing = existingByRole.get(assignment.role) ?? null;
      return { role: assignment.role, action: existing ? "replace" as const : "add" as const, from: existing, to: assignment };
    }),
    ...current.orchestrationAssignments
      .filter((assignment) => !templateRoles.has(assignment.role))
      .map((assignment) => ({ role: assignment.role, action: "preserve" as const, from: assignment, to: null })),
  ];
}

function memoryPreviewChanges(
  template: RectorTemplate,
  current: CurrentTemplateConfig,
): Array<TemplatePreviewChange<TemplateMemoryAssignment, MemoryRoleAssignment>> {
  const existingByRole = new Map(current.memoryAssignments.map((assignment) => [assignment.role, assignment]));
  const templateRoles = new Set(template.memoryAssignments.map((assignment) => assignment.role));
  return [
    ...template.memoryAssignments.map((assignment) => {
      const existing = existingByRole.get(assignment.role) ?? null;
      return { role: assignment.role, action: existing ? "replace" as const : "add" as const, from: existing, to: assignment };
    }),
    ...current.memoryAssignments
      .filter((assignment) => !templateRoles.has(assignment.role))
      .map((assignment) => ({ role: assignment.role, action: "preserve" as const, from: assignment, to: null })),
  ];
}

function modulePreviewChanges(
  template: RectorTemplate,
  current: CurrentTemplateConfig,
): Array<TemplatePreviewChange<TemplateModuleToggle, TemplateModuleToggle>> {
  const existingByModuleId = new Map(current.moduleToggles.map((toggle) => [toggle.moduleId, toggle]));
  return (template.moduleToggles ?? []).map((toggle) => {
    const existing = existingByModuleId.get(toggle.moduleId) ?? null;
    return { role: toggle.moduleId, action: existing ? "replace" as const : "add" as const, from: existing, to: toggle };
  });
}

function buildPreviewChanges(template: RectorTemplate, current: CurrentTemplateConfig): TemplatePreview["changes"] {
  return {
    orchestrationAssignments: orchestrationPreviewChanges(template, current),
    memoryAssignments: memoryPreviewChanges(template, current),
    moduleToggles: modulePreviewChanges(template, current),
  };
}

function buildPreviewWarnings(template: RectorTemplate, analysis: TemplatePreviewAnalysis): string[] {
  return [
    ...analysis.externalNetworkImplications.map((implication) => `External/network implication: ${implication}`),
    ...(template.riskLevel === "high" ? ["High-risk template: review costs, sandbox, and provider scopes before applying."] : []),
    ...(analysis.missingProviderConfigs.length > 0 ? ["Some provider records are not configured yet."] : []),
    ...(analysis.missingSecrets.length > 0 ? ["Some configured providers are missing required credentials."] : []),
    ...(analysis.capabilityMismatches.length > 0 ? ["Some required capabilities are not currently satisfiable."] : []),
  ];
}

function activeOrchestrationAssignments(template: RectorTemplate): TemplateOrchestrationAssignment[] {
  return template.orchestrationAssignments.filter((assignment) => assignment.enabled);
}

function activeMemoryAssignments(template: RectorTemplate): TemplateMemoryAssignment[] {
  return template.memoryAssignments.filter((assignment) => assignment.enabled);
}

interface ExternalNetworkImplicationContext {
  template: RectorTemplate;
  current: CurrentTemplateConfig;
}

type ExternalNetworkImplicationCollector = (context: ExternalNetworkImplicationContext) => string[];

const EXTERNAL_NETWORK_IMPLICATION_COLLECTORS: readonly ExternalNetworkImplicationCollector[] = [
  collectRequiredProviderKindImplications,
  collectOrchestrationNetworkImplications,
  collectMemoryNetworkImplications,
  collectSandboxNetworkImplications,
];

function buildExternalNetworkImplications(template: RectorTemplate, current: CurrentTemplateConfig): string[] {
  const context: ExternalNetworkImplicationContext = { template, current };
  return uniqueStrings(EXTERNAL_NETWORK_IMPLICATION_COLLECTORS.flatMap((collect) => collect(context)));
}

function collectRequiredProviderKindImplications({ template }: ExternalNetworkImplicationContext): string[] {
  return (template.requiredProviderKinds ?? [])
    .filter(isExternalProviderKind)
    .map((kind) => `requires external provider kind ${kind}`);
}

function collectOrchestrationNetworkImplications({ template, current }: ExternalNetworkImplicationContext): string[] {
  return activeOrchestrationAssignments(template)
    .filter(orchestrationAssignmentUsesExternalProvider)
    .map((assignment) => formatOrchestrationNetworkImplication(assignment, current.providerRecords));
}

function orchestrationAssignmentUsesExternalProvider(assignment: TemplateOrchestrationAssignment): boolean {
  return isExternalProviderId(assignment.providerId);
}

function formatOrchestrationNetworkImplication(
  assignment: TemplateOrchestrationAssignment,
  providers: readonly ProviderConfigRecord[],
): string {
  const kind = providerKindForId(assignment.providerId, providers);
  return `orchestration role ${assignment.role} may call provider ${assignment.providerId}${providerKindSuffix(kind)}`;
}

interface MemoryNetworkImplicationCandidate {
  assignment: TemplateMemoryAssignment;
  kind: string | undefined;
}

function collectMemoryNetworkImplications({ template, current }: ExternalNetworkImplicationContext): string[] {
  return activeMemoryAssignments(template)
    .map((assignment) => memoryNetworkImplicationCandidate(assignment, current.memoryProviderRecords))
    .filter(memoryAssignmentUsesExternalProvider)
    .map(formatMemoryNetworkImplication);
}

function memoryNetworkImplicationCandidate(
  assignment: TemplateMemoryAssignment,
  providers: readonly MemoryProviderRecord[],
): MemoryNetworkImplicationCandidate {
  return {
    assignment,
    kind: assignment.providerKind ?? memoryKindForId(assignment.providerRecordId, providers),
  };
}

function memoryAssignmentUsesExternalProvider(candidate: MemoryNetworkImplicationCandidate): boolean {
  return isExternalProviderId(candidate.assignment.providerRecordId) || isExternalProviderKind(candidate.kind);
}

function formatMemoryNetworkImplication({ assignment, kind }: MemoryNetworkImplicationCandidate): string {
  return `memory role ${assignment.role} may use external provider ${assignment.providerRecordId}${providerKindSuffix(kind)}`;
}

function providerKindSuffix(kind: string | undefined): string {
  return kind ? ` (${kind})` : "";
}

function collectSandboxNetworkImplications({ template }: ExternalNetworkImplicationContext): string[] {
  const policy = template.sandboxPolicy;
  if (!policy) return [];

  return [
    ...(policy.mode === "e2b" ? ["sandbox policy may use E2B if configured"] : []),
    ...(policy.network !== undefined && policy.network !== "disabled" ? [`sandbox network policy is ${policy.network}`] : []),
  ];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function uniqueMissingProviderConfigs(items: TemplateMissingProviderConfig[]): TemplateMissingProviderConfig[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.providerKind ?? ""}:${item.providerId ?? ""}:${item.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function moduleSkipReason(moduleId: string, scopeId: string): string {
  return scopeId === "default" ? `module:${moduleId}` : `module:${moduleId}:scoped-scope`;
}

interface TemplateExportSummary {
  orchestrationAssignments: TemplateOrchestrationAssignment[];
  memoryAssignments: TemplateMemoryAssignment[];
  hasExternalOrchestration: boolean;
  hasExternalMemory: boolean;
  maxUsdPerRun: number;
  estimatedCostTier: "free" | "low" | "medium" | "high";
  requiredProviderKinds: string[];
}

function memoryAssignmentsForExport(current: CurrentTemplateConfig): TemplateMemoryAssignment[] {
  return current.memoryAssignments.map((assignment) => {
    const base = toTemplateMemoryAssignment(assignment);
    const kind = memoryKindForId(base.providerRecordId, current.memoryProviderRecords);
    return kind ? { ...base, providerKind: kind } : base;
  });
}

function estimateExportCostTier(
  maxUsdPerRun: number,
  hasExternalOrchestration: boolean,
  hasExternalMemory: boolean,
): "free" | "low" | "medium" | "high" {
  if (maxUsdPerRun === 0 && !hasExternalOrchestration && !hasExternalMemory) return "free";
  if (maxUsdPerRun <= 0.25) return "low";
  if (maxUsdPerRun <= 1.5) return "medium";
  return "high";
}

function requiredProviderKindsForExport(
  current: CurrentTemplateConfig,
  orchestrationAssignments: readonly TemplateOrchestrationAssignment[],
  memoryAssignments: readonly TemplateMemoryAssignment[],
): string[] {
  const requiredKinds = new Set<string>();
  for (const assignment of orchestrationAssignments) {
    const kind = providerKindForId(assignment.providerId, current.providerRecords);
    if (kind && isExternalProviderKind(kind)) requiredKinds.add(kind);
  }
  for (const assignment of memoryAssignments) {
    if (assignment.providerKind && isExternalProviderKind(assignment.providerKind)) requiredKinds.add(assignment.providerKind);
  }
  return [...requiredKinds];
}

function summarizeCurrentConfigForExport(current: CurrentTemplateConfig): TemplateExportSummary {
  const orchestrationAssignments = current.orchestrationAssignments.map(toTemplateOrchestrationAssignment);
  const memoryAssignments = memoryAssignmentsForExport(current);
  const hasExternalOrchestration = orchestrationAssignments.some((assignment) => isExternalProviderId(assignment.providerId));
  const hasExternalMemory = memoryAssignments.some((assignment) =>
    isExternalProviderKind(assignment.providerKind) || isExternalProviderId(assignment.providerRecordId),
  );
  const maxUsdPerRun = orchestrationAssignments.reduce((sum, assignment) => sum + (assignment.maxUsdPerCall ?? 0), 0);
  return {
    orchestrationAssignments,
    memoryAssignments,
    hasExternalOrchestration,
    hasExternalMemory,
    maxUsdPerRun,
    estimatedCostTier: estimateExportCostTier(maxUsdPerRun, hasExternalOrchestration, hasExternalMemory),
    requiredProviderKinds: requiredProviderKindsForExport(current, orchestrationAssignments, memoryAssignments),
  };
}

function buildExportTemplate(
  options: TemplateExportOptions,
  current: CurrentTemplateConfig,
  summary: TemplateExportSummary,
  name: string,
  now: string,
): RectorTemplate {
  const usesExternalProvider = summary.hasExternalOrchestration || summary.hasExternalMemory;
  return {
    schemaVersion: TEMPLATE_SCHEMA_VERSION,
    id: options.id?.trim() || slugifyTemplateId(name),
    name,
    description: options.description?.trim() || "Exported from the current Rector assignment configuration.",
    ...(options.author?.trim() ? { author: options.author.trim() } : {}),
    tags: options.tags ?? ["personal", "exported"],
    intendedUse: options.intendedUse ?? ["personal setup"],
    riskLevel: usesExternalProvider ? "medium" : "local",
    orchestrationAssignments: summary.orchestrationAssignments,
    memoryAssignments: summary.memoryAssignments,
    moduleToggles: current.moduleToggles,
    sandboxPolicy: {
      mode: usesExternalProvider ? "local-safe" : "fake",
      network: "disabled",
      allowlist: [],
      requireApprovalFor: ["write", "delete", "shell"],
    },
    budgets: {
      estimatedCostTier: summary.estimatedCostTier,
      maxUsdPerRun: summary.maxUsdPerRun,
      maxUsdPerDay: summary.maxUsdPerRun === 0 ? 0 : Math.max(summary.maxUsdPerRun * 10, summary.maxUsdPerRun),
      maxUsdPerMonth: summary.maxUsdPerRun === 0 ? 0 : Math.max(summary.maxUsdPerRun * 200, summary.maxUsdPerRun),
    },
    requiredProviderKinds: summary.requiredProviderKinds,
    requiredCapabilities: [],
    createdAt: now,
    updatedAt: now,
  };
}

interface TemplateProviderRequirements {
  requiredKinds: Set<string>;
  orchestrationProviderIds: Set<string>;
  memoryProviderIds: Set<string>;
}

function templateProviderRequirements(template: RectorTemplate): TemplateProviderRequirements {
  return {
    requiredKinds: new Set((template.requiredProviderKinds ?? []).filter(isExternalProviderKind)),
    orchestrationProviderIds: new Set(
      activeOrchestrationAssignments(template)
        .map((assignment) => assignment.providerId)
        .filter(isExternalProviderId),
    ),
    memoryProviderIds: new Set(
      activeMemoryAssignments(template)
        .map((assignment) => assignment.providerRecordId)
        .filter(isExternalProviderId),
    ),
  };
}

export class TemplateService {
  private readonly userTemplateStore: UserTemplateStore;
  private readonly now: () => string;

  constructor(private readonly deps: TemplateServiceDeps) {
    this.userTemplateStore = deps.userTemplateStore ?? createInMemoryUserTemplateStore();
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  listBuiltIns(): RectorTemplate[] {
    return listBuiltInTemplates().filter((template) => !INTERNAL_TEMPLATE_IDS.has(template.id));
  }

  async listTemplates(scopeId?: string): Promise<RectorTemplate[]> {
    return [...this.listBuiltIns(), ...(await this.userTemplateStore.list(scopeId))];
  }

  async getTemplate(id: string, scopeId?: string): Promise<RectorTemplate | undefined> {
    return getBuiltInTemplate(id) ?? (await this.userTemplateStore.get(id, scopeId));
  }

  validate(template: unknown): TemplateValidationResult {
    const normalized = safeNormalizeTemplateInput(template);
    if (!normalized.ok) return { ok: false, issues: [normalized.issue] };
    return validateNormalizedTemplate(normalized.value);
  }

  importTemplate(json: unknown): RectorTemplate {
    const raw = normalizeTemplateInput(json);
    const scan = scanTemplateForSecrets(raw);
    if (!scan.ok) throw new TemplateImportSecretError(scan.findings);
    return parseRectorTemplate(raw);
  }

  async preview(
    templateOrId: string | RectorTemplate,
    currentConfig?: Partial<CurrentTemplateConfig>,
    scopeId = "default",
  ): Promise<TemplatePreview> {
    const template = await this.resolveTemplate(templateOrId, scopeId);
    const validation = this.validate(template);
    const current = await this.currentConfig(scopeId, currentConfig);
    const changes = buildPreviewChanges(template, current);
    const analysis = await this.previewAnalysis(template, current);

    return {
      template: cloneTemplate(template),
      valid: validation.ok,
      validationIssues: validation.issues,
      changes,
      ...analysis,
      estimatedCostTier: costTierFromBudget(template.budgets),
      warnings: buildPreviewWarnings(template, analysis),
      rollbackSnapshotId: `template-preview:${scopeKey(scopeId)}:${template.id}`,
    };
  }

  async apply(templateOrId: string | RectorTemplate, options: TemplateApplyOptions = {}): Promise<TemplateApplyResult> {
    const scopeId = scopeKey(options.scopeId);
    const mode = options.mode ?? "mergeMissing";
    const template = await this.resolveTemplate(templateOrId, scopeId);
    const preview = await this.preview(template, undefined, scopeId);
    if (!preview.valid) {
      throw new Error(`Template validation failed: ${preview.validationIssues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
    }

    if (mode === "previewOnly") {
      return { applied: false, mode, template: cloneTemplate(template), preview, changed: { orchestrationAssignments: 0, memoryAssignments: 0, moduleToggles: 0 }, skipped: [] };
    }

    if (mode === "saveAsDraft") {
      const saved = await this.userTemplateStore.save(this.withSaveMetadata(template, options), scopeId);
      return { applied: false, mode, template: cloneTemplate(template), preview, changed: { orchestrationAssignments: 0, memoryAssignments: 0, moduleToggles: 0 }, skipped: [], savedTemplate: saved };
    }

    if (mode === "replaceAssignments" && options.confirmReplace !== true) {
      throw new Error("replaceAssignments mode requires confirmReplace: true");
    }

    const skipped: string[] = [];
    const changed = await this.applyTemplateChanges(template, mode, scopeId, skipped);
    const postApplyPreview = await this.preview(template, undefined, scopeId);
    return {
      applied: true,
      mode,
      template: cloneTemplate(template),
      preview: postApplyPreview,
      changed,
      skipped,
    };
  }

  async exportCurrentConfig(options: TemplateExportOptions = {}): Promise<RectorTemplate> {
    const current = await this.currentConfig(scopeKey(options.scopeId));
    const name = options.name?.trim() || "Personal Rector Template";
    const summary = summarizeCurrentConfigForExport(current);
    const template = buildExportTemplate(options, current, summary, name, this.now());
    const scan = scanTemplateForSecrets(template);
    if (!scan.ok) throw new TemplateImportSecretError(scan.findings);
    return parseRectorTemplate(template);
  }

  async saveCurrentConfig(options: TemplateExportOptions = {}): Promise<RectorTemplate> {
    const template = await this.exportCurrentConfig(options);
    return this.userTemplateStore.save(template, scopeKey(options.scopeId));
  }

  private async applyTemplateChanges(
    template: RectorTemplate,
    mode: Exclude<TemplateApplyMode, "previewOnly" | "saveAsDraft">,
    scopeId: string,
    skipped: string[],
  ): Promise<TemplateApplyResult["changed"]> {
    const now = this.now();
    if (mode === "replaceAssignments") return this.applyReplaceAssignments(template, scopeId, now, skipped);
    if (mode === "mergeMissing") return this.applyMergeMissing(template, scopeId, now, skipped);
    // noinspection UnnecessaryLocalVariableJS -- intentional exhaustiveness guard; keeps the `never` assignment
    const _exhaustive: never = mode;
    throw new Error(`Unsupported template apply mode: ${String(_exhaustive)}`);
  }

  private async applyReplaceAssignments(
    template: RectorTemplate,
    scopeId: string,
    now: string,
    skipped: string[],
  ): Promise<TemplateApplyResult["changed"]> {
    const orchestrationRecords = template.orchestrationAssignments.map((assignment) =>
      orchestrationRecordFromTemplate(assignment, scopeId, now),
    );
    const memoryRecords = template.memoryAssignments.map((assignment) =>
      memoryRecordFromTemplate(assignment, scopeId, now),
    );
    await this.replaceOrchestrationAssignments(orchestrationRecords, scopeId);
    await this.replaceMemoryAssignments(memoryRecords, scopeId);
    return {
      orchestrationAssignments: orchestrationRecords.length,
      memoryAssignments: memoryRecords.length,
      moduleToggles: await this.applyModuleToggles(template.moduleToggles ?? [], scopeId, skipped),
    };
  }

  private async applyMergeMissing(
    template: RectorTemplate,
    scopeId: string,
    now: string,
    skipped: string[],
  ): Promise<TemplateApplyResult["changed"]> {
    const current = await this.currentConfig(scopeId);
    return {
      orchestrationAssignments: await this.mergeMissingOrchestrationAssignments(template, current, scopeId, now, skipped),
      memoryAssignments: await this.mergeMissingMemoryAssignments(template, current, scopeId, now, skipped),
      moduleToggles: await this.mergeMissingModuleToggles(template, current, scopeId, skipped),
    };
  }

  private async mergeMissingOrchestrationAssignments(
    template: RectorTemplate,
    current: CurrentTemplateConfig,
    scopeId: string,
    now: string,
    skipped: string[],
  ): Promise<number> {
    const existingRoles = new Set(current.orchestrationAssignments.map((assignment) => assignment.role));
    let changed = 0;
    for (const assignment of template.orchestrationAssignments) {
      if (existingRoles.has(assignment.role)) {
        skipped.push(`orchestration:${assignment.role}`);
        continue;
      }
      await this.upsertOrchestrationAssignment(orchestrationRecordFromTemplate(assignment, scopeId, now), scopeId);
      changed += 1;
    }
    return changed;
  }

  private async mergeMissingMemoryAssignments(
    template: RectorTemplate,
    current: CurrentTemplateConfig,
    scopeId: string,
    now: string,
    skipped: string[],
  ): Promise<number> {
    const existingRoles = new Set(current.memoryAssignments.map((assignment) => assignment.role));
    let changed = 0;
    for (const assignment of template.memoryAssignments) {
      if (existingRoles.has(assignment.role)) {
        skipped.push(`memory:${assignment.role}`);
        continue;
      }
      await this.upsertMemoryAssignment(memoryRecordFromTemplate(assignment, scopeId, now));
      changed += 1;
    }
    return changed;
  }

  private async mergeMissingModuleToggles(
    template: RectorTemplate,
    current: CurrentTemplateConfig,
    scopeId: string,
    skipped: string[],
  ): Promise<number> {
    const existingIds = new Set(current.moduleToggles.map((toggle) => toggle.moduleId));
    const missing = (template.moduleToggles ?? []).filter((toggle) => {
      if (existingIds.has(toggle.moduleId)) {
        skipped.push(moduleSkipReason(toggle.moduleId, scopeId));
        return false;
      }
      return true;
    });
    return this.applyModuleToggles(missing, scopeId, skipped);
  }

  private async upsertOrchestrationAssignment(record: OrchestrationModelAssignment, scopeId: string): Promise<void> {
    const result = await this.deps.orchestrationAssignmentStore.upsertAssignment(
      record.role,
      orchestrationUpsertFromRecord(record),
      orchestrationScopeFromId(scopeId),
    );
    assertStoreResult(result, `upsert orchestration assignment ${record.role}`);
  }

  private async replaceOrchestrationAssignments(
    records: readonly OrchestrationModelAssignment[],
    scopeId: string,
  ): Promise<void> {
    assertStoreResult(
      await this.deps.orchestrationAssignmentStore.resetAssignments(orchestrationScopeFromId(scopeId)),
      "reset orchestration assignments",
    );
    for (const record of records) await this.upsertOrchestrationAssignment(record, scopeId);
  }

  private async upsertMemoryAssignment(record: MemoryRoleAssignment): Promise<void> {
    assertStoreResult(
      await this.deps.memoryAssignmentStore.upsertAssignment(record),
      `upsert memory assignment ${record.role}`,
    );
  }

  private async replaceMemoryAssignments(records: readonly MemoryRoleAssignment[], scopeId: string): Promise<void> {
    assertStoreResult(
      await this.deps.memoryAssignmentStore.resetAssignments(memoryFilterFromScope(scopeId)),
      "reset memory assignments",
    );
    for (const record of records) await this.upsertMemoryAssignment(record);
  }

  private async requireTemplate(id: string, scopeId?: string): Promise<RectorTemplate> {
    const template = await this.getTemplate(id, scopeId);
    if (!template) throw new Error(`Template not found: ${id}`);
    return template;
  }

  private async resolveTemplate(templateOrId: string | RectorTemplate, scopeId: string): Promise<RectorTemplate> {
    return typeof templateOrId === "string" ? this.requireTemplate(templateOrId, scopeId) : parseRectorTemplate(templateOrId);
  }

  private async previewAnalysis(template: RectorTemplate, current: CurrentTemplateConfig): Promise<TemplatePreviewAnalysis> {
    const missingProviderConfigs = this.missingProviderConfigs(template, current);
    const missingSecrets = await this.missingSecretRequirements(template, current);
    const capabilityMismatches = this.capabilityMismatches(template, current);
    const externalNetworkImplications = buildExternalNetworkImplications(template, current);
    return { missingProviderConfigs, missingSecrets, capabilityMismatches, externalNetworkImplications };
  }

  private async currentConfig(scopeId: string, overrides: Partial<CurrentTemplateConfig> = {}): Promise<CurrentTemplateConfig> {
    const providerState = await this.deps.providerConfigStore.getState();
    const memoryState = await this.deps.memoryConfigStore.getState();
    let moduleToggles: TemplateModuleToggle[] = [];
    if (this.deps.moduleConfigStore) {
      const moduleState = ModuleConfigStateSchema.parse(await this.deps.moduleConfigStore.getState());
      moduleToggles = [
        ...moduleState.enabledModuleIds.map((moduleId) => ({ moduleId, enabled: true })),
        ...moduleState.disabledModuleIds.map((moduleId) => ({ moduleId, enabled: false })),
      ];
    }

    return {
      orchestrationAssignments:
        overrides.orchestrationAssignments ??
        (await this.deps.orchestrationAssignmentStore.listAssignments(orchestrationScopeFromId(scopeId))),
      memoryAssignments:
        overrides.memoryAssignments ??
        (await this.deps.memoryAssignmentStore.listAssignments(memoryFilterFromScope(scopeId))),
      moduleToggles: overrides.moduleToggles ?? moduleToggles,
      providerRecords: overrides.providerRecords ?? providerState.providers,
      memoryProviderRecords: overrides.memoryProviderRecords ?? memoryState.providers,
    };
  }

  private missingProviderConfigs(template: RectorTemplate, current: CurrentTemplateConfig): TemplateMissingProviderConfig[] {
    const providerIds = new Set(current.providerRecords.map((provider) => provider.id));
    const providerKinds = new Set(current.providerRecords.map((provider) => provider.kind));
    const memoryIds = new Set(current.memoryProviderRecords.map((provider) => provider.id));
    const memoryKinds = new Set(current.memoryProviderRecords.map((provider) => provider.kind));
    const missing = [
      ...this.missingRequiredProviderKinds(template, providerKinds, memoryKinds),
      ...this.missingOrchestrationProviders(template, providerIds),
      ...this.missingMemoryProviders(template, memoryIds),
    ];
    return uniqueMissingProviderConfigs(missing);
  }

  private missingRequiredProviderKinds(
    template: RectorTemplate,
    providerKinds: ReadonlySet<string>,
    memoryKinds: ReadonlySet<string>,
  ): TemplateMissingProviderConfig[] {
    return (template.requiredProviderKinds ?? [])
      .filter(isExternalProviderKind)
      .filter((kind) => !providerKinds.has(kind) && !memoryKinds.has(kind))
      .map((kind) => ({ providerKind: kind, reason: "required provider kind is not configured" }));
  }

  private missingOrchestrationProviders(
    template: RectorTemplate,
    providerIds: ReadonlySet<string>,
  ): TemplateMissingProviderConfig[] {
    return activeOrchestrationAssignments(template)
      .filter((assignment) => isExternalProviderId(assignment.providerId) && !providerIds.has(assignment.providerId))
      .map((assignment) => ({
        providerId: assignment.providerId,
        reason: `orchestration role ${assignment.role} references an unconfigured provider`,
      }));
  }

  private missingMemoryProviders(
    template: RectorTemplate,
    memoryIds: ReadonlySet<string>,
  ): TemplateMissingProviderConfig[] {
    return activeMemoryAssignments(template)
      .filter((assignment) => isExternalProviderId(assignment.providerRecordId) && !memoryIds.has(assignment.providerRecordId))
      .map((assignment) => ({
        providerId: assignment.providerRecordId,
        providerKind: assignment.providerKind,
        reason: `memory role ${assignment.role} references an unconfigured provider`,
      }));
  }

  private async missingSecretRequirements(
    template: RectorTemplate,
    current: CurrentTemplateConfig,
  ): Promise<TemplateMissingSecretRequirement[]> {
    const requirements = templateProviderRequirements(template);
    return [
      ...(await this.missingProviderSecrets(current.providerRecords, requirements)),
      ...(await this.missingMemorySecrets(current.memoryProviderRecords, requirements)),
    ];
  }

  private async missingProviderSecrets(
    providers: readonly ProviderConfigRecord[],
    requirements: TemplateProviderRequirements,
  ): Promise<TemplateMissingSecretRequirement[]> {
    const missing: TemplateMissingSecretRequirement[] = [];
    for (const provider of providers) {
      if (!requirements.requiredKinds.has(provider.kind) && !requirements.orchestrationProviderIds.has(provider.id)) continue;
      if (await this.safeHasSecret(provider.secretRef)) continue;
      missing.push({
        providerId: provider.id,
        providerKind: provider.kind,
        label: provider.label,
        reason: "provider credential is not stored",
      });
    }
    return missing;
  }

  private async missingMemorySecrets(
    providers: readonly MemoryProviderRecord[],
    requirements: TemplateProviderRequirements,
  ): Promise<TemplateMissingSecretRequirement[]> {
    const missing: TemplateMissingSecretRequirement[] = [];
    for (const provider of providers) {
      const required = requirements.requiredKinds.has(provider.kind) || requirements.memoryProviderIds.has(provider.id);
      if (!required || !isExternalProviderKind(provider.kind)) continue;
      if (await this.safeHasSecret(provider.secretRef)) continue;
      missing.push({
        providerId: provider.id,
        providerKind: provider.kind,
        label: provider.label,
        reason: "memory provider credential is not stored",
      });
    }
    return missing;
  }

  private capabilityMismatches(template: RectorTemplate, current: CurrentTemplateConfig): TemplateCapabilityMismatch[] {
    const available = buildCapabilities(current, template);
    return (template.requiredCapabilities ?? [])
      .filter((capability) => !available.has(capability))
      .map((capability) => ({ capability, reason: "no configured provider advertises this capability" }));
  }

  private async safeHasSecret(ref: string): Promise<boolean> {
    try {
      return await this.deps.secretStore.hasSecret(ref);
    } catch {
      return false;
    }
  }

  private async applyModuleToggles(
    toggles: readonly TemplateModuleToggle[],
    scopeId: string,
    skipped: string[],
  ): Promise<number> {
    if (scopeId !== "default") {
      skipped.push(...toggles.map((toggle) => moduleSkipReason(toggle.moduleId, scopeId)));
      return 0;
    }
    if (!this.deps.moduleConfigStore) return 0;

    let changed = 0;
    for (const toggle of toggles) {
      const result = await this.deps.moduleConfigStore.setModuleEnabled(toggle.moduleId, toggle.enabled);
      if (!result.ok) throw new Error(result.error);
      changed += 1;
    }
    return changed;
  }

  private withSaveMetadata(template: RectorTemplate, options: TemplateApplyOptions): RectorTemplate {
    const now = this.now();
    const name = options.saveAsName?.trim() || `Draft: ${template.name}`;
    const id = options.saveAsId?.trim() || `draft-${slugifyTemplateId(template.id)}`;
    return parseRectorTemplate({
      ...template,
      id,
      name,
      description: options.description?.trim() || template.description,
      tags: [...new Set([...template.tags, "draft"])],
      createdAt: template.createdAt ?? now,
      updatedAt: now,
    });
  }
}

export const TemplateApplyRequestSchema = z
  .object({
    mode: z.enum(["previewOnly", "mergeMissing", "replaceAssignments", "saveAsDraft"]).default("mergeMissing"),
    confirmReplace: z.boolean().optional(),
    saveAsId: z.string().min(1).optional(),
    saveAsName: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
  })
  .strict();
export type TemplateApplyRequest = z.infer<typeof TemplateApplyRequestSchema>;

export const TemplateSaveCurrentRequestSchema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    author: z.string().min(1).optional(),
    tags: z.array(z.string().min(1)).optional(),
    intendedUse: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type TemplateSaveCurrentRequest = z.infer<typeof TemplateSaveCurrentRequestSchema>;

export { BUILT_IN_TEMPLATES };
