import type { SecretStore } from "../security/secretStore";
import { redactString } from "../security/redaction";
import type { MemoryProvider } from "../memory/provider";
import type { Run } from "../store/schemas";
import {
  createPureLocalMemoryProvider,
  buildMemoryProviderFromRecord,
  type ResolveMemoryProviderOptions,
} from "./memoryBridge";
import type { MemoryConfigStore } from "./memoryConfigStore";
import type { MemoryProviderRecord } from "./memoryConfig";
import {
  MEMORY_ROLE_DEFINITIONS,
  memoryCapabilityWarningsForRole,
  memoryProviderCapabilitiesForKind,
  type MemoryCapabilityWarning,
  type MemoryProviderCapabilities,
  type MemoryRole,
  type MemoryRoleAssignment,
} from "./memoryAssignments";
import {
  selectMemoryAssignmentForRole,
  type MemoryAssignmentStore,
} from "./memoryAssignmentStore";

export type MemoryRoleResolutionSource =
  | "assignment"
  | "activeDefault"
  | "localFallback"
  | "disabled"
  | "fallback";

export type MemoryRoleReadinessStatus = "ready" | "disabled" | "notReady";

export interface EffectiveMemoryProvider {
  role: MemoryRole;
  status: MemoryRoleReadinessStatus;
  source: MemoryRoleResolutionSource;
  providerRecordId: string;
  provider?: MemoryProvider;
  providerRecord?: MemoryProviderRecord;
  assignment?: MemoryRoleAssignment;
  fallbackProviderRecordId?: string;
  capabilities: MemoryProviderCapabilities;
  warnings: MemoryCapabilityWarning[];
  error?: string;
}

export interface ResolveMemoryRoleContext extends ResolveMemoryProviderOptions {
  userId?: string;
  workspaceId?: string;
  mode?: "local" | "external";
  run?: Run;
}

export interface MemoryRoleRouterOptions {
  assignmentStore: MemoryAssignmentStore;
  configStore: MemoryConfigStore;
  secrets: SecretStore;
  mode?: "local" | "external";
  now?: () => string;
  delegateStoreForLocalSqliteMem?: unknown;
  run?: Run;
}

interface BuildProviderResult {
  role: MemoryRole;
  status: MemoryRoleReadinessStatus;
  source: MemoryRoleResolutionSource;
  providerRecordId: string;
  provider?: MemoryProvider;
  providerRecord?: MemoryProviderRecord;
  capabilities: MemoryProviderCapabilities;
  warnings: MemoryCapabilityWarning[];
  error?: string;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactString(message);
}

function providerLabel(record: MemoryProviderRecord | undefined, providerRecordId: string): string {
  if (providerRecordId === "local") return "Local default";
  if (providerRecordId === "disabled") return "Disabled";
  return record?.label ?? providerRecordId;
}

function providerKindForRef(record: MemoryProviderRecord | undefined, providerRecordId: string): string {
  if (providerRecordId === "local") return "local-inmemory";
  if (providerRecordId === "disabled") return "disabled";
  return record?.kind ?? "missing";
}

/**
 * MemoryRoleRouter (Chunk 044).
 *
 * Resolves a memory role to an effective provider without storing or returning
 * secrets. It preserves the current single active MemoryProvider bridge as the
 * workspace/default fallback, and Local_Mode forces local memory without secret
 * reads or external provider construction.
 */
export class MemoryRoleRouter {
  private readonly assignmentStore: MemoryAssignmentStore;
  private readonly configStore: MemoryConfigStore;
  private readonly secrets: SecretStore;
  private readonly defaults: Omit<ResolveMemoryRoleContext, "userId" | "workspaceId">;
  private readonly providerCache = new Map<string, MemoryProvider>();
  private readonly contextObjectIds = new WeakMap<object, string>();
  private contextObjectSeq = 0;

  constructor(options: MemoryRoleRouterOptions) {
    this.assignmentStore = options.assignmentStore;
    this.configStore = options.configStore;
    this.secrets = options.secrets;
    this.defaults = {
      mode: options.mode,
      now: options.now,
      delegateStoreForLocalSqliteMem: options.delegateStoreForLocalSqliteMem,
      run: options.run,
    };
  }

  clearCache(): void {
    this.providerCache.clear();
  }

  async resolveMemoryProvider(role: MemoryRole, context: ResolveMemoryRoleContext = {}): Promise<EffectiveMemoryProvider> {
    const mode = context.mode ?? this.defaults.mode ?? "external";
    const merged: ResolveMemoryRoleContext = { ...this.defaults, ...context, mode };
    const assignments = await this.assignmentStore.listAssignments();
    const assignment = selectMemoryAssignmentForRole(assignments, {
      role,
      userId: context.userId,
      workspaceId: context.workspaceId,
    });
    const configState = await this.configStore.getState();

    if (assignment) {
      if (!assignment.enabled || assignment.providerRecordId === "disabled") {
        return this.disabled(role, assignment);
      }

      if (mode === "local" && assignment.providerRecordId !== "local") {
        return this.localFallback(role, assignment, {
          code: "EXTERNAL_MEMORY",
          severity: "info",
          message: `${MEMORY_ROLE_DEFINITIONS[role].label} is assigned to ${assignment.providerRecordId}, but Local Mode forces the built-in local memory provider without reading secrets.`,
        }, merged);
      }

      const primary = await this.buildProvider(role, assignment.providerRecordId, "assignment", configState.providers, merged);
      if (primary.status === "ready") return { ...primary, assignment };

      const fallbackRef = assignment.fallbackProviderRecordId;
      if (fallbackRef && fallbackRef !== assignment.providerRecordId) {
        const fallback = await this.buildProvider(role, fallbackRef, "fallback", configState.providers, merged);
        if (fallback.status === "ready") {
          return {
            ...fallback,
            assignment,
            fallbackProviderRecordId: fallbackRef,
            warnings: [
              ...fallback.warnings,
              {
                code: "PROVIDER_DISABLED",
                severity: "warning",
                message: `Primary assignment ${assignment.providerRecordId} is not ready; using fallback ${fallbackRef}.`,
              },
            ],
          };
        }
      }

      return {
        ...this.localFallback(role, assignment, undefined, merged),
        error: primary.error,
      };
    }

    if (mode === "local") {
      return this.localFallback(role, undefined, undefined, merged);
    }

    if (configState.activeMemoryProviderId) {
      const active = await this.buildProvider(
        role,
        configState.activeMemoryProviderId,
        "activeDefault",
        configState.providers,
        merged,
      );
      if (active.status === "ready") return active;
      return { ...this.localFallback(role, undefined, undefined, merged), error: active.error };
    }

    return this.localFallback(role, undefined, undefined, merged);
  }

  private disabled(role: MemoryRole, assignment: MemoryRoleAssignment): EffectiveMemoryProvider {
    const capabilities = memoryProviderCapabilitiesForKind("disabled");
    return {
      role,
      status: "disabled",
      source: "disabled",
      providerRecordId: "disabled",
      assignment,
      capabilities,
      warnings: memoryCapabilityWarningsForRole({
        role,
        capabilities,
        providerKind: "disabled",
        providerRecordId: "disabled",
      }),
    };
  }

  private localFallback(
    role: MemoryRole,
    assignment?: MemoryRoleAssignment,
    extraWarning?: MemoryCapabilityWarning,
    context: ResolveMemoryRoleContext = this.defaults,
  ): EffectiveMemoryProvider {
    const providerRecordId = "local";
    const provider = this.cachedProvider(`local:${role}:${this.cacheContextKey(context)}`, () =>
      createPureLocalMemoryProvider({ id: "local-inmemory:default", label: "Local (in-memory)", now: context.now }),
    );
    const capabilities = memoryProviderCapabilitiesForKind("local-inmemory");
    const warnings = memoryCapabilityWarningsForRole({
      role,
      capabilities,
      providerKind: "local-inmemory",
      providerLabel: "Local (in-memory)",
      providerRecordId,
      mode: context.mode,
    });
    if (extraWarning) warnings.push(extraWarning);
    return {
      role,
      status: "ready",
      source: "localFallback",
      providerRecordId,
      provider,
      assignment,
      capabilities,
      warnings,
    };
  }

  private async buildProvider(
    role: MemoryRole,
    providerRecordId: string,
    source: MemoryRoleResolutionSource,
    records: MemoryProviderRecord[],
    context: ResolveMemoryRoleContext,
  ): Promise<BuildProviderResult> {
    if (providerRecordId === "disabled") {
      const capabilities = memoryProviderCapabilitiesForKind("disabled");
      return {
        role,
        status: "disabled",
        source: "disabled",
        providerRecordId,
        capabilities,
        warnings: memoryCapabilityWarningsForRole({ role, capabilities, providerKind: "disabled", providerRecordId }),
      };
    }

    if (providerRecordId === "local") {
      const provider = this.cachedProvider(`local:${role}:${this.cacheContextKey(context)}`, () =>
        createPureLocalMemoryProvider({ id: "local-inmemory:default", label: "Local (in-memory)", now: context.now }),
      );
      const capabilities = memoryProviderCapabilitiesForKind("local-inmemory");
      return {
        role,
        status: "ready",
        source,
        providerRecordId,
        provider,
        capabilities,
        warnings: memoryCapabilityWarningsForRole({
          role,
          capabilities,
          providerKind: "local-inmemory",
          providerLabel: "Local (in-memory)",
          providerRecordId,
          mode: context.mode,
        }),
      };
    }

    const record = records.find((candidate) => candidate.id === providerRecordId);
    if (!record) {
      const capabilities = memoryProviderCapabilitiesForKind(undefined);
      return {
        role,
        status: "notReady",
        source,
        providerRecordId,
        capabilities,
        warnings: [],
        error: `Memory provider "${providerRecordId}" is not configured.`,
      };
    }

    const capabilities = memoryProviderCapabilitiesForKind(record.kind);
    const warnings = memoryCapabilityWarningsForRole({
      role,
      capabilities,
      providerKind: record.kind,
      providerLabel: record.label,
      providerRecordId,
      mode: context.mode,
    });

    try {
      const cacheKey = `${source}:${role}:${record.id}:${record.updatedAt}:${this.cacheContextKey(context)}`;
      const provider = await this.cachedProviderAsync(cacheKey, async () => {
        const secret = record.kind === "local-inmemory" || record.kind === "local-sqlite-mem"
          ? undefined
          : await this.readSecret(record.secretRef);
        return buildMemoryProviderFromRecord(record, secret, context);
      });
      return {
        role,
        status: "ready",
        source,
        providerRecordId,
        provider,
        providerRecord: record,
        capabilities,
        warnings,
      };
    } catch (error) {
      return {
        role,
        status: "notReady",
        source,
        providerRecordId,
        providerRecord: record,
        capabilities,
        warnings,
        error: safeError(error),
      };
    }
  }

  private async readSecret(secretRef: string): Promise<string | undefined> {
    const result = await this.secrets.getSecret(secretRef);
    if (!result.ok) return undefined;
    return result.value;
  }

  private cacheContextKey(context: ResolveMemoryRoleContext): string {
    return [
      context.mode ?? "external",
      context.run?.id ?? this.contextObjectKey(context.run),
      this.contextObjectKey(context.delegateStoreForLocalSqliteMem),
      this.contextObjectKey(context.now),
    ].join(":");
  }

  private contextObjectKey(value: unknown): string {
    if (value === undefined || value === null) return "none";
    if ((typeof value !== "object" && typeof value !== "function")) return String(value);
    const objectValue = value as object;
    const existing = this.contextObjectIds.get(objectValue);
    if (existing) return existing;
    this.contextObjectSeq += 1;
    const next = `ctx${this.contextObjectSeq}`;
    this.contextObjectIds.set(objectValue, next);
    return next;
  }

  private cachedProvider(key: string, factory: () => MemoryProvider): MemoryProvider {
    const cached = this.providerCache.get(key);
    if (cached) return cached;
    const provider = factory();
    this.providerCache.set(key, provider);
    return provider;
  }

  private async cachedProviderAsync(key: string, factory: () => Promise<MemoryProvider>): Promise<MemoryProvider> {
    const cached = this.providerCache.get(key);
    if (cached) return cached;
    const provider = await factory();
    this.providerCache.set(key, provider);
    return provider;
  }
}

export function memoryRoleResolutionToJson(effective: EffectiveMemoryProvider): Record<string, unknown> {
  const record = effective.providerRecord;
  const kind = providerKindForRef(record, effective.providerRecordId);
  return {
    role: effective.role,
    status: effective.status,
    source: effective.source,
    providerRecordId: effective.providerRecordId,
    provider: effective.provider
      ? {
          id: effective.provider.id,
          kind: effective.provider.kind,
          label: effective.provider.metadata.label,
        }
      : record
        ? { id: record.id, kind: record.kind, label: record.label }
        : { id: effective.providerRecordId, kind, label: providerLabel(record, effective.providerRecordId) },
    assignment: effective.assignment
      ? {
          ...effective.assignment,
        }
      : undefined,
    fallbackProviderRecordId: effective.fallbackProviderRecordId,
    capabilities: effective.capabilities,
    warnings: effective.warnings,
    readiness: {
      ready: effective.status === "ready",
      status: effective.status,
      error: effective.error,
    },
  };
}
