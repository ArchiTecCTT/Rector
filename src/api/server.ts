import crypto from "node:crypto";
import fs from "node:fs";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { TaskManager } from "../thalamus/router";
import { getSetupChecklist } from "../setupChecklist";
import { STATES } from "../domain/states";
import { buildContextPack, createContextMaterial } from "../orchestration/contextBuilder";
import type { ExecutorSimulatorOptions } from "../orchestration/executorSimulator";
import { runChat } from "../orchestration/chatRunner";
import { triageUserMessage } from "../orchestration/triage";
import type { SandboxAdapter } from "../sandbox";
import {
  createInMemoryObservabilityTrace,
  aggregateRunCost,
  aggregateConversationCost,
} from "../observability";
import { redactSecrets, redactString, redactOutbound, REDACTION_FAILED_ERROR } from "../security/redaction";
import {
  InMemoryRateLimiter,
  createRateLimitPolicy,
  rateLimitRuleFor,
  type RateLimitConfig,
  type RateLimitDecision,
  type RateLimiter,
} from "../security/rateLimiter";
import {
  SESSION_COOKIE_NAME,
  authErrorMessage,
  buildClearSessionCookie,
  buildSessionCookie,
  createSessionToken,
  parseAuthConfig,
  parseAuthMode,
  verifyPassword,
  verifySessionToken,
  type AuthMode,
  type ParsedAuthConfig,
} from "../security/auth";
import { createAuthMiddleware } from "../security/authMiddleware";
import { createUserStoresResolver, type UserStores } from "../security/userStores";
import {
  permissionsForRole,
  requirePermission as evaluatePermission,
  sendPermissionDenied,
  type Permission,
  type PermissionDenial,
  type WorkspaceRole,
} from "../security/rbac";
import {
  createInMemoryWorkspaceDirectory,
  WorkspaceMembershipSchema,
  type WorkspaceDirectory,
} from "../security/workspaces";
import {
  createInMemoryAuditLogService,
  hashAuditValue,
  type AuditLogService,
} from "../security/auditLog";
import {
  QuotaPolicySchema,
  createInMemoryQuotaService,
  type QuotaService,
} from "../security/quotas";
import { computeSetupStatus } from "../setupStatus";
import {
  ApprovalProcessingError,
  recordApprovalDecision,
  type ApprovalDecision,
} from "./approvalFlow";
import type { SecretStore } from "../security/secretStore";
import {
  createInMemoryProviderConfigStore,
  type ProviderConfigStore,
} from "../providers/configStore";
import {
  AzureProviderConfigSchema,
  CloudflareProviderConfigSchema,
  ProviderConfigRecordSchema,
  ProviderKindSchema,
  ProviderModelMapSchema,
  ProviderModelRoleSchema,
  type ProviderConfigRecord,
} from "../providers/config";
import { buildConfiguredRouter, resolveTestProvider } from "../providers/configBridge";
import {
  ORCHESTRATION_ROLE_DESCRIPTORS,
  OrchestrationAssignmentUpsertSchema,
  OrchestrationModelAssignmentSchema,
  OrchestrationRoleSchema,
  buildConfiguredAssignmentAwareRouter,
  createInMemoryOrchestrationAssignmentStore,
  createOrchestrationModelRouter,
  providerOptionsFromConfigState,
  resolveEffectiveAssignment,
  type EffectiveModelRoute,
  type OrchestrationAssignmentScope,
  type OrchestrationAssignmentStore,
  orchestrationAssignmentId,
  type OrchestrationModelAssignment,
  type OrchestrationRole,
} from "../providers/orchestrationAssignments";
import {
  TemplateApplyRequestSchema,
  TemplateImportSecretError,
  TemplateSaveCurrentRequestSchema,
  TemplateService,
  createInMemoryUserTemplateStore,
  type TemplatePreview,
  type UserTemplateStore,
} from "../templates";

// Chunk 34 memory providers (config + resolution). The runtime MemoryProvider + Local impl
// live in src/memory/provider.ts. We resolve once per app and use for neuro memory paths.
import {
  resolveActiveMemoryProvider,
  resolveTestMemoryProvider,
  createPureLocalMemoryProvider,
  MemoryProviderKindSchema,
  MemoryProviderConfigSchema,
  MemoryProviderRecordSchema,
  type MemoryProviderRecord,
  createInMemoryMemoryConfigStore,
  type MemoryConfigStore,
  MEMORY_ROLES,
  MEMORY_ROLE_DEFINITIONS,
  MemoryRoleSchema,
  createMemoryRoleAssignment,
  createInMemoryMemoryAssignmentStore,
  MemoryRoleRouter,
  memoryRoleResolutionToJson,
  memoryProviderCapabilitiesForKind,
  memoryCapabilityWarningsForRole,
  type MemoryRole,
  type MemoryRoleAssignment,
  type MemoryAssignmentStore,
} from "../providers";
import type { MemoryProvider } from "../memory/provider";
import { redactMemoryContent } from "../memory/adapterBase";
import { classifyProbeError, ProbeErrorCategorySchema, type ProbeFailureSignal } from "../providers/probe";
import {
  createModelDiscoveryService,
  type ModelDiscoveryService,
} from "../providers/discovery/service";
import { createDiscoveryCache } from "../providers/discovery/cache";
import { createDefaultDiscoveryAdapterRegistry } from "../providers/discovery/adapters/registry";
import type { DiscoveryResult } from "../providers/discovery/types";
import { createBuiltinModuleRegistry, type ModuleRegistry } from "../modules";
import { getNeuroAliveState } from "../modules/builtin/neuro-alive";
import {
  applyModuleConfigToRegistry,
  createInMemoryModuleConfigStore,
  createLocalModuleConfigStore,
  type ModuleConfigStore,
} from "../modules/moduleConfigStore";
import {
  AzureOpenAIProvider,
  CloudflareWorkersAIProvider,
  ProviderError,
  TogetherAIProvider,
  type LLMProvider,
  type LLMRequest,
  type ModelRouter,
} from "../providers/llm";
import type { OrchestratorMode } from "../deployment";
import {
  createRectorStore,
  SqlRectorStore,
  type CreateMemoryEntryInput,
  type MemoryEntry,
  type PersistenceConfig,
  type RectorStore,
} from "../store";
import { MemoryLayerSchema, RunEventSchema } from "../store/schemas";
import type { Artifact, MemoryLayer, Run, RunEvent } from "../store/schemas";
import { RunPhaseSchema, isTerminalRunPhase } from "../protocol/phases";
import { computeCommercialDeploymentReadiness } from "../deployment/readiness";

export interface ApiSecurityOptions {
  corsAllowedOrigins?: string[];
  rateLimit?: RateLimitConfig;
  /** Optional pluggable limiter backend; defaults to process-local in-memory buckets. */
  rateLimiter?: RateLimiter;
  /**
   * Orchestration wiring for the chat pipeline. `executorOptions`/`maxHealingAttempts` tune the
   * deterministic phases shared by both modes. `mode` and `router` are resolved once at startup
   * (`parseOrchestrationConfig` + `buildModelRouter`) and stored here so the chat runner can
   * dispatch by mode; `mode` defaults to `local` (provider-free) and `router` is optional because
   * local mode requires no provider. `sandbox` is the mode-selected Sandbox_Adapter resolved at
   * startup (the real E2B adapter in external mode, the network-free local runner in local mode —
   * Req 6.7); like `mode`/`router` it is accepted and stored without rewiring the endpoint, which
   * consumes it in a later task. The chat endpoint is wired to consume `mode`/`router` in a
   * later task; this option is accepted and stored without rewiring the endpoint.
   */
  orchestration?: {
    executorOptions?: ExecutorSimulatorOptions;
    maxHealingAttempts?: number;
    mode?: OrchestratorMode;
    router?: ModelRouter;
    sandbox?: SandboxAdapter;
  };
  /**
   * Persistence selection for the Rector store (ORN-39). Forwarded verbatim to
   * `createRectorStore`, which returns the default in-memory provider-free store when this is
   * absent or its `driver` is `memory`, a local file-backed SQLite store for `sqlite`, and the
   * optional hosted TiDB store for `tidb`. Omitting it preserves the pre-Phase-3 in-memory
   * regression baseline byte-for-byte.
   */
  persistence?: PersistenceConfig;

  /**
   * Pre-constructed store from boot-time Startup_Migration. When supplied, createApp skips
   * createRectorStore.
   */
  store?: RectorStore;

  /**
   * Optional {@link SecretStore} backing for the setup-status route's secret-presence booleans.
   * Additive and inert in Local_Mode: when omitted, an empty no-op store is used so every provider
   * is reported as absent and no secret value is ever read. A real backing (e.g.
   * `createLocalSecretStore`) can be injected here without touching the route.
   */
  secretStore?: SecretStore;

  /**
   * Optional {@link ProviderConfigStore} backing for the in-app BYOK provider configuration
   * (Provider_Config_API, design section C2/C7). Stores **non-secret** Provider_Config_Records and
   * the Active_Route_Map only; secrets live in {@link ApiSecurityOptions.secretStore}. Additive and
   * inert when omitted: the real (non-test) app injects a `createLocalProviderConfigStore`
   * (`.rector/providers.json`) here, while tests can inject `createInMemoryProviderConfigStore` (or
   * omit it). The CRUD/selection routes (task 5.2) and the upgraded connection test (task 5.3)
   * consume this store; this option is accepted and stored without forcing a real disk store in
   * tests.
   */
  providerConfigStore?: ProviderConfigStore;

  /**
   * Optional {@link MemoryConfigStore} backing for the in-app pluggable memory provider
   * configuration (Chunk 34). Stores **non-secret** MemoryProviderRecords + the active id only;
   * secrets live in {@link ApiSecurityOptions.secretStore} (reused, with "memory:" prefixed refs).
   * Additive and inert when omitted: the real app injects createLocalMemoryConfigStore
   * (`.rector/memory-providers.json`); tests get a pure local-inmemory default via the bridge.
   * This is the UI-configurable "agent memory database provider" (local-inmemory, local-sqlite-mem,
   * Mem0, TiDB-memory, etc.) per the hassle-free vision. Neuro memory paths (notes, context) use
   * the resolved provider; RectorStore.memory* surface remains for main persistence tests.
   */
  memoryConfigStore?: MemoryConfigStore;

  /**
   * Optional non-secret role → provider/model assignment store (Chunk 043). Assignments contain
   * provider/model ids, budgets, and capability flags only; API keys remain exclusively in
   * SecretStore-backed provider records. When omitted, tests/local mode get an in-memory empty store
   * and the deterministic/provider-free fallback remains unchanged.
   */
  orchestrationAssignmentStore?: OrchestrationAssignmentStore;

  /**
   * Optional Memory_Assignment_Store (Chunk 044). Persists non-secret role -> provider links only;
   * provider secrets remain exclusively in Secret_Store through MemoryProviderRecord.secretRef.
   */
  memoryAssignmentStore?: MemoryAssignmentStore;

  /** Optional persisted module enable/disable state (Chunk 041). */
  moduleConfigStore?: ModuleConfigStore;

  /** Optional Chunk 045 user template store. Template application writes through the durable assignment stores above. */
  userTemplateStore?: UserTemplateStore;

  /** Backward-compatible alias for early Chunk 045 tests/callers; `memoryAssignmentStore` takes precedence. */
  memoryRoleAssignmentStore?: MemoryAssignmentStore;

  /**
   * Optional override for {@link resolveTestMemoryProvider} used by
   * `POST /api/memory-providers/:id/test-connection`. Enables deterministic
   * doubles in unit tests without touching the route.
   */
  resolveTestMemoryProvider?: (
    providerId: string,
    configStore: MemoryConfigStore,
    secrets: SecretStore,
  ) => Promise<MemoryProvider | undefined>;

  /**
   * Optional, read-only {@link WorkspaceSafetyConfig} surfaced by the workspace-safety route
   * (`GET /api/setup/workspace`, Requirement 3). Additive and inert in Local_Mode: when omitted,
   * the route resolves a default config from the ambient environment via
   * {@link resolveWorkspaceSafetyConfig} that mirrors the sandbox defaults (workspace root from
   * `RECTOR_WORKSPACE_ROOT`/`process.cwd()`, always-on destructive protection). Inject a config here
   * (e.g. with deterministic doubles) without touching the route. The route only reads this
   * configuration and never executes any command.
   */
  workspaceSafety?: WorkspaceSafetyConfig;

  /**
   * Optional {@link ModelDiscoveryService} backing the Discovery_API endpoints
   * (`GET /api/providers/:id/models`, `POST /api/providers/:id/models/refresh`; design section C,
   * Req 17). Additive and inert when omitted: the route layer constructs a default service from the
   * injected {@link ApiSecurityOptions.providerConfigStore} and {@link ApiSecurityOptions.secretStore}
   * plus a fresh {@link DiscoveryCache} and the default per-kind adapter registry. The cache is owned
   * by the single service instance so a refresh overwrites exactly the entry a subsequent read
   * serves. Tests can inject a deterministic service (e.g. with an injected clock and a mocked
   * `fetch`) here without touching the routes.
   */
  modelDiscoveryService?: ModelDiscoveryService;

  /**
   * Opt-in multi-user session auth (chunk-037). When omitted, {@link parseAuthConfig}
   * reads `RECTOR_AUTH_ENABLED` from the environment. Disabled by default so local
   * mode requires zero auth (Req 9).
   */
  auth?: ParsedAuthConfig;

  /** Commercial auth mode selection. Defaults from RECTOR_AUTH_MODE/RECTOR_AUTH_ENABLED. */
  authMode?: AuthMode;

  /** Optional workspace directory/membership backing for RBAC and isolation tests/deployments. */
  workspaceDirectory?: WorkspaceDirectory;

  /** Optional audit log service. Real boot can inject a durable local JSONL service. */
  auditLog?: AuditLogService;

  /** Optional workspace quota service. Defaults to an allow-all in-memory service. */
  quotaService?: QuotaService;

  /** Env map consumed by deployment-readiness checks. Defaults to process.env. */
  deploymentEnv?: Record<string, string | undefined>;

  /**
   * 32-byte AES key for per-user Secret_Store envelopes when auth is enabled.
   * The real app supplies {@link resolveSecretEncryptionKey} from `bin/server.ts`.
   */
  secretEncryptionKey?: Buffer;
}

/**
 * Empty, inert {@link SecretStore} used as the default backing for the setup-status route.
 *
 * Local_Mode requires no provider secrets, so the default store reports every provider as absent
 * and never persists anything. It performs no I/O and surfaces no value — `getSecret` always fails
 * with a redaction-safe "not configured" message and `setSecret` is a no-op success — keeping the
 * setup-status handler fast, non-blocking, and additive. A real backing
 * (`createLocalSecretStore`) can be injected via {@link ApiSecurityOptions.secretStore}.
 */
function createEmptySecretStore(): SecretStore {
  return {
    async setSecret() {
      return { ok: true, value: undefined };
    },
    async getSecret(providerId: string) {
      return { ok: false, error: `No secret stored for provider "${providerId}".` };
    },
    async hasSecret() {
      return false;
    },
    async deleteSecret() {
      return { ok: true, value: undefined };
    },
  };
}

// --- Provider connection-test service (ORN-32) ---

/**
 * Supported provider identifiers the connection test can build and ping. Any value outside this
 * set is rejected as CONFIG_INVALID before any provider is constructed or any network call occurs.
 */
export const SUPPORTED_PROVIDER_IDS = ["together", "cloudflare", "azure-openai"] as const;

/** Type guard for the supported provider id set, used to reject unsupported ids with a 400.
 *
 * Retained as a public helper for the {@link SUPPORTED_PROVIDER_IDS} kind-level guard and the
 * env-based fallback resolution. The upgraded `POST /api/setup/test-connection` route now keys
 * selection off persisted Provider_Config_Records via the Config_Bridge (so any configured kind,
 * including `openai-compatible`, is testable); an id with no matching persisted record is rejected
 * pre-build by the route instead. */
export function isSupportedProviderId(providerId: string): boolean {
  return (SUPPORTED_PROVIDER_IDS as readonly string[]).includes(providerId);
}

export const TestConnectionRequestSchema = z.object({
  providerId: z.string().min(1), // "together" | "cloudflare" | "azure-openai"
  // Optional per-model Model_Probe targeting (Req 22.1, 22.2). When the Setup_UI tests a selected
  // Model_Candidate it sends the candidate's `model` (and, for Azure OpenAI, its `deployment`) so a
  // single ping targets exactly that candidate. Both omitted => the prior whole-provider test.
  model: z.string().min(1).optional(),
  deployment: z.string().min(1).optional(),
});
export type TestConnectionRequest = z.infer<typeof TestConnectionRequestSchema>;

export const TestConnectionResponseSchema = z.object({
  ok: z.boolean(),
  providerId: z.string().min(1),
  model: z.string().optional(), // present only on success
  code: z.string().optional(), // ProviderErrorCode on failure
  // Classified Probe_Error_Category on failure (Req 23.1, 23.2) so the UI can tell the user whether
  // to fix their key, region, deployment, or model access. Absent on success.
  category: ProbeErrorCategorySchema.optional(),
  error: z.string().optional(), // redacted message on failure
  networkAttempted: z.boolean(), // false when config invalid blocks before any call
});
export type TestConnectionResponse = z.infer<typeof TestConnectionResponseSchema>;

/**
 * Builds exactly one provider instance for the requested id, wired with the injected `fetchImpl`
 * and `enableNetwork`. Reads only the env key names the provider needs; never logs values. Returns
 * `undefined` for an unsupported/unknown provider id so the caller can short-circuit safely.
 */
function resolveConnectionTestProvider(
  providerId: string,
  env: Record<string, string | undefined>,
  options: { enableNetwork: boolean; fetchImpl: typeof fetch }
): LLMProvider | undefined {
  const { enableNetwork, fetchImpl } = options;
  switch (providerId) {
    case "together":
      return new TogetherAIProvider({
        apiKey: env.TOGETHER_API_KEY,
        baseUrl: env.TOGETHER_BASE_URL,
        enableNetwork,
        fetchImpl,
      });
    case "cloudflare":
      return new CloudflareWorkersAIProvider({
        accountId: env.CLOUDFLARE_ACCOUNT_ID,
        apiToken: env.CLOUDFLARE_API_TOKEN,
        baseUrl: env.CLOUDFLARE_BASE_URL,
        enableNetwork,
        fetchImpl,
      });
    case "azure-openai":
      return new AzureOpenAIProvider({
        apiKey: env.AZURE_OPENAI_API_KEY,
        endpoint: env.AZURE_OPENAI_ENDPOINT,
        apiVersion: env.AZURE_OPENAI_API_VERSION,
        deployments: {
          cheap: env.AZURE_OPENAI_CHEAP_DEPLOYMENT,
          fast: env.AZURE_OPENAI_FAST_DEPLOYMENT ?? env.AZURE_OPENAI_DEPLOYMENT,
          flagship: env.AZURE_OPENAI_FLAGSHIP_DEPLOYMENT ?? env.AZURE_OPENAI_DEPLOYMENT,
          research: env.AZURE_OPENAI_RESEARCH_DEPLOYMENT,
        },
        enableNetwork,
        fetchImpl,
      });
    default:
      return undefined;
  }
}

/**
 * Verifies a single provider's credentials with at most one minimal network ping.
 *
 * Pure and unit-testable via an injected `fetchImpl`. Resolution of the provider is decoupled from
 * the ping so this core works for both wiring paths (design C8):
 * - **Config_Bridge path (route):** the caller passes an already-resolved `provider`, built from
 *   persisted config + secret via `resolveTestProvider`. This is the path `POST
 *   /api/setup/test-connection` now uses so the test reflects persisted UI configuration.
 * - **Env fallback path:** when no `provider` is supplied, a single provider is resolved from the
 *   injected `env` via {@link resolveConnectionTestProvider} (used by the unit/property tests and
 *   any caller without a Config_Bridge in scope).
 *
 * Guarantees:
 * - No resolvable provider (unknown/unsupported id, or neither `provider` nor `env` supplied) =>
 *   `CONFIG_INVALID`, `networkAttempted: false`, zero calls.
 * - `validateConfig()` runs first; on failure => `CONFIG_INVALID`, `networkAttempted: false`.
 * - Otherwise a single `invoke()` ping (small `maxOutputTokens`) is attempted.
 * - Every outbound error message is passed through `redactString`; the response never includes the
 *   API key, Authorization header, or the raw provider body.
 */
export async function runConnectionTest(input: {
  providerId: string;
  /**
   * Pre-resolved provider (Config_Bridge path). When supplied it is pinged directly, so the test
   * reflects the persisted config + secret the route resolved via `resolveTestProvider`.
   */
  provider?: LLMProvider;
  /**
   * Env-based fallback resolution. Used ONLY when `provider` is not supplied; a single provider is
   * resolved from this env map via {@link resolveConnectionTestProvider}.
   */
  env?: Record<string, string | undefined>;
  /**
   * Optional per-model Model_Probe targeting (Req 22.1, 22.2). When a `model` (or, for Azure
   * OpenAI, a `deployment`) is supplied, the single ping sets the request `model` to it so the
   * probe targets exactly the selected Model_Candidate rather than the provider's default route.
   * Azure addresses a candidate by deployment name, so `deployment` is preferred when present.
   */
  model?: string;
  deployment?: string;
  fetchImpl: typeof fetch;
}): Promise<TestConnectionResponse> {
  const { providerId, fetchImpl } = input;
  // Azure addresses a candidate by deployment name; the OpenAI-compatible/Together kinds by model
  // id. Both flow through the request `model` field, which every provider honors over its default.
  const targetModel = input.deployment ?? input.model;

  const provider =
    input.provider ??
    (input.env !== undefined
      ? resolveConnectionTestProvider(providerId, input.env, { enableNetwork: true, fetchImpl })
      : undefined);
  if (!provider) {
    return TestConnectionResponseSchema.parse({
      ok: false,
      providerId,
      code: "CONFIG_INVALID",
      category: classifyProbeError({ code: "CONFIG_INVALID", message: `Unsupported providerId: ${providerId}` }),
      error: redactString(`Unsupported providerId: ${providerId}`),
      networkAttempted: false,
    });
  }

  // Config validation short-circuits BEFORE any network call is attempted.
  try {
    provider.validateConfig();
  } catch (error) {
    return TestConnectionResponseSchema.parse({
      ok: false,
      providerId,
      code: error instanceof ProviderError ? error.code : "CONFIG_INVALID",
      category: classifyProbeError(probeFailureSignal(error)),
      error: redactString(connectionTestErrorMessage(error)),
      networkAttempted: false,
    });
  }

  const pingRequest: LLMRequest = {
    messages: [
      { role: "system", content: "ping" },
      { role: "user", content: "reply with: pong" },
    ],
    maxOutputTokens: 8,
    task: "connection-test",
    // Target the selected candidate (Req 22.1, 22.2) when supplied; otherwise the provider falls
    // back to its configured default route exactly as the prior whole-provider test did.
    ...(targetModel !== undefined ? { model: targetModel } : {}),
  };

  try {
    const response = await provider.invoke(pingRequest);
    return TestConnectionResponseSchema.parse({
      ok: true,
      providerId,
      model: response.model,
      networkAttempted: true,
    });
  } catch (error) {
    return TestConnectionResponseSchema.parse({
      ok: false,
      providerId,
      code: error instanceof ProviderError ? error.code : "PROVIDER_ERROR",
      // Classify the failure into a Probe_Error_Category (Req 23.1, 23.2). The raw message is used
      // only for classification; the user-facing `error` is routed through `redactString` (Req 23.3).
      category: classifyProbeError(probeFailureSignal(error)),
      error: redactString(connectionTestErrorMessage(error)),
      networkAttempted: true,
    });
  }
}

function connectionTestErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Assemble the internal-only {@link ProbeFailureSignal} from a thrown error for {@link classifyProbeError}.
 *
 * Pulls the provider error `code`/`status` when the failure is a {@link ProviderError} and the raw
 * `message` for keyword classification. The message is consumed by the classifier only; the
 * user-facing message is redacted separately via `redactString` (Req 23.3), so no raw provider body
 * or secret leaves on the classification path.
 */
function probeFailureSignal(error: unknown): ProbeFailureSignal {
  if (error instanceof ProviderError) {
    return { code: error.code, status: error.status, message: error.message };
  }
  if (error instanceof Error) return { message: error.message };
  return { message: String(error) };
}

/** Builds a concise, redaction-ready message from a Zod (or other) request-body parse failure. */
function requestValidationMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    const summary = error.issues
      .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
      .join("; ");
    return `Invalid request body: ${summary}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Listener invoked with each persisted (already-redacted) {@link RunEvent} published for a run. */
export type RunEventListener = (event: RunEvent) => void;

/**
 * In-process publish/subscribe over persisted (already-redacted) run events, keyed by `runId`.
 *
 * Streaming (ORN-40) reuses the run events that `transitionRun`/`runEvent` already persist (and
 * redact). The broker carries those persisted events to SSE subscribers; no secret can enter a
 * frame because only persisted {@link RunEvent}s are published. The broker is a small, self-
 * contained pub/sub with no I/O and no timers.
 */
export interface RunEventBroker {
  /** Deliver `event` to every current listener for `runId` only. A no-op when there are none. */
  publish(runId: string, event: RunEvent): void;
  /**
   * Register `listener` for a specific `runId`. Returns an unsubscribe function that removes
   * exactly that listener; after unsubscribe the listener receives no further events.
   */
  subscribe(runId: string, listener: RunEventListener): () => void;
}

/**
 * Create an in-process {@link RunEventBroker}.
 *
 * Listeners are kept per `runId` in a `Map<string, Set<RunEventListener>>`, so a publish for one
 * run never reaches another run's listeners. Used by `withEventBroadcast` (task 6.2) and the SSE
 * stream route (task 7.x).
 */
export function createRunEventBroker(): RunEventBroker {
  const listenersByRun = new Map<string, Set<RunEventListener>>();

  return {
    publish(runId, event) {
      const listeners = listenersByRun.get(runId);
      if (!listeners || listeners.size === 0) return;
      // Snapshot so a listener that subscribes/unsubscribes during delivery cannot disrupt this pass.
      for (const listener of [...listeners]) {
        listener(event);
      }
    },
    subscribe(runId, listener) {
      let listeners = listenersByRun.get(runId);
      if (!listeners) {
        listeners = new Set<RunEventListener>();
        listenersByRun.set(runId, listeners);
      }
      listeners.add(listener);

      return () => {
        const current = listenersByRun.get(runId);
        if (!current) return;
        current.delete(listener);
        if (current.size === 0) listenersByRun.delete(runId);
      };
    },
  };
}

/**
 * Wrap any {@link RectorStore} so that every appended or committed run event is published to the
 * {@link RunEventBroker} **only after** the underlying store has persisted and redacted it (ORN-40).
 *
 * The returned value is a `RectorStore` with an unchanged interface: every method delegates to the
 * wrapped `store`. For the two methods that create run events — `appendEvent` and
 * `commitRunTransition` — the decorator FIRST awaits the underlying call (so the event is persisted
 * and redacted, and the canonical persisted event is returned) and ONLY THEN publishes that returned
 * event via `broker.publish(persistedEvent.runId, persistedEvent)`. It always publishes the value
 * RETURNED by the store, never the input argument, guaranteeing publish-after-persist and that only
 * persisted, redacted data is broadcast. If the underlying call throws (e.g. a duplicate event id or
 * a rolled-back transition), nothing is published. All other methods pass through unchanged.
 *
 * Works transparently over any `RectorStore` implementation (InMemory, SQLite, or TiDB).
 */
export function withEventBroadcast(store: RectorStore, broker: RunEventBroker): RectorStore {
  return {
    createConversation: (input) => store.createConversation(input),
    getConversation: (id) => store.getConversation(id),
    listConversations: (workspaceId) => store.listConversations(workspaceId),
    updateConversation: (id, patch) => store.updateConversation(id, patch),
    deleteConversation: (id) => store.deleteConversation(id),

    createMessage: (input) => store.createMessage(input),
    getMessage: (id) => store.getMessage(id),
    listMessages: (conversationId) => store.listMessages(conversationId),
    updateMessage: (id, patch) => store.updateMessage(id, patch),
    deleteMessage: (id) => store.deleteMessage(id),

    createRun: (input) => store.createRun(input),
    getRun: (id) => store.getRun(id),
    listRuns: (conversationId) => store.listRuns(conversationId),
    updateRun: (id, patch) => store.updateRun(id, patch),
    deleteRun: (id) => store.deleteRun(id),

    // Publish-after-persist: await the underlying transition first, then broadcast only the
    // canonical persisted (already-redacted) event the store returned. A throw never publishes.
    async commitRunTransition(runId, patch, event) {
      const result = await store.commitRunTransition(runId, patch, event);
      broker.publish(result.event.runId, result.event);
      return result;
    },

    // Publish-after-persist: await the underlying append first, then broadcast only the persisted
    // (already-redacted) event the store returned. If the append throws, nothing is published.
    async appendEvent(event) {
      const persistedEvent = await store.appendEvent(event);
      broker.publish(persistedEvent.runId, persistedEvent);
      return persistedEvent;
    },
    getEvent: (id) => store.getEvent(id),
    listEvents: (runId) => store.listEvents(runId),
    deleteEvent: (id) => store.deleteEvent(id),

    createArtifact: (input) => store.createArtifact(input),
    getArtifact: (id) => store.getArtifact(id),
    listArtifacts: (kind) => store.listArtifacts(kind),
    updateArtifact: (id, patch) => store.updateArtifact(id, patch),
    deleteArtifact: (id) => store.deleteArtifact(id),

    createMemoryEntry: (input) => store.createMemoryEntry(input),
    getMemoryEntry: (id) => store.getMemoryEntry(id),
    listMemoryEntries: (layer) => store.listMemoryEntries(layer),
    updateMemoryEntry: (id, patch) => store.updateMemoryEntry(id, patch),
    deleteMemoryEntry: (id) => store.deleteMemoryEntry(id),
    searchMemory: (query, options) => store.searchMemory(query, options),
    pruneMemory: (options) => store.pruneMemory(options),
  };
}

// --- SSE frame contract (ORN-40, task 7.1) ---

/**
 * Minimal, forward-compatible payload carried by a `cost` SSE frame.
 *
 * The canonical per-run cost aggregate (`RunCostAggregateSchema`/`RunCostAggregate`) is introduced
 * by the cost dashboard work (task 10.1 in `src/observability`) and surfaced live over the stream
 * by task 11.2. Until that schema exists, the `cost` frame models exactly the design's live cost
 * frame shape — numeric totals plus de-duplicated, non-secret provider/model identifiers only — so
 * downstream tasks can swap in the imported `RunCostAggregateSchema` with no change to the frame
 * shape. It deliberately carries no secret-bearing field (no keys, headers, or raw model output).
 *
 * NOTE: task 10.1/11.2 will refine this to import the canonical `RunCostAggregateSchema` once it is
 * defined; the field set here is kept identical to that design shape to make the swap mechanical.
 */
const SseCostPayloadSchema = z.object({
  runId: z.string().min(1),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  estimatedUsd: z.number().nonnegative(),
  modelCalls: z.number().int().nonnegative(),
  providers: z.array(z.string().min(1)), // distinct provider ids, never secrets
  models: z.array(z.string().min(1)), // distinct model ids, never secrets
});

/**
 * The Server-Sent Events frame contract for the run stream (ORN-40). A discriminated union over a
 * `type` field with four variants, each carrying ONLY persisted, redaction-applied data:
 *
 * - `run-event`: carries the already-persisted, already-redacted {@link RunEvent} (validated by the
 *   store's `RunEventSchema` before persistence), replayed during catch-up and streamed live.
 * - `cost`: carries the live per-run cost aggregate ({@link SseCostPayloadSchema}) — numbers and
 *   non-secret provider/model ids only. Emitted by task 11.2; see the note on `SseCostPayloadSchema`.
 * - `done`: the terminal frame carrying only the terminal run `phase` (one of the terminal phases).
 * - `error`: carries a `message: string` that MUST be passed through `redactString` at construction
 *   time. The schema field is a plain string; redaction is a construction-time invariant, not a
 *   schema transform, because the same redaction boundary applies to every streamed surface.
 *
 * Every frame is derived from persisted, redacted data, so no secret value can appear in any frame.
 */
export const SseFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run-event"), runId: z.string().min(1), event: RunEventSchema }),
  z.object({ type: z.literal("cost"), runId: z.string().min(1), cost: SseCostPayloadSchema }),
  z.object({ type: z.literal("done"), runId: z.string().min(1), phase: RunPhaseSchema }),
  // `message` is redacted via `redactString` at construction time (see doc above).
  z.object({ type: z.literal("error"), runId: z.string().min(1), message: z.string() }),
]);
export type SseFrame = z.infer<typeof SseFrameSchema>;

// --- SSE run stream route (ORN-40, task 7.2) ---

/** Default heartbeat cadence (15s) for an open stream, per Requirement 2.10. */
const DEFAULT_SSE_HEARTBEAT_MS = 15_000;

/**
 * Episodic memory search cap for the chat pipeline context builder (Chunk 36).
 * Bounds token injection from recent notes/episodic entries into each run's ContextPack.
 */
const EPISODIC_MEMORY_SEARCH_LIMIT = 6;

/**
 * Serialize an {@link SseFrame} to the Server-Sent Events wire format.
 *
 * Every frame is validated through {@link SseFrameSchema} BEFORE it is written, so only persisted,
 * redaction-applied data ever reaches the wire (no secret can appear in a frame). The frame's
 * discriminant `type` is emitted as the SSE `event:` name (so the browser `EventSource` can use
 * named listeners) and the full validated frame is the JSON `data:` payload.
 */
export function serializeSseFrame(frame: SseFrame): string {
  const validated = SseFrameSchema.parse(frame);
  return `event: ${validated.type}\ndata: ${JSON.stringify(validated)}\n\n`;
}

/**
 * The minimal subset of an Express `Response` the SSE stream needs. Modeled as an interface so the
 * teardown/redaction tests (tasks 7.4/7.5) can drive the handler with an injectable fake `res`
 * that records writes and `end()` calls without a real socket.
 */
export interface SseResponseLike {
  setHeader(name: string, value: string): void;
  flushHeaders?(): void;
  write(chunk: string): void;
  end(): void;
}

/** The minimal subset of an Express `Request` the SSE stream needs (client-disconnect signal). */
export interface SseRequestLike {
  on(event: "close", listener: () => void): void;
}

export interface RunStreamHandlerOptions {
  runId: string;
  req: SseRequestLike;
  res: SseResponseLike;
  store: RectorStore;
  broker: RunEventBroker;
  /** Heartbeat cadence in ms; defaults to {@link DEFAULT_SSE_HEARTBEAT_MS}. */
  heartbeatMs?: number;
  /** Injectable timer factory so tests can drive the heartbeat with a fake clock. */
  setIntervalImpl?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalImpl?: (handle: ReturnType<typeof setInterval>) => void;
}

/**
 * Core SSE stream handler for `GET /api/runs/:id/stream` (ORN-40).
 *
 * Lifecycle:
 *  1. Set SSE headers (`text/event-stream`, `no-cache`, `keep-alive`) and flush them.
 *  2. **Subscribe FIRST, then replay** — to guarantee no event is dropped or doubled across the
 *     catch-up→live boundary, the handler subscribes to the broker *before* it reads the persisted
 *     snapshot. Events that arrive while the snapshot is being read/emitted are buffered, not lost.
 *     The catch-up replay (`listEvents(runId)`, ascending insertion order) emits each event exactly
 *     once and records its id; the buffered live events are then flushed with de-duplication by
 *     event id (an event present in both the snapshot and the buffer is emitted once, an event only
 *     in the buffer is still emitted). After the flush, live events emit directly. Net result: no
 *     omission (subscribed before the snapshot) and no duplicate (de-dup by id).
 *  3. Emit each event as a `run-event` frame.
 *  4. On the first event carrying a Terminal_Phase, emit exactly one `done` frame and tear down.
 *  5. Heartbeat (`: keep-alive`) every `heartbeatMs`, carrying no run data; cleared on teardown.
 *  6. A client disconnect (`req.on("close")`) performs the same single clean teardown.
 *
 * A non-existent `runId` simply yields an empty snapshot: the handler replays nothing, stays
 * subscribed for live events, and fabricates no payload (Requirement 2.9).
 */
export async function handleRunStream(options: RunStreamHandlerOptions): Promise<void> {
  const { runId, req, res, store, broker, heartbeatMs = DEFAULT_SSE_HEARTBEAT_MS } = options;
  const setIntervalImpl = options.setIntervalImpl ?? ((handler, ms) => setInterval(handler, ms));
  const clearIntervalImpl = options.clearIntervalImpl ?? ((handle) => clearInterval(handle));

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  let closed = false;
  let replaying = true;
  const emittedIds = new Set<string>();
  const liveBuffer: RunEvent[] = [];
  // Every event emitted as a `run-event` frame (catch-up + live), in order, so the live `cost`
  // frame can be recomputed from the full set of events seen so far via `aggregateRunCost` — the
  // exact same fold the `GET /api/runs/:id/cost` endpoint uses, so the live total always matches.
  const seenEvents: RunEvent[] = [];
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  /** Single, idempotent teardown: optional final frame, then unsubscribe + clear timer + end once. */
  const teardown = (finalFrame?: SseFrame): void => {
    if (closed) return;
    closed = true;
    if (finalFrame) res.write(serializeSseFrame(finalFrame));
    unsubscribe?.();
    if (heartbeat !== undefined) clearIntervalImpl(heartbeat);
    res.end();
  };

  /**
   * Does this persisted event carry provider-call/usage metadata? `chatRunner` records a
   * `providerCall` object on the event payload for the live PLANNING / SKEPTIC_REVIEW /
   * SYNTHESIZING transitions; local-mode events carry none. Gating the live `cost` frame on this
   * (Requirement 3.7 — "after each published provider-call event") means non-provider events do not
   * spam identical cost frames. Read defensively, mirroring `aggregateRunCost`'s own extraction.
   */
  const carriesProviderCall = (event: RunEvent): boolean => {
    const payload = event.payload;
    if (payload === null || typeof payload !== "object") return false;
    const providerCall = (payload as Record<string, unknown>).providerCall;
    return providerCall !== null && typeof providerCall === "object";
  };

  /**
   * Emit one persisted event as a `run-event` frame (de-duplicated by id). Returns true when the
   * event is terminal — in which case it has already emitted the single `done` frame and torn down.
   *
   * Frame ordering per event: `run-event` first; then, when the event carries provider-call usage,
   * a live `cost` frame with the current {@link RunCostAggregate} recomputed from all events seen so
   * far; then, when the event is terminal, the single `done` frame (so a terminal provider-call
   * event yields run-event → cost → done, with `done` still emitted exactly once and last).
   */
  const emitEvent = (event: RunEvent): boolean => {
    if (closed) return false;
    if (emittedIds.has(event.id)) return false; // boundary de-dup: never emit the same event twice
    emittedIds.add(event.id);
    seenEvents.push(event);
    res.write(serializeSseFrame({ type: "run-event", runId, event }));
    // Live running total: after a provider-call event, surface the current RunCostAggregate so the
    // UI shows a live cost/token total. The aggregate is numbers + non-secret provider/model ids
    // only and is validated by SseFrameSchema before it is written, preserving the no-secret guard.
    if (carriesProviderCall(event)) {
      res.write(serializeSseFrame({ type: "cost", runId, cost: aggregateRunCost(runId, seenEvents) }));
    }
    if (isTerminalRunPhase(event.phase)) {
      teardown({ type: "done", runId, phase: event.phase });
      return true;
    }
    return false;
  };

  // Subscribe BEFORE reading the snapshot so nothing published during catch-up is missed. While
  // replaying we buffer; once the boundary is crossed, live events emit directly (still de-duped).
  unsubscribe = broker.subscribe(runId, (event) => {
    if (closed) return;
    if (replaying) {
      liveBuffer.push(event);
      return;
    }
    emitEvent(event);
  });

  // Client disconnect before a terminal phase => clean teardown (no leaked listener/timer).
  req.on("close", () => teardown());

  try {
    // Catch-up: replay already-persisted events exactly once, in ascending insertion order.
    const persisted = await store.listEvents(runId);
    for (const event of persisted) {
      if (closed) return;
      if (emitEvent(event)) return; // terminal phase observed during catch-up
    }

    // Boundary: stop buffering and flush events that arrived during catch-up (de-duped by id).
    // No live publish can interleave here — everything from this point is synchronous.
    replaying = false;
    const buffered = liveBuffer.splice(0, liveBuffer.length);
    for (const event of buffered) {
      if (closed) return;
      if (emitEvent(event)) return; // terminal phase observed while flushing the boundary buffer
    }
  } catch {
    // A catch-up read failure tears down cleanly without emitting any fabricated/secret payload.
    teardown();
    return;
  }

  if (closed) return;

  // Heartbeat: an SSE comment carrying no run data, cleared on teardown (Requirement 2.10).
  heartbeat = setIntervalImpl(() => {
    if (closed) return;
    res.write(": keep-alive\n\n");
  }, heartbeatMs);
}

/**
 * Register `GET /api/runs/:id/stream` as an SSE endpoint backed by {@link handleRunStream}.
 *
 * The route is intentionally thin: it forwards the Express `req`/`res` (which structurally satisfy
 * {@link SseRequestLike}/{@link SseResponseLike}) and the injected `store`/`broker` to the handler.
 * The `store` should be the broker-wrapped store (`withEventBroadcast`) so live appended/committed
 * events flow to subscribers.
 */
export function registerRunStreamRoute(
  app: express.Application,
  deps: {
    store: RectorStore;
    broker: RunEventBroker;
    heartbeatMs?: number;
    authorizeRunRead?: (req: express.Request, res: express.Response, runId: string) => Promise<boolean>;
  }
): void {
  app.get("/api/runs/:id/stream", async (req, res) => {
    if (deps.authorizeRunRead && !(await deps.authorizeRunRead(req, res, req.params.id))) return;
    void handleRunStream({
      runId: req.params.id,
      req,
      res,
      store: deps.store,
      broker: deps.broker,
      heartbeatMs: deps.heartbeatMs,
    });
  });
}

// --- Workspace safety status (Requirement 3) ---

/**
 * The approval-required operation categories the Workspace_Safety_Panel reports (Requirement 3.4).
 *
 * `FILE_WRITE` is always present because the workspace sandbox never applies a patch
 * (`PROPOSE_PATCH`) without a matching `FILE_WRITE` approval. `COMMAND` is present only when at
 * least one risky command is configured, because the sandbox gates risky `RUN_COMMAND`s behind a
 * `COMMAND` approval (read-only/idempotent allowlisted commands run without one).
 */
const FILE_WRITE_APPROVAL_CATEGORY = "FILE_WRITE";
const COMMAND_APPROVAL_CATEGORY = "COMMAND";

/**
 * Read-only configuration describing the workspace sandbox safety policy, sourced from the same
 * inputs the {@link WorkspaceSandboxAdapter} is constructed from. This carries configuration only;
 * it authorizes no execution. A missing/empty `workspaceRoot` models the "policy cannot be
 * retrieved" case and yields an unavailable response (Requirement 3.8).
 */
export interface WorkspaceSafetyConfig {
  /** Absolute workspace root (the containment boundary). Missing/empty => unavailable (Req 3.8). */
  workspaceRoot?: string;
  /** Commands permitted for `RUN_COMMAND` (exact match); empty by default (Req 3.2). */
  allowlistedCommands?: string[];
  /** Allowlisted commands that additionally require an explicit `COMMAND` approval (Req 3.4). */
  riskyCommands?: string[];
  /**
   * Whether destructive-command protection is enforced. The workspace sandbox always enforces its
   * destructive denylist, so this defaults to enabled; an explicit `false` reports it disabled
   * (Req 3.3).
   */
  destructiveProtectionEnabled?: boolean;
}

/**
 * The redacted, read-only workspace safety summary the Workspace_Safety_Panel renders (Req 3).
 */
export interface WorkspaceSafetyResponse {
  /** Configured workspace root, routed through the Redaction_Layer (Req 3.1, 3.7). */
  workspaceRoot: string;
  /** Allowlisted commands enforced by the sandbox (Req 3.2). */
  allowlistedCommands: string[];
  /** Destructive command protection status (Req 3.3). */
  destructiveProtection: "enabled" | "disabled";
  /** Operation categories that require user approval before execution (Req 3.4). */
  approvalRequiredCategories: string[];
  /** `false` when the root or policy cannot be retrieved; the panel then shows an error (Req 3.8). */
  available: boolean;
}

/** The unavailable workspace-safety response: no root, no policy, no action surface (Req 3.8). */
const UNAVAILABLE_WORKSPACE_SAFETY: WorkspaceSafetyResponse = {
  workspaceRoot: "",
  allowlistedCommands: [],
  destructiveProtection: "disabled",
  approvalRequiredCategories: [],
  available: false,
};

/**
 * Build the redacted, read-only {@link WorkspaceSafetyResponse} from a {@link WorkspaceSafetyConfig}.
 *
 * Pure and side-effect-free: it reads configuration only and never executes a command (Req 3.5,
 * 3.6). The configured workspace root is routed through `redactString` before it is returned
 * (Req 3.7). When the workspace root or policy cannot be retrieved — a missing/blank root, or any
 * failure while assembling the policy — it returns the unavailable response with `available:false`
 * and no action surface (Req 3.8).
 */
export function buildWorkspaceSafetyResponse(config: WorkspaceSafetyConfig): WorkspaceSafetyResponse {
  try {
    const root = config.workspaceRoot;
    if (typeof root !== "string" || root.trim().length === 0) {
      return { ...UNAVAILABLE_WORKSPACE_SAFETY };
    }

    const allowlistedCommands = [...(config.allowlistedCommands ?? [])];
    const riskyCommands = config.riskyCommands ?? [];

    // FILE_WRITE always requires approval; COMMAND only when a risky command is configured.
    const approvalRequiredCategories = [FILE_WRITE_APPROVAL_CATEGORY];
    if (riskyCommands.length > 0) {
      approvalRequiredCategories.push(COMMAND_APPROVAL_CATEGORY);
    }

    return {
      // Redaction at the boundary: a root carrying any secret material (e.g. an embedded
      // credential URI) is scrubbed before it leaves the process (Req 3.7).
      workspaceRoot: redactString(root),
      allowlistedCommands,
      destructiveProtection: config.destructiveProtectionEnabled === false ? "disabled" : "enabled",
      approvalRequiredCategories,
      available: true,
    };
  } catch {
    // Any failure assembling the policy is treated as "policy unavailable" (Req 3.8).
    return { ...UNAVAILABLE_WORKSPACE_SAFETY };
  }
}

/**
 * Resolve the default {@link WorkspaceSafetyConfig} from the ambient environment, mirroring the
 * sandbox defaults used by the chat runner (`workspaceRoot` from `RECTOR_WORKSPACE_ROOT`, falling
 * back to `process.cwd()`). Destructive protection is always enforced by the workspace sandbox, so
 * it is reported as enabled. This reads configuration only and performs no I/O beyond `process.cwd()`.
 */
function resolveWorkspaceSafetyConfig(env: Record<string, string | undefined>): WorkspaceSafetyConfig {
  const configuredRoot = env.RECTOR_WORKSPACE_ROOT?.trim();
  return {
    workspaceRoot: configuredRoot && configuredRoot.length > 0 ? configuredRoot : process.cwd(),
    allowlistedCommands: [],
    riskyCommands: [],
    destructiveProtectionEnabled: true,
  };
}

/**
 * Send `payload` as JSON only after a successful outbound redaction pass (Requirement 11.5).
 *
 * Every new productization boundary (setup-status, workspace-safety, and approval-decision
 * responses, plus their error paths) routes its outbound body through {@link redactOutbound}. On
 * success the redacted value is serialized with the caller's `status`, preserving the response
 * shape. If redaction throws, the raw (unredacted) content is suppressed — never written — and a
 * fixed `{ error: REDACTION_FAILED_ERROR }` is returned with HTTP 500 instead, so no unredacted
 * content can escape even when the Redaction_Layer itself fails.
 */
function sendRedacted(res: express.Response, status: number, payload: unknown): void {
  const outcome = redactOutbound(payload);
  if (outcome.ok) {
    res.status(status).json(outcome.value);
    return;
  }
  res.status(500).json({ error: REDACTION_FAILED_ERROR });
}

const malformedJsonBodyHandler: express.ErrorRequestHandler = (error, _req, res, next) => {
  if (error instanceof SyntaxError && typeof error === "object" && error !== null && "body" in error) {
    sendRedacted(res, 400, { error: "Malformed JSON request body." });
    return;
  }
  next(error);
};

/**
 * Like {@link sendRedacted}, but re-applies server-computed boolean presence
 * flags that the sensitive-key redaction rule would otherwise clobber.
 *
 * The Redaction_Layer replaces any value under a key whose name contains a
 * secret keyword (e.g. `secretPresent`, since it contains "secret") with the
 * `[REDACTED]` placeholder — by design, so a genuine secret string can never
 * escape. A `secretPresent` PRESENCE boolean, however, is computed server-side
 * from {@link SecretStore.hasSecret} and carries no secret material, yet the
 * design (C7, Req 11.2) requires responses to expose it as a real boolean.
 *
 * This helper runs the full payload through {@link redactOutbound} (so every
 * user-controlled string/structure is still redacted exactly as before), then
 * invokes `reattach` on the redacted value to overwrite the clobbered
 * placeholder(s) with the known-safe boolean(s). Redaction-failure suppression
 * is unchanged: if redaction throws, a 500 with {@link REDACTION_FAILED_ERROR}
 * is sent and `reattach` never runs, so no unredacted content can escape.
 */
function sendRedactedPreservingPresence<T>(
  res: express.Response,
  status: number,
  payload: T,
  reattach: (redacted: any) => unknown,
): void {
  const outcome = redactOutbound(payload);
  if (outcome.ok) {
    res.status(status).json(reattach(outcome.value));
    return;
  }
  res.status(500).json({ error: REDACTION_FAILED_ERROR });
}

// --- Provider_Config_API request schemas (design section C7) ---

/**
 * Upsert body for `POST /api/providers`. Mirrors the non-secret {@link ProviderConfigRecord} the
 * caller may set, plus an OPTIONAL write-once `apiKey`. Server-managed fields (`secretRef`,
 * `createdAt`, `updatedAt`) are intentionally NOT accepted from the client — the route derives
 * `secretRef` from `id` and stamps the timestamps. `.strict()` rejects unknown fields so a
 * mis-named secret can never slip into the non-secret config record.
 */
export const UpsertProviderRequestSchema = z
  .object({
    id: z.string().min(1),
    kind: ProviderKindSchema,
    label: z.string().min(1),
    baseUrl: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    models: ProviderModelMapSchema.optional(),
    /**
     * Manual_Model_List (Req 3.3): user-entered model identifiers persisted as
     * non-secret config and used as the `openai-compatible` discovery fallback and as
     * selectable Active_Route_Map identifiers. Flows through to the persisted
     * {@link ProviderConfigRecord} unchanged; it never carries secret material.
     */
    manualModels: z.array(z.string().min(1)).optional(),
    azure: AzureProviderConfigSchema.optional(),
    cloudflare: CloudflareProviderConfigSchema.optional(),
    headers: z.record(z.string()).optional(),
    /** Optional secret; persisted to the Secret_Store then stripped, never stored in config. */
    apiKey: z.string().min(1).optional(),
  })
  .strict()
  // Provider_Label validation for the BYOK generic provider (Req 3.1, 3.2): an
  // `openai-compatible` record MUST carry a non-blank label. The base `label` schema
  // (`z.string().min(1)`) already rejects a missing or empty label for every kind; this
  // refinement additionally rejects a whitespace-only label for `openai-compatible` so a
  // blank display name cannot identify a generic provider. On failure the body parse throws
  // and the route returns a 400 before any record is persisted.
  .superRefine((value, ctx) => {
    if (value.kind === "openai-compatible" && value.label.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["label"],
        message: "label is required for an openai-compatible provider and must not be blank",
      });
    }
  });
export type UpsertProviderRequest = z.infer<typeof UpsertProviderRequestSchema>;

/** Body for `POST /api/providers/:id/secret`: the secret only (write/replace). */
export const SetProviderSecretRequestSchema = z
  .object({ apiKey: z.string().min(1) })
  .strict();
export type SetProviderSecretRequest = z.infer<typeof SetProviderSecretRequestSchema>;

/** Body for `POST /api/providers/active`: designate (or clear, with `null`) a role's provider. */
export const SetActiveRouteRequestSchema = z
  .object({
    role: ProviderModelRoleSchema,
    providerId: z.string().min(1).nullable(),
  })
  .strict();
export type SetActiveRouteRequest = z.infer<typeof SetActiveRouteRequestSchema>;

/** Body for `POST /api/orchestration-models/assignments/:role/test`. Empty means test saved/effective assignment. */
export const TestOrchestrationAssignmentRequestSchema = OrchestrationAssignmentUpsertSchema.partial().strict();
export type TestOrchestrationAssignmentRequest = z.infer<typeof TestOrchestrationAssignmentRequestSchema>;

// --- Memory_Provider_API request schemas (Chunk 36, mirrors Provider_Config_API) ---

/**
 * Upsert body for `POST /api/memory-providers`. Mirrors the non-secret
 * {@link MemoryProviderRecord} the caller may set, plus an OPTIONAL write-once
 * `apiKey`. Server-managed fields (`secretRef`, `createdAt`, `updatedAt`) are
 * derived/stamped by the route. `secretRef` is `memory:${id}`.
 */
export const UpsertMemoryProviderRequestSchema = z
  .object({
    id: z.string().min(1),
    kind: MemoryProviderKindSchema,
    label: z.string().min(1),
    config: MemoryProviderConfigSchema,
    /** Optional secret; persisted to the Secret_Store then stripped, never stored in config. */
    apiKey: z.string().min(1).optional(),
  })
  .strict();
export type UpsertMemoryProviderRequest = z.infer<typeof UpsertMemoryProviderRequestSchema>;

/** Body for `POST /api/memory-providers/:id/secret`: the secret only (write/replace). */
export const SetMemoryProviderSecretRequestSchema = z
  .object({ apiKey: z.string().min(1) })
  .strict();
export type SetMemoryProviderSecretRequest = z.infer<typeof SetMemoryProviderSecretRequestSchema>;

/** Body for `POST /api/memory-providers/active`: designate (or clear, with `null`) the active provider. */
export const SetActiveMemoryProviderRequestSchema = z
  .object({
    providerId: z.string().min(1).nullable(),
  })
  .strict();
export type SetActiveMemoryProviderRequest = z.infer<typeof SetActiveMemoryProviderRequestSchema>;

/** Response for `POST /api/memory-providers/:id/test-connection`. */
export const TestMemoryProviderConnectionResponseSchema = z.object({
  ok: z.boolean(),
  providerId: z.string().min(1),
  kind: z.string().optional(),
  code: z.string().optional(),
  error: z.string().optional(),
  /** Always false for memory providers (validateConfig only; no network ping). */
  networkAttempted: z.boolean(),
});
export type TestMemoryProviderConnectionResponse = z.infer<typeof TestMemoryProviderConnectionResponseSchema>;

export const UpsertMemoryAssignmentRequestSchema = z
  .object({
    providerRecordId: z.string().min(1),
    enabled: z.boolean().optional(),
    workspaceId: z.string().min(1).optional(),
    readPriority: z.number().int().optional(),
    writePriority: z.number().int().optional(),
    fallbackProviderRecordId: z.string().min(1).optional(),
    retentionPolicy: z.enum(["ephemeral", "session", "durable", "longTerm"]).optional(),
    maxEntries: z.number().int().positive().optional(),
    maxUsdPerDay: z.number().nonnegative().optional(),
  })
  .strict();
export type UpsertMemoryAssignmentRequest = z.infer<typeof UpsertMemoryAssignmentRequestSchema>;

export const MemoryAssignmentResetRequestSchema = z
  .object({
    workspaceId: z.string().min(1).optional(),
  })
  .strict()
  .optional();
export type MemoryAssignmentResetRequest = z.infer<typeof MemoryAssignmentResetRequestSchema>;

export const MemoryAssignmentMigrationPlanRequestSchema = z
  .object({
    targetProviderRecordId: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
  })
  .strict()
  .optional();
export type MemoryAssignmentMigrationPlanRequest = z.infer<typeof MemoryAssignmentMigrationPlanRequestSchema>;

/**
 * Validates a built memory provider's configuration. Local kinds always succeed
 * without reading secrets or performing network I/O. External kinds run
 * `validateConfig()` on the supplied instance.
 */
/** Maximum entries returned by `GET /api/memory/entries` (Chunk 36 stretch). */
export const MEMORY_ENTRIES_API_LIMIT = 50;

/** Allowed `layer` query values for the memory browser list endpoint. */
export const MemoryEntriesLayerQuerySchema = z.enum(["episodic", "core"]);
export type MemoryEntriesLayerQuery = z.infer<typeof MemoryEntriesLayerQuerySchema>;

/** Response body for `GET /api/memory/entries`. */
export const MemoryEntriesListResponseSchema = z.object({
  entries: z.array(
    z.object({
      id: z.string().min(1),
      layer: MemoryLayerSchema,
      content: z.string(),
      timestamp: z.string().datetime(),
      lastMentioned: z.string().datetime(),
      accessCount: z.number().int().nonnegative(),
      tags: z.array(z.string()),
      source: z.string().optional(),
      metadata: z.record(z.unknown()),
    }),
  ),
  count: z.number().int().nonnegative(),
  provider: z.object({
    id: z.string().min(1),
    kind: z.string().min(1),
    label: z.string().optional(),
  }),
});
export type MemoryEntriesListResponse = z.infer<typeof MemoryEntriesListResponseSchema>;

/** Redact a single memory entry before API egress. */
export function redactMemoryEntryForEgress(entry: MemoryEntry): MemoryEntry {
  return {
    ...entry,
    content: redactMemoryContent(entry.content),
    metadata: redactSecrets(entry.metadata) as Record<string, unknown>,
  };
}

/**
 * List recent memory entries from the active provider for the read-only memory browser.
 * Results are sorted newest-first and capped at {@link MEMORY_ENTRIES_API_LIMIT}.
 */
export async function listMemoryEntriesForApi(
  provider: MemoryProvider,
  options: { layer?: MemoryLayer; limit?: number } = {},
): Promise<MemoryEntriesListResponse> {
  const limit = Math.min(Math.max(1, options.limit ?? MEMORY_ENTRIES_API_LIMIT), MEMORY_ENTRIES_API_LIMIT);
  const all = await provider.listMemoryEntries(options.layer);
  const sorted = [...all].sort(
    (a, b) => (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0),
  );
  const entries = sorted.slice(0, limit).map(redactMemoryEntryForEgress);
  return MemoryEntriesListResponseSchema.parse({
    entries,
    count: entries.length,
    provider: {
      id: provider.id,
      kind: provider.kind,
      label: provider.metadata.label,
    },
  });
}

export function runMemoryProviderConnectionTest(input: {
  providerId: string;
  provider: MemoryProvider;
  kind: string;
}): TestMemoryProviderConnectionResponse {
  const { providerId, provider, kind } = input;

  if (kind === "local-inmemory" || kind === "local-sqlite-mem") {
    return TestMemoryProviderConnectionResponseSchema.parse({
      ok: true,
      providerId,
      kind,
      networkAttempted: false,
    });
  }

  try {
    provider.validateConfig?.();
    return TestMemoryProviderConnectionResponseSchema.parse({
      ok: true,
      providerId,
      kind,
      networkAttempted: false,
    });
  } catch (error) {
    return TestMemoryProviderConnectionResponseSchema.parse({
      ok: false,
      providerId,
      kind,
      code: "CONFIG_INVALID",
      error: redactString(error instanceof Error ? error.message : String(error)),
      networkAttempted: false,
    });
  }
}

/**
 * The Settings_API model-discovery deadline (cloud-capable-transition Req 4.6). The discovery
 * handler races the {@link ModelDiscoveryService} call against this outer timer and returns a
 * `timeout` Discovery_Error if the service has not produced a result by the deadline. The service
 * already enforces its own per-adapter 30 000 ms abort; this is the independent Settings_API-layer
 * deadline the requirement mandates, so an outer wait (e.g. a stalled cache or resolution step) is
 * still bounded.
 */
export const SETTINGS_DISCOVERY_TIMEOUT_MS = 30_000;

/**
 * Core Settings_API model-discovery handler (cloud-capable-transition Req 4). Decoupled from
 * Express so it is unit/property testable: it takes the resolved Orchestrator_Mode, the
 * {@link ModelDiscoveryService}, and the requested provider id, and resolves to a
 * {@link DiscoveryResult} the route serializes through {@link sendRedacted} (Req 4.4).
 *
 * Behavior:
 * - **Local mode (Req 4.3, 4.7):** returns a Discovery_Error indicating discovery is unavailable in
 *   local mode WITHOUT invoking the service or making any network call. The mode gate is checked
 *   first, before the service is ever touched, so the local-isolation invariant is directly
 *   observable (the injected service's `discover` is never called).
 * - **External mode (Req 4.1, 4.5):** invokes the service and relays its result — the discovered
 *   `Model_Candidate`s on success, or the service's classified, redacted Discovery_Error (including
 *   `not_found` for an unknown provider, Req 4.2) — without ever throwing. An unexpected throw from
 *   the service is itself caught and classified as a redacted `unknown` error.
 * - **30 000 ms deadline (Req 4.6):** the service call is raced against an outer timer; on expiry
 *   the handler stops waiting and returns a Discovery_Error with category `timeout`.
 *
 * Timers and the clock are injectable so property tests stay hermetic.
 */
export async function runSettingsDiscovery(input: {
  mode: OrchestratorMode;
  service: ModelDiscoveryService;
  providerId: string;
  refresh?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
  setTimeoutImpl?: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutImpl?: (handle: ReturnType<typeof setTimeout>) => void;
}): Promise<DiscoveryResult> {
  const { mode, service, providerId } = input;
  const now = input.now ?? (() => new Date());
  const timeoutMs = input.timeoutMs ?? SETTINGS_DISCOVERY_TIMEOUT_MS;
  const setTimeoutImpl = input.setTimeoutImpl ?? ((handler, ms) => setTimeout(handler, ms));
  const clearTimeoutImpl = input.clearTimeoutImpl ?? ((handle) => clearTimeout(handle));

  // Local mode (Req 4.3, 4.7): short-circuit BEFORE the service is consulted so no discovery
  // network call is made and the service is provably never invoked.
  if (mode !== "external") {
    return {
      ok: false,
      providerId,
      error: {
        category: "unknown",
        message: redactString("Model discovery is unavailable in local mode."),
      },
      lastRefreshedAt: now().toISOString(),
    };
  }

  // External mode: race the service call against the Settings_API 30 000 ms deadline (Req 4.6).
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<DiscoveryResult>((resolve) => {
    timer = setTimeoutImpl(() => {
      resolve({
        ok: false,
        providerId,
        error: {
          category: "timeout",
          message: redactString(
            `Model discovery for "${providerId}" did not complete within ${timeoutMs} ms.`,
          ),
        },
        lastRefreshedAt: now().toISOString(),
      });
    }, timeoutMs);
  });

  try {
    // Invoke the service (Req 4.1) and relay its classified result (Req 4.2, 4.5). The service is
    // designed never to throw, but a defensive `.catch` guarantees the handler never throws either,
    // classifying any unexpected throw as a redacted `unknown` error.
    const discovery = Promise.resolve(
      service.discover(providerId, { refresh: input.refresh, fetchImpl: input.fetchImpl }),
    ).catch(
      (error): DiscoveryResult => ({
        ok: false,
        providerId,
        error: {
          category: "unknown",
          message: redactString(error instanceof Error ? error.message : String(error)),
        },
        lastRefreshedAt: now().toISOString(),
      }),
    );

    return await Promise.race([discovery, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeoutImpl(timer);
    }
  }
}

/**
 * Map a Settings_API {@link DiscoveryResult} to an HTTP status. A success is 200; an unknown
 * provider id is 404 (Req 4.2); a Settings_API deadline expiry is 504 (Req 4.6); other classified
 * upstream failures map to a representative status. The full, already-redacted DiscoveryResult is
 * always the response body (Req 4.4, 4.5), so the category is preserved regardless of status. A
 * local-mode "discovery unavailable" result is mapped to 503 by the route (it carries the generic
 * `unknown` category) so it is distinguished from a genuine upstream `unknown` failure.
 */
function settingsDiscoveryStatus(result: DiscoveryResult): number {
  if (result.ok) return 200;
  switch (result.error.category) {
    case "not_found":
      return 404;
    case "timeout":
      return 504;
    case "auth_invalid":
      return 401;
    case "endpoint_invalid":
    case "requires_management_plane":
      return 400;
    case "rate_limited":
      return 429;
    default:
      return 502;
  }
}

/** True when the store is a SqlRectorStore (sqlite or tidb), exposing SQL-backed memory methods. */
function isSqlBackedStore(store: RectorStore): boolean {
  return store instanceof SqlRectorStore;
}

export function createApp(manager: TaskManager, securityOptions: ApiSecurityOptions = {}): express.Application {
  const app = express();

  // Select the store from boot-time migration or the deployment persistence config (ORN-39).
  // When a pre-constructed store is injected (Startup_Migration on sqlite/tidb), createApp skips
  // createRectorStore. Otherwise, when no persistence config is supplied (or its driver is
  // `memory`), createRectorStore returns the default InMemoryRectorStore.
  //
  // Streaming (ORN-40): create one in-process RunEventBroker per app and wrap the selected store
  // with `withEventBroadcast` so every persisted/redacted appended or committed event is published
  // to the broker for live SSE subscribers. The wrapper preserves the RectorStore interface, so the
  // synchronous POST chat flow and the `GET /api/runs/:id/events` polling endpoint use it
  // transparently with no behavior change.
  const runEventBroker = createRunEventBroker();
  const baseStore = securityOptions.store ?? createRectorStore(securityOptions.persistence);
  const rectorStore = withEventBroadcast(baseStore, runEventBroker);
  const setupSecretStore = securityOptions.secretStore ?? createEmptySecretStore();
  const providerConfigStore = securityOptions.providerConfigStore ?? createInMemoryProviderConfigStore();
  const memoryConfigStore = securityOptions.memoryConfigStore ?? createInMemoryMemoryConfigStore();
  const orchestrationAssignmentStore =
    securityOptions.orchestrationAssignmentStore ?? createInMemoryOrchestrationAssignmentStore();
  const memoryAssignmentStore =
    securityOptions.memoryAssignmentStore ?? securityOptions.memoryRoleAssignmentStore ?? createInMemoryMemoryAssignmentStore();

  // Chunk 34 (pluggable memory providers): resolve the active MemoryProvider for neuro/agent
  // memory (notes, episodic context for contextBuilder/preprocessor/planner, prune, etc.).
  // - When memoryConfigStore is supplied (real app bootstrap), resolveActiveMemoryProvider
  //   honors orchestration mode, falls back safely to pure local-inmemory, and only reads
  //   secrets transiently for external kinds.
  // - When omitted (the common case for unit/integration tests), we synthesize a pure
  //   local-inmemory provider so *all* pre-34 memory behavior (memoryAdvanced.test.ts,
  //   chat context enrichment, /api/notes, prune scoring, time phrases, etc.) remains
  //   byte-identical for the local baseline.
  // Closed over by the route handlers and context code below.
  let activeMemoryProvider: MemoryProvider | undefined;
  const resolvePromise = (async () => {
    try {
      activeMemoryProvider = await resolveActiveMemoryProvider(memoryConfigStore, setupSecretStore, {
        mode: securityOptions.orchestration?.mode,
        delegateStoreForLocalSqliteMem: isSqlBackedStore(baseStore) ? rectorStore : undefined,
      });
    } catch {
      activeMemoryProvider = createPureLocalMemoryProvider();
    }
  })();

  // Single-resolve cache: resolveActiveMemoryProvider runs once per app lifetime;
  // subsequent calls await the same promise and return the cached instance.
  const getMemoryProvider = async (): Promise<MemoryProvider> => {
    await resolvePromise;
    return activeMemoryProvider ?? createPureLocalMemoryProvider();
  };

  const orchestration = securityOptions.orchestration;

  const moduleConfigStore =
    securityOptions.moduleConfigStore ??
    createLocalModuleConfigStore({ filePath: ".rector/modules.json" });
  const userTemplateStore = securityOptions.userTemplateStore ?? createInMemoryUserTemplateStore();
  const moduleRegistry: ModuleRegistry = createBuiltinModuleRegistry();
  let moduleBootReady = false;
  let moduleBootPromise: Promise<void> | undefined;
  const ensureModuleBoot = (): Promise<void> => {
    if (moduleBootReady) return Promise.resolve();
    if (!moduleBootPromise) {
      moduleBootPromise = (async () => {
        await applyModuleConfigToRegistry(moduleRegistry, moduleConfigStore);
        await moduleRegistry.invokeOnBoot({
          mode: orchestration?.mode ?? "local",
          store: rectorStore,
          router: orchestration?.router,
          getMemoryProvider: getMemoryProvider,
        });
        moduleBootReady = true;
      })().catch((error) => {
        moduleBootPromise = undefined;
        console.error(
          `Module boot failed: ${redactString(error instanceof Error ? error.message : String(error))}`,
        );
        throw error;
      });
    }
    return moduleBootPromise;
  };
  app.locals.moduleRegistry = moduleRegistry;
  app.locals.moduleConfigStore = moduleConfigStore;
  app.locals.ensureModuleBoot = ensureModuleBoot;

  app.use(async (_req, res, next) => {
    try {
      await ensureModuleBoot();
      next();
    } catch (error) {
      res.status(503).json({
        error: redactString(error instanceof Error ? error.message : String(error)),
      });
    }
  });

  const authConfig = securityOptions.auth ?? parseAuthConfig(process.env);

  app.locals.neuroAliveState = getNeuroAliveState;
  app.use(securityHeadersMiddleware);
  app.use(corsMiddleware(securityOptions));
  app.use(apiRateLimitMiddleware(securityOptions, authConfig));
  app.use(express.json());
  app.use(malformedJsonBodyHandler);
  const publicDir = resolvePublicDir();
  app.use(express.static(publicDir));
  const defaultUserStores: UserStores = {
    secretStore: setupSecretStore,
    providerConfigStore,
    memoryConfigStore,
    orchestrationAssignmentStore,
    memoryAssignmentStore,
  };
  const resolveUserStores = createUserStoresResolver({
    authEnabled: authConfig.enabled,
    encryptionKey: securityOptions.secretEncryptionKey ?? Buffer.alloc(32),
    defaultStores: defaultUserStores,
  });
  const storesFor = (req: express.Request): UserStores => req.rectorStores ?? defaultUserStores;
  const assignmentScopeFor = (
    req: express.Request,
    workspaceId?: string,
  ): OrchestrationAssignmentScope => ({
    ...(authConfig.enabled && req.rectorAuth ? { userId: req.rectorAuth.userId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
  });
  const workspaceIdFromQuery = (req: express.Request): string | undefined =>
    typeof req.query.workspaceId === "string" && req.query.workspaceId.trim().length > 0
      ? req.query.workspaceId.trim()
      : undefined;

  const buildOrchestrationModelsPayload = async (
    req: express.Request,
    workspaceId?: string,
  ): Promise<{
    roles: typeof ORCHESTRATION_ROLE_DESCRIPTORS;
    assignments: OrchestrationModelAssignment[];
    effective: EffectiveModelRoute[];
    providers: ReturnType<typeof providerOptionsFromConfigState>;
  }> => {
    const userStores = storesFor(req);
    const scope = assignmentScopeFor(req, workspaceId);
    const [assignmentState, providerState] = await Promise.all([
      userStores.orchestrationAssignmentStore.getState(),
      userStores.providerConfigStore.getState(),
    ]);
    const assignments = assignmentState.assignments.filter(
      (assignment) => assignment.userId === scope.userId && assignment.workspaceId === scope.workspaceId,
    );
    return {
      roles: ORCHESTRATION_ROLE_DESCRIPTORS,
      assignments,
      effective: ORCHESTRATION_ROLE_DESCRIPTORS.map((role) =>
        resolveEffectiveAssignment({
          role: role.id,
          assignments: assignmentState.assignments,
          providerState,
          scope,
        }),
      ),
      providers: providerOptionsFromConfigState(providerState),
    };
  };

  const authMode = securityOptions.authMode ?? parseAuthMode(process.env);
  const workspaceDirectory = securityOptions.workspaceDirectory ?? createInMemoryWorkspaceDirectory();
  const auditLog = securityOptions.auditLog ?? createInMemoryAuditLogService();
  const quotaService = securityOptions.quotaService ?? createInMemoryQuotaService();
  const deploymentEnv = securityOptions.deploymentEnv ?? process.env;
  app.locals.authMode = authMode;
  app.locals.auditLog = auditLog;
  app.locals.quotaService = quotaService;
  app.locals.workspaceDirectory = workspaceDirectory;
  const loginAttempts = new Map<string, { count: number; resetAt: number }>();

  const requestActorId = (req: express.Request): string => req.rectorAuth?.userId ?? "default";

  const auditRequest = async (
    req: express.Request,
    input: {
      workspaceId?: string;
      actorUserId?: string;
      action: string;
      targetType: string;
      targetId?: string;
      outcome: "success" | "denied" | "failed";
      reason?: string;
    },
  ): Promise<void> => {
    try {
      await auditLog.record({
        ...input,
        actorUserId: input.actorUserId ?? req.rectorAuth?.userId,
        ipHash: hashAuditValue(req.ip),
        userAgentHash: hashAuditValue(req.header("user-agent")),
      });
    } catch {
      // Audit logging must never fail the primary request path.
    }
  };

  const resolveRequestWorkspace = async (
    req: express.Request,
    requestedWorkspaceId?: string,
  ): Promise<{ ok: true; workspaceId: string; role: WorkspaceRole } | { ok: false; status: 401 | 403; reason: string; workspaceId?: string }> => {
    if (!authConfig.enabled) {
      const workspaceId = requestedWorkspaceId ?? "local";
      req.rectorWorkspace = { workspaceId, role: "owner" };
      return { ok: true, workspaceId, role: "owner" };
    }

    const auth = req.rectorAuth;
    if (!auth) return { ok: false, status: 401, reason: "Authentication required", workspaceId: requestedWorkspaceId };
    const workspace = requestedWorkspaceId
      ? await workspaceDirectory.getWorkspace(requestedWorkspaceId)
      : await workspaceDirectory.getDefaultWorkspaceForUser(auth.userId);
    if (!workspace) return { ok: false, status: 403, reason: "Workspace not found", workspaceId: requestedWorkspaceId };
    const membership = await workspaceDirectory.getMembership(auth.userId, workspace.id);
    if (!membership) {
      return { ok: false, status: 403, reason: "Workspace access denied", workspaceId: workspace.id };
    }
    req.rectorWorkspace = { workspaceId: workspace.id, role: membership.role };
    return { ok: true, workspaceId: workspace.id, role: membership.role };
  };

  const authorize = async (
    req: express.Request,
    res: express.Response,
    permission: Permission,
    options: { workspaceId?: string; targetType?: string; targetId?: string } = {},
  ): Promise<{ ok: true; workspaceId: string; role: WorkspaceRole } | false> => {
    const workspace = await resolveRequestWorkspace(req, options.workspaceId);
    if (!workspace.ok) {
      await auditRequest(req, {
        workspaceId: workspace.workspaceId,
        action: `permission.${permission}`,
        targetType: options.targetType ?? "permission",
        targetId: options.targetId,
        outcome: "denied",
        reason: workspace.reason,
      });
      res.status(workspace.status).json({ error: workspace.reason });
      return false;
    }

    const decision = evaluatePermission(
      { authEnabled: authConfig.enabled, userId: requestActorId(req), workspaceId: workspace.workspaceId, role: workspace.role },
      permission,
    );
    if (!decision.ok) {
      await auditRequest(req, {
        workspaceId: workspace.workspaceId,
        action: `permission.${permission}`,
        targetType: options.targetType ?? "permission",
        targetId: options.targetId,
        outcome: "denied",
        reason: decision.reason,
      });
      sendPermissionDenied(res, decision as PermissionDenial);
      return false;
    }
    return { ok: true, workspaceId: workspace.workspaceId, role: workspace.role };
  };

  const workspaceIdForConversation = async (conversationId: string): Promise<string | undefined> => {
    const conversation = await rectorStore.getConversation(conversationId);
    return conversation?.workspaceId;
  };

  const workspaceIdForRun = async (runId: string): Promise<string | undefined> => {
    const run = await rectorStore.getRun(runId);
    if (!run) return undefined;
    return workspaceIdForConversation(run.conversationId);
  };

  const enforceRunQuota = async (
    req: express.Request,
    res: express.Response,
    workspaceId: string,
  ): Promise<boolean> => {
    const quota = await quotaService.checkRunCreation(workspaceId);
    if (quota.allowed) return true;
    await auditRequest(req, {
      workspaceId,
      action: "quota.denied",
      targetType: "quota",
      outcome: "denied",
      reason: quota.reason,
    });
    res.status(429).json({ error: "Quota exceeded", reason: quota.reason, quota: { policy: quota.policy, usage: quota.usage } });
    return false;
  };

  const LoginRequestSchema = z.object({
    username: z.string().min(1),
    password: z.string().min(1),
  });

  app.post("/api/auth/login", async (req, res) => {
    if (!authConfig.enabled) {
      const outcome = redactOutbound({ authenticated: true, username: "default" });
      return res.status(outcome.ok ? 200 : 500).json(outcome.ok ? outcome.value : { error: REDACTION_FAILED_ERROR });
    }

    let body: z.infer<typeof LoginRequestSchema>;
    try {
      body = LoginRequestSchema.parse(req.body ?? {});
    } catch {
      const outcome = redactOutbound({ error: authErrorMessage("Invalid username or password") });
      return res.status(400).json(outcome.ok ? outcome.value : { error: REDACTION_FAILED_ERROR });
    }

    const username = body.username.trim().toLowerCase();
    const attemptKey = `${username}:${req.ip}`;
    const nowMs = Date.now();
    const currentAttempt = loginAttempts.get(attemptKey);
    if (currentAttempt && currentAttempt.resetAt > nowMs && currentAttempt.count >= 5) {
      await auditRequest(req, {
        actorUserId: username,
        action: "auth.login",
        targetType: "user",
        targetId: username,
        outcome: "denied",
        reason: "Login attempt rate limit exceeded.",
      });
      const outcome = redactOutbound({ error: authErrorMessage("Too many login attempts") });
      return res.status(429).json(outcome.ok ? outcome.value : { error: REDACTION_FAILED_ERROR });
    }

    const storedHash = authConfig.users.get(username);
    if (!storedHash || !verifyPassword(body.password, storedHash)) {
      const nextAttempt = currentAttempt && currentAttempt.resetAt > nowMs
        ? { count: currentAttempt.count + 1, resetAt: currentAttempt.resetAt }
        : { count: 1, resetAt: nowMs + 15 * 60 * 1000 };
      loginAttempts.set(attemptKey, nextAttempt);
      await auditRequest(req, {
        actorUserId: username,
        action: "auth.login",
        targetType: "user",
        targetId: username,
        outcome: "failed",
        reason: "Invalid username or password.",
      });
      const outcome = redactOutbound({ error: authErrorMessage("Invalid username or password") });
      return res.status(401).json(outcome.ok ? outcome.value : { error: REDACTION_FAILED_ERROR });
    }

    loginAttempts.delete(attemptKey);
    const token = createSessionToken(username, username, authConfig.sessionSecret);
    res.setHeader("Set-Cookie", buildSessionCookie(token, deploymentEnv));
    await auditRequest(req, {
      actorUserId: username,
      action: "auth.login",
      targetType: "user",
      targetId: username,
      outcome: "success",
    });
    const outcome = redactOutbound({ authenticated: true, username });
    return res.status(outcome.ok ? 200 : 500).json(outcome.ok ? outcome.value : { error: REDACTION_FAILED_ERROR });
  });

  app.post("/api/auth/logout", async (req, res) => {
    res.setHeader("Set-Cookie", buildClearSessionCookie(deploymentEnv));
    await auditRequest(req, {
      action: "auth.logout",
      targetType: "session",
      outcome: "success",
    });
    const outcome = redactOutbound({ authenticated: false });
    return res.status(outcome.ok ? 200 : 500).json(outcome.ok ? outcome.value : { error: REDACTION_FAILED_ERROR });
  });

  app.get("/api/auth/session", (req, res) => {
    if (!authConfig.enabled) {
      const outcome = redactOutbound({ authenticated: true, username: "default" });
      return res.status(outcome.ok ? 200 : 500).json(outcome.ok ? outcome.value : { error: REDACTION_FAILED_ERROR });
    }

    const cookies = (req.header("cookie") ?? "")
      .split(";")
      .map((part) => part.trim())
      .reduce<Record<string, string>>((acc, part) => {
        const eq = part.indexOf("=");
        if (eq > 0) acc[part.slice(0, eq)] = part.slice(eq + 1);
        return acc;
      }, {});
    const session = verifySessionToken(cookies[SESSION_COOKIE_NAME], authConfig.sessionSecret);
    const outcome = redactOutbound(
      session ? { authenticated: true, username: session.username } : { authenticated: false },
    );
    return res.status(outcome.ok ? 200 : 500).json(outcome.ok ? outcome.value : { error: REDACTION_FAILED_ERROR });
  });

  app.use(createAuthMiddleware(authConfig, resolveUserStores));
  app.use(csrfProtectionMiddleware(authConfig, securityOptions));

  app.get("/api/rbac/permissions", async (req, res) => {
    const workspace = await authorize(req, res, "workspace.read", {
      workspaceId: typeof req.query.workspaceId === "string" ? req.query.workspaceId : undefined,
      targetType: "workspace",
    });
    if (!workspace) return;
    sendRedacted(res, 200, {
      workspaceId: workspace.workspaceId,
      role: workspace.role,
      permissions: permissionsForRole(workspace.role),
    });
  });

  app.get("/api/workspaces", async (req, res) => {
    try {
      const userId = requestActorId(req);
      const entries = authConfig.enabled
        ? await workspaceDirectory.listWorkspacesForUser(userId)
        : [{ workspace: await workspaceDirectory.getDefaultWorkspaceForUser("default"), membership: WorkspaceMembershipSchema.parse({ id: "local-owner", workspaceId: "local", userId: "default", role: "owner", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }) }];
      sendRedacted(res, 200, {
        workspaces: entries.map((entry) => ({ ...entry.workspace, role: entry.membership.role })),
      });
    } catch (error) {
      sendRedacted(res, 500, { error: redactString(errorMessageOf(error)) });
    }
  });

  app.post("/api/workspaces", async (req, res) => {
    if (authConfig.enabled && !req.rectorAuth) return res.status(401).json({ error: "Authentication required" });
    try {
      const body = z.object({ name: z.string().min(1) }).parse(req.body ?? {});
      const ownerUserId = requestActorId(req);
      const workspace = await workspaceDirectory.createWorkspace({ name: body.name, ownerUserId });
      await auditRequest(req, { workspaceId: workspace.id, action: "workspace.create", targetType: "workspace", targetId: workspace.id, outcome: "success" });
      sendRedacted(res, 201, { workspace });
    } catch (error) {
      sendRedacted(res, 400, { error: redactString(errorMessageOf(error)) });
    }
  });

  app.get("/api/workspaces/:id/members", async (req, res) => {
    const workspace = await authorize(req, res, "members.manage", { workspaceId: req.params.id, targetType: "workspace", targetId: req.params.id });
    if (!workspace) return;
    try {
      sendRedacted(res, 200, { members: await workspaceDirectory.listMembers(workspace.workspaceId) });
    } catch (error) {
      sendRedacted(res, 500, { error: redactString(errorMessageOf(error)) });
    }
  });

  app.post("/api/workspaces/:id/members", async (req, res) => {
    const workspace = await authorize(req, res, "members.manage", { workspaceId: req.params.id, targetType: "workspace", targetId: req.params.id });
    if (!workspace) return;
    try {
      const body = z.object({ userId: z.string().min(1), role: z.enum(["owner", "admin", "operator", "developer", "viewer"]) }).parse(req.body ?? {});
      const member = await workspaceDirectory.addMembership({ workspaceId: workspace.workspaceId, userId: body.userId, role: body.role });
      await auditRequest(req, { workspaceId: workspace.workspaceId, action: "members.add", targetType: "membership", targetId: member.id, outcome: "success" });
      sendRedacted(res, 201, { member });
    } catch (error) {
      sendRedacted(res, 400, { error: redactString(errorMessageOf(error)) });
    }
  });

  app.patch("/api/workspaces/:id/members/:memberId", async (req, res) => {
    const workspace = await authorize(req, res, "members.manage", { workspaceId: req.params.id, targetType: "membership", targetId: req.params.memberId });
    if (!workspace) return;
    try {
      const body = z.object({ role: z.enum(["owner", "admin", "operator", "developer", "viewer"]) }).parse(req.body ?? {});
      const members = await workspaceDirectory.listMembers(workspace.workspaceId);
      if (!members.some((member) => member.id === req.params.memberId)) {
        return sendRedacted(res, 404, { error: "Member not found" });
      }
      const member = await workspaceDirectory.updateMembershipRole(req.params.memberId, body.role);
      if (!member) return sendRedacted(res, 404, { error: "Member not found" });
      await auditRequest(req, { workspaceId: workspace.workspaceId, action: "members.update", targetType: "membership", targetId: member.id, outcome: "success" });
      sendRedacted(res, 200, { member });
    } catch (error) {
      sendRedacted(res, 400, { error: redactString(errorMessageOf(error)) });
    }
  });

  app.delete("/api/workspaces/:id/members/:memberId", async (req, res) => {
    const workspace = await authorize(req, res, "members.manage", { workspaceId: req.params.id, targetType: "membership", targetId: req.params.memberId });
    if (!workspace) return;
    const members = await workspaceDirectory.listMembers(workspace.workspaceId);
    const target = members.find((member) => member.id === req.params.memberId);
    if (!target) return sendRedacted(res, 404, { error: "Member not found" });
    const removed = await workspaceDirectory.removeMembership(req.params.memberId);
    await auditRequest(req, { workspaceId: workspace.workspaceId, action: "members.remove", targetType: "membership", targetId: req.params.memberId, outcome: removed ? "success" : "failed" });
    sendRedacted(res, 200, { removed, id: req.params.memberId });
  });

  app.get("/api/audit/events", async (req, res) => {
    const workspace = await authorize(req, res, "audit.read", {
      workspaceId: typeof req.query.workspaceId === "string" ? req.query.workspaceId : undefined,
      targetType: "audit",
    });
    if (!workspace) return;
    const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
    const events = await auditLog.list({ workspaceId: workspace.workspaceId, limit: Number.isFinite(limitRaw) ? limitRaw : 100 });
    sendRedacted(res, 200, { events });
  });

  app.get("/api/quotas", async (req, res) => {
    const workspace = await authorize(req, res, "workspace.read", {
      workspaceId: typeof req.query.workspaceId === "string" ? req.query.workspaceId : undefined,
      targetType: "quota",
    });
    if (!workspace) return;
    sendRedacted(res, 200, {
      workspaceId: workspace.workspaceId,
      policy: await quotaService.getPolicy(workspace.workspaceId),
      usage: await quotaService.getUsage(workspace.workspaceId),
    });
  });

  app.put("/api/quotas", async (req, res) => {
    const workspaceId = typeof req.body?.workspaceId === "string" ? req.body.workspaceId : undefined;
    const workspace = await authorize(req, res, "billing.manage", { workspaceId, targetType: "quota" });
    if (!workspace) return;
    try {
      const policy = QuotaPolicySchema.parse(req.body?.policy ?? req.body ?? {});
      const saved = await quotaService.setPolicy(workspace.workspaceId, policy);
      await auditRequest(req, { workspaceId: workspace.workspaceId, action: "quota.update", targetType: "quota", outcome: "success" });
      sendRedacted(res, 200, { workspaceId: workspace.workspaceId, policy: saved });
    } catch (error) {
      sendRedacted(res, 400, { error: redactString(errorMessageOf(error)) });
    }
  });

  app.get("/api/setup/deployment-readiness", async (req, res) => {
    const workspace = await authorize(req, res, "workspace.read", { targetType: "setup" });
    if (!workspace) return;
    sendRedacted(res, 200, computeCommercialDeploymentReadiness(deploymentEnv));
  });

  app.post("/api/secrets/:id/rotate", async (req, res) => {
    const workspace = await authorize(req, res, "secrets.rotate", { targetType: "secret", targetId: req.params.id });
    if (!workspace) return;
    try {
      const body = z.object({ value: z.string().min(1) }).parse(req.body ?? {});
      const result = await storesFor(req).secretStore.setSecret(req.params.id, body.value);
      if (!result.ok) return sendRedacted(res, 500, { error: redactString(result.error) });
      await auditRequest(req, { workspaceId: workspace.workspaceId, action: "secret.rotate", targetType: "secret", targetId: req.params.id, outcome: "success" });
      sendRedactedPreservingPresence(res, 200, { id: req.params.id, rotated: true, secretPresent: true }, (redacted) => {
        redacted.secretPresent = true;
        return redacted;
      });
    } catch (error) {
      sendRedacted(res, 400, { error: redactString(errorMessageOf(error)) });
    }
  });

  const memoryRoleRouterByUser = new Map<string, MemoryRoleRouter>();
  const makeMemoryRoleRouter = (stores: UserStores): MemoryRoleRouter =>
    new MemoryRoleRouter({
      assignmentStore: stores.memoryAssignmentStore,
      configStore: stores.memoryConfigStore,
      secrets: stores.secretStore,
      mode: securityOptions.orchestration?.mode,
      delegateStoreForLocalSqliteMem: isSqlBackedStore(baseStore) ? rectorStore : undefined,
    });
  const defaultMemoryRoleRouter = makeMemoryRoleRouter(defaultUserStores);

  const getMemoryRoleRouterForUserStores = (userId: string, stores: UserStores): MemoryRoleRouter => {
    if (!authConfig.enabled || userId === "default") return defaultMemoryRoleRouter;
    const cached = memoryRoleRouterByUser.get(userId);
    if (cached) return cached;
    const router = makeMemoryRoleRouter(stores);
    memoryRoleRouterByUser.set(userId, router);
    return router;
  };

  const clearMemoryRoutingCaches = (): void => {
    defaultMemoryRoleRouter.clearCache();
    for (const router of memoryRoleRouterByUser.values()) router.clearCache();
  };

  const memoryRoleContextFor = (req?: express.Request, workspaceId?: string): { userId?: string; workspaceId?: string } => ({
    userId: authConfig.enabled ? req?.rectorAuth?.userId : undefined,
    workspaceId,
  });

  const getMemoryRoleRouterFor = (req?: express.Request): MemoryRoleRouter => {
    if (!authConfig.enabled || !req?.rectorAuth) return defaultMemoryRoleRouter;
    return getMemoryRoleRouterForUserStores(req.rectorAuth.userId, storesFor(req));
  };

  const resolveEffectiveMemoryProviderFor = async (
    req: express.Request | undefined,
    role: MemoryRole,
    workspaceId?: string,
  ) => {
    const router = getMemoryRoleRouterFor(req);
    return router.resolveMemoryProvider(role, {
      ...memoryRoleContextFor(req, workspaceId),
      mode: securityOptions.orchestration?.mode,
    });
  };

  const getMemoryProviderFor = async (
    req?: express.Request,
    role: MemoryRole = "episodicMemory",
    workspaceId?: string,
  ): Promise<MemoryProvider> => {
    const effective = await resolveEffectiveMemoryProviderFor(req, role, workspaceId);
    if (effective.provider) return effective.provider;
    await resolvePromise;
    return activeMemoryProvider ?? createPureLocalMemoryProvider();
  };

  const createMemoryProviderResolver = (
    req: express.Request,
    role: MemoryRole = "reflectionLessons",
  ): (() => Promise<MemoryProvider>) => {
    const userId = authConfig.enabled ? req.rectorAuth?.userId : undefined;
    const stores = storesFor(req);
    return () =>
      getMemoryRoleRouterForUserStores(userId ?? "default", stores)
        .resolveMemoryProvider(role, { userId, mode: securityOptions.orchestration?.mode })
        .then((effective) => effective.provider ?? createPureLocalMemoryProvider());
  };

  const resolveRuntimeModelRouterFor = async (req: express.Request, workspaceId?: string): Promise<ModelRouter | undefined> => {
    const mode = securityOptions.orchestration?.mode ?? "local";
    if (mode !== "external") return securityOptions.orchestration?.router;
    const userStores = storesFor(req);
    const scope = assignmentScopeFor(req, workspaceId);
    try {
      const assignments = await userStores.orchestrationAssignmentStore.listAssignments(scope);
      if (assignments.length === 0 && securityOptions.orchestration?.router) {
        // Compatibility path: when no Chunk 043 assignment exists, preserve the injected/startup
        // ModelRouter exactly. Existing external-mode tests and deployments depend on this router
        // for BYOK provider selection and provider spies.
        return securityOptions.orchestration.router;
      }
      const baseRouter = await buildConfiguredRouter({
        store: userStores.providerConfigStore,
        secrets: userStores.secretStore,
        mode: "external",
        enableNetwork: true,
        fetchImpl: fetch,
      });
      return buildConfiguredAssignmentAwareRouter({
        baseRouter,
        assignmentStore: userStores.orchestrationAssignmentStore,
        providerConfigStore: userStores.providerConfigStore,
        secrets: userStores.secretStore,
        scope,
        enableNetwork: true,
        fetchImpl: fetch,
      });
    } catch {
      // Compatibility fallback: preserve the startup router if dynamic per-user assignment routing
      // cannot be built. Local mode never reaches this branch.
      return securityOptions.orchestration?.router;
    }
  };

  // --- Chat routes ---

  app.post("/api/chat/conversations", async (req, res) => {
    try {
      const { title, workspaceId, retentionPolicy } = req.body ?? {};
      if (title !== undefined && typeof title !== "string") {
        return res.status(400).json({ error: "title must be a string" });
      }
      if (workspaceId !== undefined && typeof workspaceId !== "string") {
        return res.status(400).json({ error: "workspaceId must be a string" });
      }
      if (retentionPolicy !== undefined && typeof retentionPolicy !== "string") {
        return res.status(400).json({ error: "retentionPolicy must be a string" });
      }

      const access = await authorize(req, res, "runs.create", {
        workspaceId: typeof workspaceId === "string" && workspaceId.trim().length > 0 ? workspaceId.trim() : undefined,
        targetType: "conversation",
      });
      if (!access) return;

      const conversation = await rectorStore.createConversation({
        title: nonEmptyOrDefault(title, "New conversation"),
        workspaceId: access.workspaceId,
        retentionPolicy: nonEmptyOrDefault(retentionPolicy, "session"),
      });
      res.status(201).json(conversation);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get("/api/chat/conversations", async (req, res) => {
    try {
      const workspaceId = typeof req.query.workspaceId === "string" ? req.query.workspaceId : undefined;
      if (!authConfig.enabled) {
        const conversations = await rectorStore.listConversations(workspaceId);
        return res.json({ conversations });
      }
      if (workspaceId) {
        const access = await authorize(req, res, "runs.read", { workspaceId, targetType: "conversation" });
        if (!access) return;
        const conversations = await rectorStore.listConversations(access.workspaceId);
        return res.json({ conversations });
      }
      const memberships = await workspaceDirectory.listWorkspacesForUser(requestActorId(req));
      const allowedIds = new Set(memberships.map((entry) => entry.workspace.id));
      const conversations = (await rectorStore.listConversations()).filter((conversation) => allowedIds.has(conversation.workspaceId));
      res.json({ conversations });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/chat/conversations/:id", async (req, res) => {
    try {
      const conversation = await rectorStore.getConversation(req.params.id);
      if (!conversation) return res.status(404).json({ error: "Conversation not found" });
      const access = await authorize(req, res, "runs.read", { workspaceId: conversation.workspaceId, targetType: "conversation", targetId: conversation.id });
      if (!access) return;
      const messages = await rectorStore.listMessages(conversation.id);
      res.json({ conversation, messages });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Per-conversation cost aggregate (ORN-41, Req 3.6/3.10). Sums the per-run RunCostAggregates over
  // the conversation's runs (insertion order preserved). For an UNKNOWN conversation id we do NOT
  // 404: `listRuns` returns `[]`, so `aggregateConversationCost` yields a schema-valid all-zero
  // aggregate (runCount 0, all numeric totals 0, empty `runs`), exactly as Requirement 3.10 wants.
  // The extra `/cost` segment means this never shadows (and is never shadowed by) the
  // `GET /api/chat/conversations/:id` route above.
  app.get("/api/chat/conversations/:id/cost", async (req, res) => {
    try {
      const conversationId = req.params.id;
      const conversation = await rectorStore.getConversation(conversationId);
      const access = await authorize(req, res, "runs.read", { workspaceId: conversation?.workspaceId, targetType: "conversation", targetId: conversationId });
      if (!access) return;
      const runs = await rectorStore.listRuns(conversationId);
      const eventsByRun = new Map<string, RunEvent[]>();
      for (const run of runs) {
        eventsByRun.set(run.id, await rectorStore.listEvents(run.id));
      }
      res.json(aggregateConversationCost(conversationId, runs, eventsByRun));
    } catch (err: any) {
      res.status(500).json({ error: redactString(err?.message ?? String(err)) });
    }
  });

  app.post("/api/chat/conversations/:id/messages", async (req, res) => {
    try {
      const conversation = await rectorStore.getConversation(req.params.id);
      if (!conversation) return res.status(404).json({ error: "Conversation not found" });
      const access = await authorize(req, res, "runs.create", { workspaceId: conversation.workspaceId, targetType: "conversation", targetId: conversation.id });
      if (!access) return;
      if (!(await enforceRunQuota(req, res, access.workspaceId))) return;

      const { content, deepPlanning } = req.body ?? {};
      if (!content || typeof content !== "string") {
        return res.status(400).json({ error: "content (string) is required" });
      }
      const requestDeepPlanning = deepPlanning === true;

      const redactedContent = redactString(content);
      const redactionState = redactedContent === content ? "none" : "redacted";
      const userMessage = await rectorStore.createMessage({
        conversationId: conversation.id,
        role: "user",
        content: redactedContent,
        status: "created",
        redactionState,
      });
      const observability = createInMemoryObservabilityTrace({ provider: "local" });
      const orchestration = securityOptions.orchestration;

      // Shared chat pipeline: triage → context pack → runChat → assistant message + user-message
      // completion. `pipelineStore` is the store the run executes against: the broker-wrapped
      // `rectorStore` for the synchronous path, and a thin capturing wrapper in stream mode (so the
      // run/trace ids can be surfaced the instant the run is persisted). The result carries
      // everything both the synchronous 201 response and the background streaming branch need.
      const runChatPipeline = async (pipelineStore: RectorStore) => {
        const triage = await observability.recordSpan("TRIAGE", () => triageUserMessage(redactedContent));
        const contextPack = await observability.recordSpan("CONTEXT_BUILDING", async () => {
          const contextMaterial = await createContextMaterial(pipelineStore, {
            kind: "chat-user-message",
            content: redactedContent,
            summary: "Latest user message content",
            retentionPolicy: conversation.retentionPolicy,
            piiState: redactionState,
          });

          // Fetch recent time-aware memory for injection (Chunk 27 + 34). Episodic first, limited.
          // Now sourced from the resolved active MemoryProvider (pluggable: local-inmemory default,
          // local-sqlite-mem, or external like Mem0). For the default provider this is byte-identical
          // to the pre-34 direct store call, preserving all existing memoryAdvanced / context tests.
          const memoryProviderInstance = await getMemoryProviderFor(req, "episodicMemory", conversation.workspaceId);
          const recentMemory = await memoryProviderInstance.searchMemory(undefined, {
            layer: "episodic",
            limit: EPISODIC_MEMORY_SEARCH_LIMIT,
          });

          return buildContextPack(pipelineStore, {
            conversation,
            messages: await pipelineStore.listMessages(conversation.id),
            userMessage,
            triage,
            materials: [contextMaterial],
            memoryEntries: recentMemory,
          });
        });
        const runtimeRouter = await resolveRuntimeModelRouterFor(req, conversation.workspaceId);
        const result = await runChat(
          pipelineStore,
          {
            conversationId: conversation.id,
            userMessageId: userMessage.id,
            prompt: redactedContent,
            triage,
            contextPack,
            observability,
            options: {
              ...orchestration,
              ...(orchestration?.mode === "external" && requestDeepPlanning ? { deepPlanning: true } : {}),
            },
          },
          {
            // Default to local (provider-free) when no orchestration option is configured so existing
            // behavior and tests are unchanged. enableNetwork is only meaningful in external mode.
            mode: orchestration?.mode ?? "local",
            router: runtimeRouter,
            enableNetwork: orchestration?.mode === "external",
            moduleRegistry,
          }
        );
        const assistantMessage = await pipelineStore.createMessage({
          conversationId: conversation.id,
          role: "assistant",
          content: result.synthesis.response,
          status: "completed",
          runId: result.run.id,
          redactionState,
        });
        await pipelineStore.updateMessage(userMessage.id, { status: "completed", runId: result.run.id });
        return { ...result, assistantMessage };
      };

      // Streaming branch (ORN-40, Req 2.1/2.7/2.11): when `?stream=1` is requested, create the run
      // and return `{ runId, traceId }` with `202` BEFORE the run reaches a Terminal_Phase, then run
      // the pipeline in the background. Persisted events publish to the broker automatically (the
      // store is broker-wrapped), so the client consumes them via `GET /api/runs/:id/stream`. The
      // synchronous POST below and the `GET /api/runs/:id/events` Polling_Endpoint are unchanged.
      const wantsStream = req.query.stream === "1" || req.query.stream === "true";
      if (wantsStream) {
        let resolveRun!: (run: Run) => void;
        let rejectRun!: (error: unknown) => void;
        const runCreated = new Promise<Run>((resolve, reject) => {
          resolveRun = resolve;
          rejectRun = reject;
        });

        // Capture the run the instant `runChat` persists it — the only point at which a runId/traceId
        // becomes available — without creating a second run. Every other method delegates to the
        // broker-wrapped store, so persisted events still publish to live SSE subscribers.
        const capturingStore: RectorStore = {
          ...rectorStore,
          createRun: async (input) => {
            try {
              const run = await rectorStore.createRun(input);
              resolveRun(run);
              return run;
            } catch (error) {
              rejectRun(error);
              throw error;
            }
          },
        };

        // Background run: never awaited before the 202. A failure AFTER the run is created surfaces to
        // the client over the SSE stream (runChat persists a FAILED transition → terminal `done`
        // frame); a failure BEFORE the run is created rejects `runCreated` so the request returns a
        // redacted error and no stream is ever opened. The `.catch` keeps the rejection handled, so a
        // background failure never produces an unhandled promise rejection or crashes the process.
        const resolveMemoryProvider = createMemoryProviderResolver(req);
        void runChatPipeline(capturingStore)
          .then(async (result) => {
            await moduleRegistry.invokeOnRunCompleted({
              store: rectorStore,
              run: result.run,
              mode: orchestration?.mode ?? "local",
              router: orchestration?.router,
              getMemoryProvider: resolveMemoryProvider,
            });
          })
          .catch((error) => {
            rejectRun(error);
          });

        try {
          const run = await runCreated;
          await quotaService.recordRunCreated(access.workspaceId, { estimatedUsd: numericField(run.costEstimate, "usd") });
          return res.status(202).json({ runId: run.id, traceId: run.traceId });
        } catch (error) {
          // Run-creation failure: redacted error, no background run persisted, and no stream opened
          // (the stream is a separate GET the client never reaches without a runId).
          return res.status(400).json({ error: redactString(requestValidationMessage(error)) });
        }
      }

      // Synchronous (non-stream) path — unchanged behavior, preserved as the streaming fallback.
      const { run, synthesis, observabilitySummary, assistantMessage } = await runChatPipeline(rectorStore);
      await quotaService.recordRunCreated(access.workspaceId, { estimatedUsd: numericField(run.costEstimate, "usd") });
      await moduleRegistry.invokeOnRunCompleted({
        store: rectorStore,
        run,
        mode: orchestration?.mode ?? "local",
        router: orchestration?.router,
        getMemoryProvider: createMemoryProviderResolver(req),
      });
      const events = await rectorStore.listEvents(run.id);
      const completedRun = await rectorStore.getRun(run.id);

      res.status(201).json({
        userMessage: { ...userMessage, status: "completed", runId: run.id },
        assistantMessage,
        run: completedRun ?? run,
        events,
        observability: observabilitySummary,
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Quick-capture notes (Chunk 27 / neuro-symbolic Step 2)
  // Writes to episodic memory layer with time-awareness. Content is redacted.
  // Local mode only for alpha; future auth + workspace scoping.
  app.post("/api/notes", async (req, res) => {
    try {
      const { content, tags, conversationId } = req.body ?? {};
      if (!content || typeof content !== "string") {
        return sendRedacted(res, 400, { error: "content (string) is required" });
      }

      const noteWorkspaceId = typeof conversationId === "string" ? await workspaceIdForConversation(conversationId) : undefined;
      const access = await authorize(req, res, "runs.create", { workspaceId: noteWorkspaceId, targetType: "memory" });
      if (!access) return;

      const redacted = redactString(content);
      const now = new Date().toISOString();

      const entryInput: CreateMemoryEntryInput = {
        layer: "episodic",
        content: redacted,
        timestamp: now,
        lastMentioned: now,
        accessCount: 1,
        tags: Array.isArray(tags) ? tags.filter((t: unknown): t is string => typeof t === "string") : [],
        source: "user-note",
        metadata: {
          conversationId: typeof conversationId === "string" ? conversationId : undefined,
          redactionState: redacted === content ? "none" : "redacted",
        },
      };

      // Chunk 34: notes (episodic memory writes + opportunistic prune) now go through the
      // resolved pluggable MemoryProvider. For the default local-inmemory provider this is
      // identical to the previous direct rectorStore call (preserves all existing behavior
      // and tests for /api/notes + context injection).
      const memoryProviderInstance = await getMemoryProviderFor(req, "episodicMemory");
      const entry = await memoryProviderInstance.createMemoryEntry(entryInput);

      // Opportunistic prune on write (keeps memory bounded)
      await memoryProviderInstance.pruneMemory({ targetLayer: "episodic", maxEntries: 200 });

      sendRedacted(res, 201, { note: redactMemoryEntryForEgress(entry) });
    } catch (err: any) {
      sendRedacted(res, 400, { error: redactString(err?.message ?? String(err)) });
    }
  });

  // Read-only memory browser list (Chunk 36 stretch). Returns redacted episodic/core entries from
  // the resolved MemoryProvider — no secrets, no mutation.
  app.get("/api/memory/entries", async (req, res) => {
    try {
      const access = await authorize(req, res, "workspace.read", { targetType: "memory" });
      if (!access) return;
      const layerRaw = req.query.layer;
      let layer: MemoryLayer | undefined;
      if (layerRaw !== undefined) {
        if (typeof layerRaw !== "string") {
          return sendRedacted(res, 400, { error: "layer must be episodic or core" });
        }
        const parsed = MemoryEntriesLayerQuerySchema.safeParse(layerRaw);
        if (!parsed.success) {
          return sendRedacted(res, 400, { error: "layer must be episodic or core" });
        }
        layer = parsed.data;
      }

      const browserRole: MemoryRole = layer === "core" ? "semanticMemory" : "episodicMemory";
      const memoryProviderInstance = await getMemoryProviderFor(req, browserRole);
      const payload = await listMemoryEntriesForApi(memoryProviderInstance, { layer });
      sendRedacted(res, 200, payload);
    } catch (error) {
      sendRedacted(res, 500, { error: redactString(errorMessageOf(error)) });
    }
  });

  app.get("/api/runs/:id/events", async (req, res) => {
    try {
      const run = await rectorStore.getRun(req.params.id);
      if (!run) return res.status(404).json({ error: "Run not found" });
      const workspaceId = await workspaceIdForConversation(run.conversationId);
      const access = await authorize(req, res, "runs.read", { workspaceId, targetType: "run", targetId: run.id });
      if (!access) return;
      const events = await rectorStore.listEvents(run.id);
      res.json({ run, events });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Live SSE run stream (ORN-40): catch-up replay of persisted events, then live frames from the
  // broker-wrapped store, with a heartbeat keep-alive and clean teardown. The polling endpoint
  // above is preserved unchanged as the fallback.
  registerRunStreamRoute(app, {
    store: rectorStore,
    broker: runEventBroker,
    authorizeRunRead: async (req, res, runId) => {
      const workspaceId = await workspaceIdForRun(runId);
      const access = await authorize(req, res, "runs.read", { workspaceId, targetType: "run", targetId: runId });
      return Boolean(access);
    },
  });

  // Per-run cost aggregate (ORN-41, Req 3.6/3.10). Derives the RunCostAggregate from the run's
  // persisted (already-redacted) events. For an UNKNOWN run id we do NOT 404: `listEvents` returns
  // `[]`, so `aggregateRunCost` yields a schema-valid all-zero aggregate (the requested runId, all
  // numeric totals 0, empty provider/model lists), exactly as Requirement 3.10 specifies.
  app.get("/api/runs/:id/cost", async (req, res) => {
    try {
      const runId = req.params.id;
      const workspaceId = await workspaceIdForRun(runId);
      const access = await authorize(req, res, "runs.read", { workspaceId, targetType: "run", targetId: runId });
      if (!access) return;
      const events = await rectorStore.listEvents(runId);
      res.json(aggregateRunCost(runId, events));
    } catch (err: any) {
      res.status(500).json({ error: redactString(err?.message ?? String(err)) });
    }
  });

  // Run Approval UX decision endpoint (Requirement 9). Records a user's approve/deny decision over a
  // pending operation and continues the run. `recordApprovalDecision` appends the decision (with the
  // deciding identity and timestamp) to the Event_Log atomically with the run transition, BEFORE the
  // operation executes or is cancelled (Req 9.3): an approval resumes to EXECUTING, a denial (or a
  // 30-minute timeout) resumes to a final answer that excludes the operation (Req 9.5, 9.8). When the
  // decision cannot be recorded — the run is not awaiting this operation's decision, or the Event_Log
  // write fails — the run is left pending and a redacted indication is surfaced (Req 9.7). Every
  // outbound message is routed through `redactString` so no secret substring escapes (Req 9.6/11.3).
  app.post("/api/runs/:id/decision", async (req, res) => {
    const runId = req.params.id;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { operationId, decision, decidedBy } = body;

    if (typeof operationId !== "string" || operationId.length === 0) {
      return res.status(400).json({ error: "operationId (string) is required" });
    }
    if (decision !== "approve" && decision !== "deny") {
      return res.status(400).json({ error: "decision must be 'approve' or 'deny'" });
    }
    if (typeof decidedBy !== "string" || decidedBy.length === 0) {
      return res.status(400).json({ error: "decidedBy (string) is required" });
    }

    try {
      const workspaceId = await workspaceIdForRun(runId);
      const access = await authorize(req, res, "runs.approve", { workspaceId, targetType: "run", targetId: runId });
      if (!access) return;
      const record = await recordApprovalDecision(
        rectorStore,
        { runId, operationId, decision: decision as ApprovalDecision, decidedBy },
        {}
      );
      // Outbound boundary: route the decision record through the suppression helper so a redaction
      // failure suppresses the raw record and returns a redaction-failed error (Req 9.6, 11.1, 11.5).
      await auditRequest(req, { workspaceId: access.workspaceId, action: "run.decision", targetType: "run", targetId: runId, outcome: "success" });
      return sendRedacted(res, 200, { decisionProcessed: true, record });
    } catch (error) {
      if (error instanceof ApprovalProcessingError) {
        // Req 9.7: do not execute, keep the run in its pending-decision state, and indicate the
        // decision could not be processed. RUN_NOT_FOUND maps to 404; everything else is a conflict
        // with the run's current state (409).
        const httpStatus = error.code === "RUN_NOT_FOUND" ? 404 : 409;
        return sendRedacted(res, httpStatus, {
          decisionProcessed: false,
          code: error.code,
          error: redactString(error.message),
        });
      }
      return sendRedacted(res, 500, {
        decisionProcessed: false,
        error: redactString(error instanceof Error ? error.message : String(error)),
      });
    }
  });

  // --- Local-only operator routes for optional Retool console ---

  app.use("/api/operator", async (req, res, next) => {
    const permission: Permission = req.method === "GET" ? "operator.read" : "operator.manage";
    const access = await authorize(req, res, permission, { targetType: "operator" });
    if (!access) return;
    next();
  });

  app.get("/api/operator/runs", async (_req, res) => {
    try {
      const runs = await rectorStore.listRuns();
      res.json(operatorEnvelope({ runs: runs.map(summarizeOperatorRun) }));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/operator/runs/:id", async (req, res) => {
    try {
      const run = await rectorStore.getRun(req.params.id);
      if (!run) return res.status(404).json({ error: "Run not found" });

      const conversation = await rectorStore.getConversation(run.conversationId);
      const messages = await rectorStore.listMessages(run.conversationId);
      const events = await rectorStore.listEvents(run.id);
      const artifactHandles = collectArtifactHandles(events);

      res.json(
        operatorEnvelope({
          run,
          conversation,
          userMessage: messages.find((message) => message.id === run.userMessageId),
          assistantMessages: messages.filter((message) => message.role === "assistant" && message.runId === run.id),
          events,
          artifactHandles,
        })
      );
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/operator/failures", async (_req, res) => {
    try {
      const runs = await rectorStore.listRuns();
      const events = await rectorStore.listEvents();
      const failures = runs
        .filter(isOperatorFailureRun)
        .map((run) => ({
          ...summarizeOperatorRun(run),
          lastError: run.lastError,
          failureEvents: events.filter((event) => event.runId === run.id && isFailureEvent(event)),
        }));

      res.json(operatorEnvelope({ failures }));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/operator/approvals", async (_req, res) => {
    try {
      const runs = await rectorStore.listRuns();
      const approvals = runs
        .filter((run) => run.phase === "NEEDS_DECISION" || run.decisionRequest !== undefined)
        .map((run) => ({
          ...summarizeOperatorRun(run),
          decisionRequest: run.decisionRequest ?? {},
        }));

      res.json(operatorEnvelope({ approvals }));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/operator/approvals/:runId/decision", async (req, res) => {
    try {
      const run = await rectorStore.getRun(req.params.runId);
      if (!run) return res.status(404).json({ error: "Run not found" });
      const { decision, note } = req.body ?? {};
      if (decision === undefined) {
        return res.status(400).json({ error: "decision is required" });
      }

      res.status(202).json(
        operatorEnvelope({
          status: "placeholder",
          mutated: false,
          run: summarizeOperatorRun(run),
          decision: redactSecrets({ decision, note }),
          message: "Decision captured as a local-only placeholder; approval resume is not implemented in Chunk 21.",
        })
      );
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get("/api/operator/costs", async (_req, res) => {
    try {
      const runs = await rectorStore.listRuns();
      res.json(operatorEnvelope({ summary: summarizeOperatorCosts(runs), runs: runs.map(summarizeOperatorRun) }));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/operator/runs/:id/retry", async (req, res) => {
    try {
      const run = await rectorStore.getRun(req.params.id);
      if (!run) return res.status(404).json({ error: "Run not found" });
      res.status(202).json(
        operatorEnvelope({
          status: "placeholder",
          action: "retry",
          mutated: false,
          run: summarizeOperatorRun(run),
          message: "Retry control is a local-only placeholder until real executor resume semantics exist.",
        })
      );
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/operator/runs/:id/abort", async (req, res) => {
    try {
      const run = await rectorStore.getRun(req.params.id);
      if (!run) return res.status(404).json({ error: "Run not found" });
      res.status(202).json(
        operatorEnvelope({
          status: "placeholder",
          action: "abort",
          mutated: false,
          run: summarizeOperatorRun(run),
          message: "Abort control is a local-only placeholder until cancellable execution exists.",
        })
      );
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get("/api/operator/artifacts/:id", async (req, res) => {
    try {
      const artifact = await rectorStore.getArtifact(req.params.id);
      if (!artifact) return res.status(404).json({ error: "Artifact not found" });
      res.json(operatorEnvelope({ artifact: artifactMetadataOnly(artifact) }));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/operator/linear/issues", async (req, res) => {
    try {
      const { runId, title, description } = req.body ?? {};
      if (runId !== undefined && typeof runId !== "string") {
        return res.status(400).json({ error: "runId must be a string when provided" });
      }
      if (!title || typeof title !== "string") {
        return res.status(400).json({ error: "title (string) is required" });
      }
      if (description !== undefined && typeof description !== "string") {
        return res.status(400).json({ error: "description must be a string when provided" });
      }
      if (runId) {
        const run = await rectorStore.getRun(runId);
        if (!run) return res.status(404).json({ error: "Run not found" });
      }

      res.status(202).json(
        operatorEnvelope({
          status: "stubbed",
          networkCalls: 0,
          issue: {
            key: `LOCAL-LINEAR-${stableStubIssueNumber(runId ?? title)}`,
            title: title.trim(),
            description: description?.trim() ?? "",
            runId,
            url: null,
          },
          message: "Linear issue creation is stubbed locally; no network request was made.",
        })
      );
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // --- Task routes ---

  app.use("/api/tasks", async (req, res, next) => {
    let permission: Permission = "runs.read";
    if (req.method === "POST" && req.path === "/") permission = "runs.create";
    else if (req.method === "POST" && req.path.endsWith("/approve")) permission = "runs.approve";
    else if (req.method === "POST" && req.path.endsWith("/abort")) permission = "runs.abort";
    else if (req.method === "POST") permission = "operator.manage";
    const access = await authorize(req, res, permission, { targetType: "task" });
    if (!access) return;
    next();
  });

  app.post("/api/tasks", (req, res) => {
    try {
      const { description } = req.body ?? {};
      if (!description || typeof description !== "string") {
        return res.status(400).json({ error: "description (string) is required" });
      }
      const task = manager.createTask(description);
      res.status(201).json(task);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get("/api/tasks", async (_req, res) => {
    try {
      const tasks = await manager.listTasks();
      res.json(tasks);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/tasks/:id", async (req, res) => {
    try {
      const task = await manager.getTask(req.params.id);
      if (!task) return res.status(404).json({ error: "Not found" });
      res.json(task);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Control routes ---

  app.post("/api/tasks/:id/retry", async (req, res) => {
    try {
      const task = await manager.getTask(req.params.id);
      if (!task) return res.status(404).json({ error: "Not found" });
      if (task.state !== STATES.PAUSED) {
        return res.status(400).json({ error: `Cannot retry from ${task.state}` });
      }
      const updated = await manager.transition(req.params.id, STATES.INTAKE);
      res.json(updated);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/tasks/:id/pause", async (req, res) => {
    try {
      const task = await manager.getTask(req.params.id);
      if (!task) return res.status(404).json({ error: "Not found" });
      const updated = await manager.transition(req.params.id, STATES.PAUSED);
      res.json(updated);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/tasks/:id/approve", async (req, res) => {
    try {
      const task = await manager.getTask(req.params.id);
      if (!task) return res.status(404).json({ error: "Not found" });
      if (task.state !== STATES.HUMAN_HANDOFF) {
        return res.status(400).json({ error: `Cannot approve from ${task.state}` });
      }
      const approved = await manager.approve(req.params.id);
      res.json(approved);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/tasks/:id/abort", async (req, res) => {
    try {
      const task = await manager.getTask(req.params.id);
      if (!task) return res.status(404).json({ error: "Not found" });
      const updated = await manager.transition(req.params.id, STATES.ABORTED);
      res.json(updated);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // --- Advance pipeline one step ---

  app.post("/api/tasks/:id/advance", async (req, res) => {
    try {
      const task = await manager.advance(req.params.id);
      res.json(task);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Telemetry ---

  app.get("/api/telemetry", async (req, res) => {
    const access = await authorize(req, res, "operator.read", { targetType: "telemetry" });
    if (!access) return;
    res.json(manager.telemetry.getMetrics());
  });

  // --- Setup checklist ---

  app.get("/api/setup", async (req, res) => {
    const access = await authorize(req, res, "workspace.read", { targetType: "setup" });
    if (!access) return;
    res.json(getSetupChecklist());
  });

  // Setup status (Requirement 1): the redacted, presence-only readiness summary the Setup_Wizard
  // renders. The handler is fast and non-blocking — it composes the ambient `process.env` and the
  // (default empty) SecretStore via `computeSetupStatus`, which performs no network I/O — so the
  // client can safely apply its own 10s timeout (Requirement 1.9). `computeSetupStatus` already
  // routes the response through the Redaction_Layer (Requirement 1.3). Any internal failure is
  // caught and returned as a structured, redacted error state so the wizard can show an error and
  // keep the chat/trace UI accessible (Requirement 1.8); the redacted message never carries a
  // secret substring.
  const resolveMemoryProviderForTest =
    securityOptions.resolveTestMemoryProvider ?? resolveTestMemoryProvider;
  app.get("/api/setup/status", async (_req, res) => {
    try {
      const status = await computeSetupStatus(process.env, setupSecretStore, memoryConfigStore);
      // `computeSetupStatus` is itself the redaction boundary for this payload: it routes every
      // field through the Redaction_Layer per-field (and omits any value whose redaction fails,
      // Req 1.10) precisely because a blanket `redactSecrets` pass would treat the legitimately
      // named `secretPresence` field as sensitive and drop it. Emitting the already-redacted result
      // directly preserves that contract; an upstream redaction failure throws and is suppressed by
      // the catch below (Req 1.3, 11.1, 11.5).
      res.json(status);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Suppress the error body too: redact it, and if even that fails, emit only the fixed
      // redaction-failed placeholder rather than any raw message (Req 1.8, 1.10, 11.3, 11.5).
      const outcome = redactOutbound({ error: redactString(message) });
      res.status(500).json(outcome.ok ? outcome.value : { error: REDACTION_FAILED_ERROR });
    }
  });

  // Workspace safety status (Requirement 3): the redacted, read-only sandbox safety policy the
  // Workspace_Safety_Panel renders. The handler reads configuration only — the workspace root,
  // allowlisted commands, destructive-protection status, and approval-required categories — and
  // never executes any command (Req 3.5, 3.6). `buildWorkspaceSafetyResponse` routes the workspace
  // root through the Redaction_Layer (Req 3.7) and returns `available:false` when the root or policy
  // cannot be retrieved (Req 3.8). A build failure is surfaced as `available:false` so the panel
  // shows the unavailable state with no action controls; the response is then sent via
  // `sendRedacted`, which redacts the outbound body and — if redaction itself fails — suppresses the
  // raw content and returns a redaction-failed error instead (Req 11.5).
  const workspaceSafetyConfig = securityOptions.workspaceSafety ?? resolveWorkspaceSafetyConfig(process.env);
  app.get("/api/setup/workspace", async (req, res) => {
    const access = await authorize(req, res, "workspace.read", { targetType: "setup" });
    if (!access) return;
    let response: WorkspaceSafetyResponse;
    try {
      response = buildWorkspaceSafetyResponse(workspaceSafetyConfig);
    } catch {
      // A build failure is treated as "policy unavailable" (Req 3.8); still redacted on the way out.
      response = { ...UNAVAILABLE_WORKSPACE_SAFETY };
    }
    // Outbound boundary: redact and, if redaction fails, suppress the raw content and return a
    // redaction-failed error instead of emitting unredacted data (Req 3.7, 11.1, 11.5).
    sendRedacted(res, 200, response);
  });

  // --- Provider connection test (ORN-32) ---

  app.post("/api/setup/test-connection", async (req, res) => {
    const access = await authorize(req, res, "providers.configure", { targetType: "provider" });
    if (!access) return;
    let request: TestConnectionRequest;
    try {
      request = TestConnectionRequestSchema.parse(req.body ?? {});
    } catch (err: unknown) {
      return res.status(400).json({ error: redactString(requestValidationMessage(err)) });
    }

    try {
      const userStores = storesFor(req);
      // Config_Bridge resolution (design C5/C8): build exactly one provider from the persisted
      // Provider_Config_Record identified by `providerId` plus its Secret_Store secret, with
      // persisted UI configuration taking precedence over `process.env` (Req 13.2/13.4). Selection
      // is keyed off persisted records, so any configured kind — including `openai-compatible` — is
      // testable. `resolveTestProvider` returns `undefined` when no persisted record matches the id;
      // that id is rejected with a 400 BEFORE any provider build/network call, keeping the same
      // redacted, `networkAttempted:false` contract the env-only path used for an unsupported id
      // (Req 15.6). The body keeps the safe TestConnectionResponse shape.
      const provider = await resolveTestProvider(
        request.providerId,
        userStores.providerConfigStore,
        userStores.secretStore,
        { enableNetwork: true, fetchImpl: fetch },
        // Per-model Model_Probe targeting (Req 22.1, 22.2): build the provider for the selected
        // candidate's model/deployment when supplied; a plain test passes neither.
        { model: request.model, deployment: request.deployment },
      );
      if (!provider) {
        return res.status(400).json(
          TestConnectionResponseSchema.parse({
            ok: false,
            providerId: request.providerId,
            code: "CONFIG_INVALID",
            category: classifyProbeError({
              code: "CONFIG_INVALID",
              message: `Unsupported providerId: ${request.providerId}`,
            }),
            error: redactString(`Unsupported providerId: ${request.providerId}`),
            networkAttempted: false,
          })
        );
      }

      // Validate → single-ping flow is unchanged; the resolved provider is pinged directly so the
      // connection test reflects the persisted config + secret rather than env-only (Req 15.1). The
      // selected model/deployment targets the single ping at exactly that candidate (Req 22.1, 22.2).
      const result = await runConnectionTest({
        providerId: request.providerId,
        provider,
        model: request.model,
        deployment: request.deployment,
        fetchImpl: fetch,
      });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: redactString(err?.message ?? String(err)) });
    }
  });

  const errorMessageOf = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

  // --- Orchestration_Model_Assignment_API (Chunk 043) ---
  // Stores only non-secret role → provider/model/budget assignments. Provider credentials remain in
  // Secret_Store-backed Provider_Config_Records and are never serialized by these endpoints.

  app.get("/api/orchestration-models/roles", async (req, res) => {
    try {
      const payload = await buildOrchestrationModelsPayload(req, workspaceIdFromQuery(req));
      sendRedacted(res, 200, {
        roles: payload.roles,
        providers: payload.providers,
      });
    } catch (error) {
      sendRedacted(res, 500, { error: redactString(errorMessageOf(error)) });
    }
  });

  app.get("/api/orchestration-models/assignments", async (req, res) => {
    try {
      const payload = await buildOrchestrationModelsPayload(req, workspaceIdFromQuery(req));
      sendRedacted(res, 200, payload);
    } catch (error) {
      sendRedacted(res, 500, { error: redactString(errorMessageOf(error)) });
    }
  });

  app.get("/api/orchestration-models/effective", async (req, res) => {
    try {
      const payload = await buildOrchestrationModelsPayload(req, workspaceIdFromQuery(req));
      sendRedacted(res, 200, payload);
    } catch (error) {
      sendRedacted(res, 500, { error: redactString(errorMessageOf(error)) });
    }
  });

  app.put("/api/orchestration-models/assignments/:role", async (req, res) => {
    let role: OrchestrationRole;
    let body: z.infer<typeof OrchestrationAssignmentUpsertSchema>;
    try {
      role = OrchestrationRoleSchema.parse(req.params.role);
      body = OrchestrationAssignmentUpsertSchema.parse(req.body ?? {});
    } catch (err: unknown) {
      return sendRedacted(res, 400, { error: redactString(requestValidationMessage(err)) });
    }

    try {
      const userStores = storesFor(req);
      const scope = assignmentScopeFor(req, body.workspaceId);
      const [existing, existingAssignments, providerState] = await Promise.all([
        userStores.orchestrationAssignmentStore.getAssignment(role, scope),
        userStores.orchestrationAssignmentStore.listAssignments(scope),
        userStores.providerConfigStore.getState(),
      ]);
      const now = new Date().toISOString();
      const candidate = OrchestrationModelAssignmentSchema.parse({
        id: existing?.id ?? orchestrationAssignmentId(role, scope),
        ...(scope.userId ? { userId: scope.userId } : {}),
        ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
        role,
        providerId: body.providerId,
        ...(body.modelId ? { modelId: body.modelId } : {}),
        ...(body.fallbackProviderId ? { fallbackProviderId: body.fallbackProviderId } : {}),
        ...(body.fallbackModelId ? { fallbackModelId: body.fallbackModelId } : {}),
        enabled: body.enabled ?? existing?.enabled ?? true,
        ...(body.maxUsdPerCall !== undefined ? { maxUsdPerCall: body.maxUsdPerCall } : {}),
        ...(body.maxTokens !== undefined ? { maxTokens: body.maxTokens } : {}),
        ...(body.timeoutMs !== undefined ? { timeoutMs: body.timeoutMs } : {}),
        ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
        ...(body.requiresJsonMode !== undefined ? { requiresJsonMode: body.requiresJsonMode } : {}),
        ...(body.requiresToolCalling !== undefined ? { requiresToolCalling: body.requiresToolCalling } : {}),
        ...(body.requiresStreaming !== undefined ? { requiresStreaming: body.requiresStreaming } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      const withoutCandidate = existingAssignments.filter((assignment) => assignment.role !== role);
      const effective = resolveEffectiveAssignment({
        role,
        assignments: [...withoutCandidate, candidate],
        providerState,
        scope,
      });
      const blockers = effective.warnings.filter((warning) => warning.severity === "blocker");
      if (blockers.length > 0) {
        return sendRedacted(res, 400, {
          error: "Assignment does not satisfy required role capabilities.",
          warnings: effective.warnings,
        });
      }

      const result = await userStores.orchestrationAssignmentStore.upsertAssignment(role, body, scope);
      if (!result.ok) {
        return sendRedacted(res, 500, { error: redactString(result.error) });
      }
      const payload = await buildOrchestrationModelsPayload(req, scope.workspaceId);
      sendRedacted(res, 200, { assignment: result.value, effective, assignments: payload.assignments });
    } catch (error) {
      sendRedacted(res, 500, { error: redactString(errorMessageOf(error)) });
    }
  });

  app.post("/api/orchestration-models/assignments/:role/test", async (req, res) => {
    let role: OrchestrationRole;
    let body: TestOrchestrationAssignmentRequest;
    try {
      role = OrchestrationRoleSchema.parse(req.params.role);
      body = TestOrchestrationAssignmentRequestSchema.parse(req.body ?? {});
    } catch (err: unknown) {
      return sendRedacted(res, 400, { error: redactString(requestValidationMessage(err)) });
    }

    try {
      const userStores = storesFor(req);
      const scope = assignmentScopeFor(req, body.workspaceId);
      const providerState = await userStores.providerConfigStore.getState();
      const saved = await userStores.orchestrationAssignmentStore.getAssignment(role, scope);
      const draft = body.providerId
        ? OrchestrationModelAssignmentSchema.parse({
            id: saved?.id ?? orchestrationAssignmentId(role, scope),
            ...(scope.userId ? { userId: scope.userId } : {}),
            ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
            role,
            providerId: body.providerId,
            ...(body.modelId ? { modelId: body.modelId } : {}),
            ...(body.fallbackProviderId ? { fallbackProviderId: body.fallbackProviderId } : {}),
            ...(body.fallbackModelId ? { fallbackModelId: body.fallbackModelId } : {}),
            enabled: body.enabled ?? saved?.enabled ?? true,
            ...(body.maxUsdPerCall !== undefined ? { maxUsdPerCall: body.maxUsdPerCall } : {}),
            ...(body.maxTokens !== undefined ? { maxTokens: body.maxTokens } : {}),
            ...(body.timeoutMs !== undefined ? { timeoutMs: body.timeoutMs } : {}),
            ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
            ...(body.requiresJsonMode !== undefined ? { requiresJsonMode: body.requiresJsonMode } : {}),
            ...(body.requiresToolCalling !== undefined ? { requiresToolCalling: body.requiresToolCalling } : {}),
            ...(body.requiresStreaming !== undefined ? { requiresStreaming: body.requiresStreaming } : {}),
            ...(body.notes !== undefined ? { notes: body.notes } : {}),
            createdAt: saved?.createdAt ?? new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          })
        : saved;
      const effective = draft
        ? resolveEffectiveAssignment({ role, assignments: [draft], providerState, scope })
        : resolveEffectiveAssignment({ role, assignments: [], providerState, scope });

      if (!effective.enabled || effective.providerId === "disabled") {
        return sendRedacted(res, 200, {
          ok: true,
          role,
          providerId: effective.providerId,
          model: effective.modelId,
          networkAttempted: false,
          warnings: effective.warnings,
        });
      }
      if (effective.providerId === "deterministic") {
        return sendRedacted(res, 200, {
          ok: true,
          role,
          providerId: "deterministic",
          model: effective.modelId ?? "deterministic-local",
          networkAttempted: false,
          warnings: effective.warnings,
        });
      }

      const provider = await resolveTestProvider(
        effective.providerId,
        userStores.providerConfigStore,
        userStores.secretStore,
        { enableNetwork: true, fetchImpl: fetch },
        effective.modelId ? { model: effective.modelId, deployment: effective.modelId } : {},
      );
      if (!provider) {
        return sendRedacted(res, 400, {
          ok: false,
          role,
          providerId: effective.providerId,
          code: "CONFIG_INVALID",
          error: redactString(`Provider ${effective.providerId} is not configured.`),
          networkAttempted: false,
          warnings: effective.warnings,
        });
      }

      const result = await runConnectionTest({
        providerId: effective.providerId,
        provider,
        model: effective.modelId,
        deployment: effective.modelId,
        fetchImpl: fetch,
      });
      sendRedacted(res, result.ok ? 200 : 400, { ...result, role, warnings: effective.warnings });
    } catch (error) {
      sendRedacted(res, 500, { error: redactString(errorMessageOf(error)) });
    }
  });

  app.post("/api/orchestration-models/assignments/reset", async (req, res) => {
    try {
      const workspaceId = typeof (req.body ?? {}).workspaceId === "string" ? String((req.body ?? {}).workspaceId).trim() : undefined;
      const userStores = storesFor(req);
      const result = await userStores.orchestrationAssignmentStore.resetAssignments(assignmentScopeFor(req, workspaceId));
      if (!result.ok) return sendRedacted(res, 500, { error: redactString(result.error) });
      const payload = await buildOrchestrationModelsPayload(req, workspaceId);
      sendRedacted(res, 200, payload);
    } catch (error) {
      sendRedacted(res, 500, { error: redactString(errorMessageOf(error)) });
    }
  });

  app.use("/api/providers", async (req, res, next) => {
    let permission: Permission = "providers.read";
    if (req.method === "POST" && req.path === "/active") permission = "models.assign";
    else if (req.method === "POST" && req.path.endsWith("/secret")) permission = "providers.secrets.write";
    else if (req.method === "POST" && req.path.endsWith("/models/refresh")) permission = "providers.configure";
    else if (req.method === "POST") permission = "providers.configure";
    else if (req.method === "DELETE") permission = "providers.configure";
    const access = await authorize(req, res, permission, { targetType: "provider" });
    if (!access) return;
    next();
  });

  // --- Provider_Config_API: BYOK CRUD + selection (design C7, Req 10/11/14) ---
  //
  // Every response is routed through `sendRedacted`/`redactOutbound` so no full or partial secret
  // value can appear in any response (Req 11.4). Secrets are accepted on input, persisted ONLY via
  // the Secret_Store, and never written to the Provider_Config_Store or echoed back (Req 11.6);
  // responses expose a `secretPresent` boolean only (Req 11.2).
  const parseMemoryRoleParam = (raw: string): MemoryRole | undefined => {
    const parsed = MemoryRoleSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  };

  const requestUserId = (req: express.Request): string | undefined =>
    authConfig.enabled ? req.rectorAuth?.userId : undefined;

  const exactAssignmentFor = (
    assignments: MemoryRoleAssignment[],
    input: { role: MemoryRole; userId?: string; workspaceId?: string },
  ): MemoryRoleAssignment | undefined =>
    assignments.find(
      (assignment) =>
        assignment.role === input.role &&
        assignment.userId === input.userId &&
        assignment.workspaceId === input.workspaceId,
    );

  const ensureMemoryProviderRefExists = async (
    stores: UserStores,
    providerRecordId: string | undefined,
  ): Promise<string | undefined> => {
    if (providerRecordId === undefined || providerRecordId === "local" || providerRecordId === "disabled") {
      return undefined;
    }
    const state = await stores.memoryConfigStore.getState();
    return state.providers.some((provider) => provider.id === providerRecordId)
      ? undefined
      : `Memory provider "${providerRecordId}" is not configured.`;
  };

  const providerOptionsForAssignments = async (stores: UserStores): Promise<Array<Record<string, unknown>>> => {
    const state = await stores.memoryConfigStore.getState();
    return [
      {
        id: "local",
        kind: "local-inmemory",
        label: "Local default",
        capabilities: memoryProviderCapabilitiesForKind("local-inmemory"),
        builtIn: true,
      },
      {
        id: "disabled",
        kind: "disabled",
        label: "Disabled",
        capabilities: memoryProviderCapabilitiesForKind("disabled"),
        builtIn: true,
      },
      ...state.providers.map((provider) => ({
        id: provider.id,
        kind: provider.kind,
        label: provider.label,
        config: provider.config,
        capabilities: memoryProviderCapabilitiesForKind(provider.kind),
        builtIn: false,
      })),
    ];
  };

  const memoryAssignmentsPayload = async (req: express.Request) => {
    const userStores = storesFor(req);
    const assignments = await userStores.memoryAssignmentStore.listAssignments();
    return {
      roles: Object.values(MEMORY_ROLE_DEFINITIONS),
      assignments,
      providers: await providerOptionsForAssignments(userStores),
    };
  };

  const effectiveMemoryAssignmentsPayload = async (req: express.Request, workspaceId?: string) => ({
    roles: Object.values(MEMORY_ROLE_DEFINITIONS),
    effective: await Promise.all(
      MEMORY_ROLES.map(async (role) =>
        memoryRoleResolutionToJson(await resolveEffectiveMemoryProviderFor(req, role, workspaceId)),
      ),
    ),
  });

  // --- Memory_Assignment_API (Chunk 044): role -> provider wiring, no secrets. ---

  app.get("/api/memory-roles", (_req, res) => {
    sendRedacted(res, 200, { roles: Object.values(MEMORY_ROLE_DEFINITIONS) });
  });

  app.get("/api/memory-assignments", async (req, res) => {
    try {
      sendRedacted(res, 200, await memoryAssignmentsPayload(req));
    } catch (error) {
      sendRedacted(res, 500, { error: redactString(errorMessageOf(error)) });
    }
  });

  app.get("/api/memory-assignments/effective", async (req, res) => {
    try {
      const workspaceId = typeof req.query.workspaceId === "string" ? req.query.workspaceId : undefined;
      sendRedacted(res, 200, await effectiveMemoryAssignmentsPayload(req, workspaceId));
    } catch (error) {
      sendRedacted(res, 500, { error: redactString(errorMessageOf(error)) });
    }
  });

  app.put("/api/memory-assignments/:role", async (req, res) => {
    const role = parseMemoryRoleParam(req.params.role);
    if (!role) return sendRedacted(res, 404, { error: "Unknown memory role" });

    let body: UpsertMemoryAssignmentRequest;
    try {
      body = UpsertMemoryAssignmentRequestSchema.parse(req.body ?? {});
    } catch (err: unknown) {
      return res.status(400).json({ error: redactString(requestValidationMessage(err)) });
    }

    try {
      const userStores = storesFor(req);
      const providerError = await ensureMemoryProviderRefExists(userStores, body.providerRecordId);
      if (providerError) return sendRedacted(res, 400, { error: providerError });
      const fallbackError = await ensureMemoryProviderRefExists(userStores, body.fallbackProviderRecordId);
      if (fallbackError) return sendRedacted(res, 400, { error: fallbackError });

      const userId = requestUserId(req);
      const assignments = await userStores.memoryAssignmentStore.listAssignments();
      const existing = exactAssignmentFor(assignments, { role, userId, workspaceId: body.workspaceId });
      const now = new Date().toISOString();
      const assignment = createMemoryRoleAssignment({
        role,
        providerRecordId: body.providerRecordId,
        userId,
        workspaceId: body.workspaceId,
        enabled: body.enabled,
        readPriority: body.readPriority,
        writePriority: body.writePriority,
        fallbackProviderRecordId: body.fallbackProviderRecordId,
        retentionPolicy: body.retentionPolicy,
        maxEntries: body.maxEntries,
        maxUsdPerDay: body.maxUsdPerDay,
        existing,
        now,
      });

      const result = await userStores.memoryAssignmentStore.upsertAssignment(assignment);
      if (!result.ok) return sendRedacted(res, 500, { error: redactString(result.error) });
      clearMemoryRoutingCaches();

      sendRedacted(res, 200, {
        assignment: result.value,
        effective: memoryRoleResolutionToJson(await resolveEffectiveMemoryProviderFor(req, role, body.workspaceId)),
      });
    } catch (error) {
      sendRedacted(res, 500, { error: redactString(errorMessageOf(error)) });
    }
  });

  app.post("/api/memory-assignments/:role/test", async (req, res) => {
    const role = parseMemoryRoleParam(req.params.role);
    if (!role) return sendRedacted(res, 404, { error: "Unknown memory role" });

    try {
      const workspaceId = typeof req.body?.workspaceId === "string" ? req.body.workspaceId : undefined;
      const effective = await resolveEffectiveMemoryProviderFor(req, role, workspaceId);
      if (effective.status === "disabled" || !effective.provider) {
        return sendRedacted(res, 200, {
          ok: effective.status === "disabled",
          role,
          providerId: effective.providerRecordId,
          code: effective.status === "disabled" ? undefined : "CONFIG_INVALID",
          error: effective.error,
          networkAttempted: false,
          effective: memoryRoleResolutionToJson(effective),
        });
      }

      const result = runMemoryProviderConnectionTest({
        providerId: effective.provider.id,
        provider: effective.provider,
        kind: effective.provider.kind,
      });
      sendRedacted(res, 200, { role, ...result, effective: memoryRoleResolutionToJson(effective) });
    } catch (error) {
      sendRedacted(res, 500, { error: redactString(errorMessageOf(error)) });
    }
  });

  app.post("/api/memory-assignments/reset", async (req, res) => {
    let body: MemoryAssignmentResetRequest;
    try {
      body = MemoryAssignmentResetRequestSchema.parse(req.body ?? {});
    } catch (err: unknown) {
      return res.status(400).json({ error: redactString(requestValidationMessage(err)) });
    }

    try {
      const userStores = storesFor(req);
      const result = await userStores.memoryAssignmentStore.resetAssignments(
        body?.workspaceId ? { workspaceId: body.workspaceId } : undefined,
      );
      if (!result.ok) return sendRedacted(res, 500, { error: redactString(result.error) });
      clearMemoryRoutingCaches();
      sendRedacted(res, 200, await memoryAssignmentsPayload(req));
    } catch (error) {
      sendRedacted(res, 500, { error: redactString(errorMessageOf(error)) });
    }
  });

  app.post("/api/memory-assignments/:role/migrate/plan", async (req, res) => {
    const role = parseMemoryRoleParam(req.params.role);
    if (!role) return sendRedacted(res, 404, { error: "Unknown memory role" });

    let body: MemoryAssignmentMigrationPlanRequest;
    try {
      body = MemoryAssignmentMigrationPlanRequestSchema.parse(req.body ?? {});
    } catch (err: unknown) {
      return res.status(400).json({ error: redactString(requestValidationMessage(err)) });
    }

    try {
      const userStores = storesFor(req);
      const targetProviderRecordId = body?.targetProviderRecordId;
      const providerError = await ensureMemoryProviderRefExists(userStores, targetProviderRecordId);
      if (providerError) return sendRedacted(res, 400, { error: providerError });

      const workspaceId = body?.workspaceId;
      const effective = await resolveEffectiveMemoryProviderFor(req, role, workspaceId);
      const target = targetProviderRecordId ?? effective.providerRecordId;
      const targetCapabilities = target === "local" || target === "disabled"
        ? memoryProviderCapabilitiesForKind(target)
        : memoryProviderCapabilitiesForKind(
            (await userStores.memoryConfigStore.getState()).providers.find((provider) => provider.id === target)?.kind,
          );
      sendRedacted(res, 200, {
        role,
        destructive: false,
        sourceProviderRecordId: effective.providerRecordId,
        targetProviderRecordId: target,
        estimatedEntries: "unknown",
        steps: [
          "Read current role assignment and provider readiness.",
          "Estimate entries for this role when a store exposes counts.",
          "Copy to the target provider in a later migration chunk.",
          "Verify copied entries before any future cutover.",
        ],
        warnings: [
          ...effective.warnings,
          ...memoryCapabilityWarningsForRole({ role, capabilities: targetCapabilities, providerRecordId: target }),
        ],
        automaticExecution: false,
      });
    } catch (error) {
      sendRedacted(res, 500, { error: redactString(errorMessageOf(error)) });
    }
  });

  const restoreTemplateSafeFields = (redacted: unknown, original: unknown): unknown => {
    if (Array.isArray(redacted) && Array.isArray(original)) {
      return redacted.map((item, index) => restoreTemplateSafeFields(item, original[index]));
    }
    if (
      redacted &&
      original &&
      typeof redacted === "object" &&
      typeof original === "object" &&
      !Array.isArray(redacted) &&
      !Array.isArray(original)
    ) {
      const out: Record<string, unknown> = { ...(redacted as Record<string, unknown>) };
      for (const [key, originalValue] of Object.entries(original as Record<string, unknown>)) {
        if (key === "missingSecrets") {
          out[key] = originalValue;
        } else if (key in out) {
          out[key] = restoreTemplateSafeFields(out[key], originalValue);
        }
      }
      return out;
    }
    return redacted;
  };

  const sendTemplateResponse = (res: express.Response, status: number, payload: unknown): void => {
    sendRedactedPreservingPresence(res, status, payload, (redacted) => restoreTemplateSafeFields(redacted, payload));
  };

  const templateServiceFor = (req: express.Request): TemplateService => {
    const userStores = storesFor(req);
    return new TemplateService({
      orchestrationAssignmentStore: userStores.orchestrationAssignmentStore,
      memoryAssignmentStore: userStores.memoryAssignmentStore,
      providerConfigStore: userStores.providerConfigStore,
      memoryConfigStore: userStores.memoryConfigStore,
      secretStore: userStores.secretStore,
      moduleConfigStore,
      userTemplateStore,
    });
  };

  const scopeIdFor = (req: express.Request): string => req.rectorAuth?.userId ?? "default";

  // GET /api/providers — non-secret records + activeRoutes + per-provider secretPresent (Req 10.4).
  app.get("/api/providers", async (req, res) => {
    try {
      const userStores = storesFor(req);
      const state = await userStores.providerConfigStore.getState();
      const providers = await Promise.all(
        state.providers.map(async (record) => ({
          ...record,
          // Presence-only boolean from the Secret_Store; the value is never read here (Req 11.2).
          secretPresent: await userStores.secretStore.hasSecret(record.secretRef),
        }))
      );
      // The `secretPresent` booleans are clobbered to `[REDACTED]` by the
      // sensitive-key rule; re-apply them by record id after redaction so the
      // response exposes real booleans (Req 11.2) while every other field stays
      // redacted.
      const presenceById = new Map(providers.map((p) => [p.id, p.secretPresent]));
      sendRedactedPreservingPresence(res, 200, { providers, activeRoutes: state.activeRoutes }, (redacted) => {
        for (const provider of redacted.providers ?? []) {
          provider.secretPresent = presenceById.get(provider.id) ?? false;
        }
        return redacted;
      });
    } catch (error) {
      sendRedacted(res, 500, { error: redactString(errorMessageOf(error)) });
    }
  });

  // POST /api/providers — upsert a non-secret record; optional `apiKey` is persisted to the
  // Secret_Store then STRIPPED from the stored config (Req 10.5, 11.6). Write-once UX: when no
  // `apiKey` is supplied any existing secret is retained unchanged (Req 11.3). If persisting the
  // secret fails, the prior secret is left intact and the config is NOT upserted (Req 11.7).
  app.post("/api/providers", async (req, res) => {
    let body: UpsertProviderRequest;
    try {
      body = UpsertProviderRequestSchema.parse(req.body ?? {});
    } catch (err: unknown) {
      return res.status(400).json({ error: redactString(requestValidationMessage(err)) });
    }

    try {
      const userStores = storesFor(req);
      const state = await userStores.providerConfigStore.getState();
      const existing = state.providers.find((record) => record.id === body.id);
      const now = new Date().toISOString();
      // `secretRef` is derived from the record id; the Secret_Store is keyed by it. The apiKey is
      // destructured out so it can NEVER reach the non-secret config record (Req 11.6).
      const { apiKey, ...config } = body;
      const secretRef = body.id;

      // Persist a newly supplied secret BEFORE the config upsert so a secret failure leaves both
      // the prior secret and the prior config untouched (Req 11.7).
      if (apiKey !== undefined) {
        const secretAccess = await authorize(req, res, "providers.secrets.write", { targetType: "provider", targetId: body.id });
        if (!secretAccess) return;
        const secretResult = await userStores.secretStore.setSecret(secretRef, apiKey);
        if (!secretResult.ok) {
          return sendRedacted(res, 500, { error: redactString(secretResult.error) });
        }
      }

      // Parse through the canonical record schema so only a well-formed, non-secret record is
      // persisted; `createdAt` is preserved across updates and `updatedAt` is stamped now.
      const record: ProviderConfigRecord = ProviderConfigRecordSchema.parse({
        ...config,
        secretRef,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });

      const upsertResult = await userStores.providerConfigStore.upsertProvider(record);
      if (!upsertResult.ok) {
        return sendRedacted(res, 500, { error: redactString(upsertResult.error) });
      }

      if (apiKey !== undefined) {
        await auditRequest(req, { workspaceId: req.rectorWorkspace?.workspaceId, action: "provider.secret.write", targetType: "provider", targetId: record.id, outcome: "success" });
      }
      await auditRequest(req, { workspaceId: req.rectorWorkspace?.workspaceId, action: "provider.configure", targetType: "provider", targetId: record.id, outcome: "success" });
      const secretPresent = await userStores.secretStore.hasSecret(secretRef);
      // Re-apply the presence boolean after redaction (the sensitive-key rule
      // would otherwise replace it with `[REDACTED]`), so the response exposes a
      // real boolean (Req 11.2) while the record's other fields stay redacted.
      sendRedactedPreservingPresence(res, 200, { provider: { ...upsertResult.value, secretPresent } }, (redacted) => {
        if (redacted.provider) redacted.provider.secretPresent = secretPresent;
        return redacted;
      });
    } catch (error) {
      sendRedacted(res, 500, { error: redactString(errorMessageOf(error)) });
    }
  });

  // POST /api/providers/active — designate (or clear) the provider serving a model role (Req 14.2).
  // Registered BEFORE the `:id` routes; its single static segment never collides with `:id/secret`.
  app.post("/api/providers/active", async (req, res) => {
    let body: SetActiveRouteRequest;
    try {
      body = SetActiveRouteRequestSchema.parse(req.body ?? {});
    } catch (err: unknown) {
      return res.status(400).json({ error: redactString(requestValidationMessage(err)) });
    }

    try {
      const userStores = storesFor(req);
      const result = await userStores.providerConfigStore.setActiveRoute(body.role, body.providerId);
      if (!result.ok) {
        return sendRedacted(res, 500, { error: redactString(result.error) });
      }
      const state = await userStores.providerConfigStore.getState();
      await auditRequest(req, { workspaceId: req.rectorWorkspace?.workspaceId, action: "provider.route.assign", targetType: "provider", targetId: body.providerId ?? body.role, outcome: "success" });
      sendRedacted(res, 200, { activeRoutes: state.activeRoutes });
    } catch (error) {
      sendRedacted(res, 500, { error: redactString(errorMessageOf(error)) });
    }
  });

  // POST /api/providers/:id/secret — write/replace only the secret for an existing record. The
  // value is persisted ONLY through the Secret_Store; on failure the prior secret is left intact
  // and a redacted error is returned (Req 11.6, 11.7).
  app.post("/api/providers/:id/secret", async (req, res) => {
    let body: SetProviderSecretRequest;
    try {
      body = SetProviderSecretRequestSchema.parse(req.body ?? {});
    } catch (err: unknown) {
      return res.status(400).json({ error: redactString(requestValidationMessage(err)) });
    }

    try {
      const userStores = storesFor(req);
      const state = await userStores.providerConfigStore.getState();
      const existing = state.providers.find((record) => record.id === req.params.id);
      if (!existing) return res.status(404).json({ error: "Provider not found" });

      const result = await userStores.secretStore.setSecret(existing.secretRef, body.apiKey);
      if (!result.ok) {
        return sendRedacted(res, 500, { error: redactString(result.error) });
      }
      await auditRequest(req, { workspaceId: req.rectorWorkspace?.workspaceId, action: "provider.secret.write", targetType: "provider", targetId: existing.id, outcome: "success" });
      sendRedactedPreservingPresence(res, 200, { id: existing.id, secretPresent: true }, (redacted) => {
        redacted.secretPresent = true;
        return redacted;
      });
    } catch (error) {
      sendRedacted(res, 500, { error: redactString(errorMessageOf(error)) });
    }
  });

  // DELETE /api/providers/:id — remove the record AND its stored secret (Req 10.6). The record is
  // removed first; the secret is then deleted via the Secret_Store's optional `deleteSecret` (the
  // shipped local backing implements it). A secret-deletion failure surfaces a redacted error.
  app.delete("/api/providers/:id", async (req, res) => {
    try {
      const userStores = storesFor(req);
      const state = await userStores.providerConfigStore.getState();
      const existing = state.providers.find((record) => record.id === req.params.id);
      if (!existing) return res.status(404).json({ error: "Provider not found" });

      const removeResult = await userStores.providerConfigStore.removeProvider(existing.id);
      if (!removeResult.ok) {
        return sendRedacted(res, 500, { error: redactString(removeResult.error) });
      }

      if (userStores.secretStore.deleteSecret) {
        const secretResult = await userStores.secretStore.deleteSecret(existing.secretRef);
        if (!secretResult.ok) {
          return sendRedacted(res, 500, { error: redactString(secretResult.error) });
        }
      }

      await auditRequest(req, { workspaceId: req.rectorWorkspace?.workspaceId, action: "provider.delete", targetType: "provider", targetId: existing.id, outcome: "success" });
      sendRedacted(res, 200, { removed: true, id: existing.id });
    } catch (error) {
      sendRedacted(res, 500, { error: redactString(errorMessageOf(error)) });
    }
  });

  app.use("/api/modules", async (req, res, next) => {
    const permission: Permission = req.method === "GET" ? "workspace.read" : "modules.configure";
    const access = await authorize(req, res, permission, { targetType: "module" });
    if (!access) return;
    next();
  });

  const ModuleToggleSchema = z.object({
    moduleId: z.string().min(1),
    enabled: z.boolean(),
  });

  // GET /api/modules — list builtin modules and enabled state (Chunk 041).
  app.get("/api/modules", async (_req, res) => {
    try {
      const modules = moduleRegistry.list().map((manifest) => ({
        id: manifest.id,
        name: manifest.name,
        description: manifest.description,
        tier: manifest.tier,
        hooks: manifest.hooks,
        externalModeOnly: manifest.externalModeOnly,
        enabled: moduleRegistry.isEnabled(manifest.id),
      }));
      sendRedacted(res, 200, { modules });
    } catch (error) {
      sendRedacted(res, 500, { error: redactString(errorMessageOf(error)) });
    }
  });

  // POST /api/modules — enable or disable a module (Chunk 041).
  app.post("/api/modules", async (req, res) => {
    try {
      const body = ModuleToggleSchema.parse(req.body ?? {});
      if (!moduleRegistry.list().some((manifest) => manifest.id === body.moduleId)) {
        return sendRedacted(res, 404, { error: "Module not found" });
      }

      if (body.enabled) {
        moduleRegistry.enable(body.moduleId);
      } else {
        try {
          moduleRegistry.disable(body.moduleId);
        } catch (error) {
          return sendRedacted(res, 400, {
            error: redactString(error instanceof Error ? error.message : String(error)),
          });
        }
      }

      const persisted = await moduleConfigStore.setModuleEnabled(body.moduleId, body.enabled);
      if (!persisted.ok) {
        return sendRedacted(res, 500, { error: redactString(persisted.error) });
      }

      await auditRequest(req, { workspaceId: req.rectorWorkspace?.workspaceId, action: "module.configure", targetType: "module", targetId: body.moduleId, outcome: "success" });
      sendRedacted(res, 200, {
        moduleId: body.moduleId,
        enabled: body.enabled,
        disabledModuleIds: persisted.value.disabledModuleIds,
        enabledModuleIds: persisted.value.enabledModuleIds,
      });
    } catch (error) {
      sendRedacted(res, 400, { error: redactString(errorMessageOf(error)) });
    }
  });

  // --- Template_API (Chunk 045): built-in presets, import/export, preview/apply ---
  app.get("/api/templates", async (req, res) => {
    try {
      const templates = await templateServiceFor(req).listTemplates(scopeIdFor(req));
      sendTemplateResponse(res, 200, { templates });
    } catch (error) {
      sendRedacted(res, 500, { error: redactString(errorMessageOf(error)) });
    }
  });

  app.get("/api/templates/export/current", async (req, res) => {
    try {
      const template = await templateServiceFor(req).exportCurrentConfig({ scopeId: scopeIdFor(req) });
      sendTemplateResponse(res, 200, { template });
    } catch (error) {
      sendRedacted(res, 500, { error: redactString(errorMessageOf(error)) });
    }
  });

  app.post("/api/templates/save-current", async (req, res) => {
    try {
      const body = TemplateSaveCurrentRequestSchema.parse(req.body ?? {});
      const template = await templateServiceFor(req).saveCurrentConfig({ ...body, scopeId: scopeIdFor(req) });
      sendTemplateResponse(res, 200, { template });
    } catch (error) {
      sendRedacted(res, 400, { error: redactString(errorMessageOf(error)) });
    }
  });

  app.post("/api/templates/import/preview", async (req, res) => {
    try {
      const service = templateServiceFor(req);
      const template = service.importTemplate(req.body ?? {});
      const preview: TemplatePreview = await service.preview(template, undefined, scopeIdFor(req));
      sendTemplateResponse(res, 200, { template, preview });
    } catch (error) {
      if (error instanceof TemplateImportSecretError) {
        return sendTemplateResponse(res, 400, { error: error.message, findings: error.findings });
      }
      sendRedacted(res, 400, { error: redactString(errorMessageOf(error)) });
    }
  });

  app.post("/api/templates/import/apply", async (req, res) => {
    try {
      const service = templateServiceFor(req);
      const template = service.importTemplate(req.body ?? {});
      const rawBody = req.body && typeof req.body === "object" ? { ...(req.body as Record<string, unknown>) } : {};
      delete rawBody.template;
      const body = TemplateApplyRequestSchema.parse(rawBody);
      const result = await service.apply(template, { ...body, scopeId: scopeIdFor(req) });
      sendTemplateResponse(res, 200, result);
    } catch (error) {
      if (error instanceof TemplateImportSecretError) {
        return sendTemplateResponse(res, 400, { error: error.message, findings: error.findings });
      }
      sendRedacted(res, 400, { error: redactString(errorMessageOf(error)) });
    }
  });

  app.get("/api/templates/:id", async (req, res) => {
    try {
      const template = await templateServiceFor(req).getTemplate(req.params.id, scopeIdFor(req));
      if (!template) return sendRedacted(res, 404, { error: "Template not found" });
      sendTemplateResponse(res, 200, { template });
    } catch (error) {
      sendRedacted(res, 500, { error: redactString(errorMessageOf(error)) });
    }
  });

  app.post("/api/templates/:id/preview", async (req, res) => {
    try {
      const preview = await templateServiceFor(req).preview(req.params.id, undefined, scopeIdFor(req));
      sendTemplateResponse(res, 200, { preview });
    } catch (error) {
      const status = errorMessageOf(error).startsWith("Template not found") ? 404 : 400;
      sendRedacted(res, status, { error: redactString(errorMessageOf(error)) });
    }
  });

  app.post("/api/templates/:id/apply", async (req, res) => {
    try {
      const body = TemplateApplyRequestSchema.parse(req.body ?? {});
      const result = await templateServiceFor(req).apply(req.params.id, { ...body, scopeId: scopeIdFor(req) });
      sendTemplateResponse(res, 200, result);
    } catch (error) {
      const status = errorMessageOf(error).startsWith("Template not found") ? 404 : 400;
      sendRedacted(res, status, { error: redactString(errorMessageOf(error)) });
    }
  });

  app.use("/api/memory-providers", async (req, res, next) => {
    let permission: Permission = "providers.read";
    if (req.method === "POST" && req.path.endsWith("/secret")) permission = "providers.secrets.write";
    else if (req.method === "POST" || req.method === "DELETE") permission = "memory.configure";
    const access = await authorize(req, res, permission, { targetType: "memory-provider" });
    if (!access) return;
    next();
  });

  // --- Memory_Provider_API: CRUD + selection (Chunk 36, mirrors Provider_Config_API) ---
  //
  // Every response is routed through `sendRedacted`/`redactOutbound` so no full or partial secret
  // value can appear in any response. Secrets are accepted on input, persisted ONLY via the
  // Secret_Store under `memory:${id}` refs, and never written to the Memory_Config_Store or
  // echoed back; responses expose a `secretPresent` boolean only.

  // GET /api/memory-providers — non-secret records + activeMemoryProviderId + secretPresent booleans.
  app.get("/api/memory-providers", async (req, res) => {
    try {
      const userStores = storesFor(req);
      const state = await userStores.memoryConfigStore.getState();
      const providers = await Promise.all(
        state.providers.map(async (record) => ({
          ...record,
          secretPresent: await userStores.secretStore.hasSecret(record.secretRef),
        })),
      );
      const presenceById = new Map(providers.map((p) => [p.id, p.secretPresent]));
      sendRedactedPreservingPresence(
        res,
        200,
        { providers, activeMemoryProviderId: state.activeMemoryProviderId },
        (redacted) => {
          for (const provider of redacted.providers ?? []) {
            provider.secretPresent = presenceById.get(provider.id) ?? false;
          }
          return redacted;
        },
      );
    } catch (error) {
      sendRedacted(res, 500, { error: redactString(errorMessageOf(error)) });
    }
  });

  // POST /api/memory-providers — upsert a non-secret record; optional `apiKey` to Secret_Store first.
  app.post("/api/memory-providers", async (req, res) => {
    let body: UpsertMemoryProviderRequest;
    try {
      body = UpsertMemoryProviderRequestSchema.parse(req.body ?? {});
    } catch (err: unknown) {
      return res.status(400).json({ error: redactString(requestValidationMessage(err)) });
    }

    try {
      const userStores = storesFor(req);
      const state = await userStores.memoryConfigStore.getState();
      const existing = state.providers.find((record) => record.id === body.id);
      const now = new Date().toISOString();
      const { apiKey, ...config } = body;
      const secretRef = `memory:${body.id}`;

      if (apiKey !== undefined) {
        const secretAccess = await authorize(req, res, "providers.secrets.write", { targetType: "memory-provider", targetId: body.id });
        if (!secretAccess) return;
        const secretResult = await userStores.secretStore.setSecret(secretRef, apiKey);
        if (!secretResult.ok) {
          return sendRedacted(res, 500, { error: redactString(secretResult.error) });
        }
      }

      const record: MemoryProviderRecord = MemoryProviderRecordSchema.parse({
        ...config,
        secretRef,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });

      const upsertResult = await userStores.memoryConfigStore.upsertMemoryProvider(record);
      if (!upsertResult.ok) {
        return sendRedacted(res, 500, { error: redactString(upsertResult.error) });
      }

      clearMemoryRoutingCaches();
      if (apiKey !== undefined) {
        await auditRequest(req, { workspaceId: req.rectorWorkspace?.workspaceId, action: "memory.secret.write", targetType: "memory-provider", targetId: record.id, outcome: "success" });
      }
      await auditRequest(req, { workspaceId: req.rectorWorkspace?.workspaceId, action: "memory.configure", targetType: "memory-provider", targetId: record.id, outcome: "success" });
      const secretPresent = await userStores.secretStore.hasSecret(secretRef);
      sendRedactedPreservingPresence(
        res,
        200,
        { provider: { ...upsertResult.value, secretPresent } },
        (redacted) => {
          if (redacted.provider) redacted.provider.secretPresent = secretPresent;
          return redacted;
        },
      );
    } catch (error) {
      sendRedacted(res, 500, { error: redactString(errorMessageOf(error)) });
    }
  });

  // POST /api/memory-providers/active — designate (or clear) the active memory provider.
  app.post("/api/memory-providers/active", async (req, res) => {
    let body: SetActiveMemoryProviderRequest;
    try {
      body = SetActiveMemoryProviderRequestSchema.parse(req.body ?? {});
    } catch (err: unknown) {
      return res.status(400).json({ error: redactString(requestValidationMessage(err)) });
    }

    try {
      const userStores = storesFor(req);
      const result = await userStores.memoryConfigStore.setActiveMemoryProvider(body.providerId);
      if (!result.ok) {
        return sendRedacted(res, 500, { error: redactString(result.error) });
      }
      clearMemoryRoutingCaches();
      const state = await userStores.memoryConfigStore.getState();
      await auditRequest(req, { workspaceId: req.rectorWorkspace?.workspaceId, action: "memory.assignment.update", targetType: "memory-provider", targetId: body.providerId ?? "local-inmemory", outcome: "success" });
      sendRedacted(res, 200, { activeMemoryProviderId: state.activeMemoryProviderId });
    } catch (error) {
      sendRedacted(res, 500, { error: redactString(errorMessageOf(error)) });
    }
  });

  // POST /api/memory-providers/:id/secret — write/replace only the secret for an existing record.
  app.post("/api/memory-providers/:id/secret", async (req, res) => {
    let body: SetMemoryProviderSecretRequest;
    try {
      body = SetMemoryProviderSecretRequestSchema.parse(req.body ?? {});
    } catch (err: unknown) {
      return res.status(400).json({ error: redactString(requestValidationMessage(err)) });
    }

    try {
      const userStores = storesFor(req);
      const state = await userStores.memoryConfigStore.getState();
      const existing = state.providers.find((record) => record.id === req.params.id);
      if (!existing) return sendRedacted(res, 404, { error: "Memory provider not found" });

      const result = await userStores.secretStore.setSecret(existing.secretRef, body.apiKey);
      if (!result.ok) {
        return sendRedacted(res, 500, { error: redactString(result.error) });
      }
      clearMemoryRoutingCaches();
      await auditRequest(req, { workspaceId: req.rectorWorkspace?.workspaceId, action: "memory.secret.write", targetType: "memory-provider", targetId: existing.id, outcome: "success" });
      sendRedactedPreservingPresence(res, 200, { id: existing.id, secretPresent: true }, (redacted) => {
        redacted.secretPresent = true;
        return redacted;
      });
    } catch (error) {
      sendRedacted(res, 500, { error: redactString(errorMessageOf(error)) });
    }
  });

  // DELETE /api/memory-providers/:id — remove the record AND its stored secret.
  app.delete("/api/memory-providers/:id", async (req, res) => {
    try {
      const userStores = storesFor(req);
      const state = await userStores.memoryConfigStore.getState();
      const existing = state.providers.find((record) => record.id === req.params.id);
      if (!existing) return sendRedacted(res, 404, { error: "Memory provider not found" });

      const removeResult = await userStores.memoryConfigStore.removeMemoryProvider(existing.id);
      if (!removeResult.ok) {
        return sendRedacted(res, 500, { error: redactString(removeResult.error) });
      }

      if (userStores.secretStore.deleteSecret) {
        const secretResult = await userStores.secretStore.deleteSecret(existing.secretRef);
        if (!secretResult.ok) {
          return sendRedacted(res, 500, { error: redactString(secretResult.error) });
        }
      }

      clearMemoryRoutingCaches();
      await auditRequest(req, { workspaceId: req.rectorWorkspace?.workspaceId, action: "memory.delete", targetType: "memory-provider", targetId: existing.id, outcome: "success" });
      sendRedacted(res, 200, { removed: true, id: existing.id });
    } catch (error) {
      sendRedacted(res, 500, { error: redactString(errorMessageOf(error)) });
    }
  });

  // POST /api/memory-providers/:id/test-connection — validateConfig on a built provider.
  app.post("/api/memory-providers/:id/test-connection", async (req, res) => {
    const providerId = req.params.id;

    try {
      const userStores = storesFor(req);
      const state = await userStores.memoryConfigStore.getState();
      const record = state.providers.find((candidate) => candidate.id === providerId);
      if (!record) {
        return sendRedacted(res, 404, { error: "Memory provider not found" });
      }

      let provider: MemoryProvider;
      try {
        const resolved = await resolveMemoryProviderForTest(
          providerId,
          userStores.memoryConfigStore,
          userStores.secretStore,
        );
        if (!resolved) {
          return sendRedacted(res, 404, { error: "Memory provider not found" });
        }
        provider = resolved;
      } catch (error) {
        const result = TestMemoryProviderConnectionResponseSchema.parse({
          ok: false,
          providerId,
          kind: record.kind,
          code: "CONFIG_INVALID",
          error: redactString(errorMessageOf(error)),
          networkAttempted: false,
        });
        return sendRedacted(res, 200, result);
      }

      const result = runMemoryProviderConnectionTest({
        providerId,
        provider,
        kind: record.kind,
      });
      sendRedacted(res, 200, result);
    } catch (error) {
      sendRedacted(res, 500, { error: redactString(errorMessageOf(error)) });
    }
  });

  // --- Discovery_API: read + refresh discovered models (design section C, Req 17) ---
  //
  // A single Model_Discovery_Service instance is constructed once so its Discovery_Cache persists
  // across requests: a `GET` serves a still-fresh cached result and a `POST .../refresh` bypasses
  // and overwrites exactly the entry the next `GET` will read (Req 16.2, 17.2). It is wired to the
  // same Provider_Config_Store and Secret_Store the BYOK routes use, plus the default per-kind
  // adapter registry; secrets are read transiently inside the service and never returned (Req 18).
  // A deterministic service can be injected via `securityOptions.modelDiscoveryService` for tests.
  const modelDiscoveryService =
    securityOptions.modelDiscoveryService ??
    createModelDiscoveryService({
      configStore: providerConfigStore,
      secrets: setupSecretStore,
      cache: createDiscoveryCache(),
      adapters: createDefaultDiscoveryAdapterRegistry(),
    });
  const discoveryServiceByUser = new Map<string, ModelDiscoveryService>();
  const discoveryServiceFor = (req: express.Request): ModelDiscoveryService => {
    if (securityOptions.modelDiscoveryService) return securityOptions.modelDiscoveryService;
    if (!authConfig.enabled) return modelDiscoveryService;
    const userId = req.rectorAuth?.userId ?? "default";
    const cached = discoveryServiceByUser.get(userId);
    if (cached) return cached;
    const userStores = storesFor(req);
    const service = createModelDiscoveryService({
      configStore: userStores.providerConfigStore,
      secrets: userStores.secretStore,
      cache: createDiscoveryCache(),
      adapters: createDefaultDiscoveryAdapterRegistry(),
    });
    discoveryServiceByUser.set(userId, service);
    return service;
  };

  // Map a DiscoveryResult to an HTTP status: a success is 200; an unknown provider id (resolved with
  // NO network call, Req 17.4) is 404; any other classified, redacted failure is 502 (an upstream
  // provider/transport failure). The full DiscoveryResult — already redacted by the service
  // (Req 18.1, 18.2) — is the response body in every case, routed through `sendRedacted` so the
  // outbound boundary is enforced uniformly.
  const sendDiscoveryResult = (res: express.Response, result: DiscoveryResult): void => {
    if (result.ok) {
      sendRedacted(res, 200, result);
      return;
    }
    const status = result.error.category === "not_found" ? 404 : 502;
    sendRedacted(res, status, result);
  };

  // GET /api/providers/:id/models — discover the Model_Candidates for a provider, returning
  // candidates + `lastRefreshedAt` (Req 17.1) or a classified, redacted error (Req 17.3). An id
  // with no Provider_Config_Record short-circuits to a redacted `not_found` result with NO network
  // call inside the service (Req 17.4). A cache hit within TTL is served without re-discovery.
  app.get("/api/providers/:id/models", async (req, res) => {
    try {
      const result = await discoveryServiceFor(req).discover(req.params.id, { fetchImpl: fetch });
      sendDiscoveryResult(res, result);
    } catch (error) {
      sendRedacted(res, 500, { error: redactString(errorMessageOf(error)) });
    }
  });

  // POST /api/providers/:id/models/refresh — bypass the Discovery_Cache, re-run discovery, and
  // overwrite the cache (Req 17.2). The same classification/redaction and `not_found` short-circuit
  // (Req 17.3, 17.4) apply. The distinct `/models/refresh` path never collides with the `:id/secret`
  // or `:id` routes above.
  app.post("/api/providers/:id/models/refresh", async (req, res) => {
    try {
      const result = await discoveryServiceFor(req).discover(req.params.id, {
        refresh: true,
        fetchImpl: fetch,
      });
      sendDiscoveryResult(res, result);
    } catch (error) {
      sendRedacted(res, 500, { error: redactString(errorMessageOf(error)) });
    }
  });

  // POST /api/config/providers/:id/discover — Settings_API model discovery for a configured
  // provider (cloud-capable-transition Req 4). This is the mode-gated, deadline-bounded discovery
  // surface the settings panel triggers, distinct from the ORN read/refresh routes above:
  //
  // - Local mode (Req 4.3, 4.7): returns a redacted "discovery unavailable in local mode"
  //   Discovery_Error WITHOUT invoking the Model_Discovery_Service or making any network call. The
  //   mode is resolved from the orchestration wiring (default `local`), so discovery is inert by
  //   default and only live once an operator selects external mode.
  // - External mode: invokes the service (Req 4.1), relays its candidates or its classified,
  //   redacted Discovery_Error — `not_found` for an unknown provider (Req 4.2), or any other
  //   category (Req 4.5) — without throwing, and races the call against a 30 000 ms deadline,
  //   returning a `timeout` Discovery_Error on expiry (Req 4.6).
  //
  // The full DiscoveryResult is sent through `sendRedacted`, so no secret value or authorization
  // header can escape in the response (Req 4.4). A refresh can be requested via `?refresh=1` or a
  // truthy `refresh` body field.
  app.post("/api/config/providers/:id/discover", async (req, res) => {
    const access = await authorize(req, res, "providers.configure", { targetType: "provider", targetId: req.params.id });
    if (!access) return;
    const mode = securityOptions.orchestration?.mode ?? "local";
    const body = (req.body ?? {}) as Record<string, unknown>;
    const refresh =
      body.refresh === true || req.query.refresh === "1" || req.query.refresh === "true";
    try {
      const result = await runSettingsDiscovery({
        mode,
        service: discoveryServiceFor(req),
        providerId: req.params.id,
        refresh,
        fetchImpl: fetch,
      });
      // Local-mode unavailability carries the generic `unknown` category; surface it as 503 so it
      // is distinguished from a genuine upstream `unknown` failure (502). All other results map by
      // category. The redacted DiscoveryResult is the body in every case.
      const status = mode !== "external" ? 503 : settingsDiscoveryStatus(result);
      sendRedacted(res, status, result);
    } catch (error) {
      sendRedacted(res, 500, { error: redactString(errorMessageOf(error)) });
    }
  });

  // --- Scenario seeding ---

  app.post("/api/dev/scenario", async (req, res) => {
    const access = await authorize(req, res, "operator.manage", { targetType: "dev" });
    if (!access) return;
    if (process.env.NODE_ENV === "production") {
      return res.status(404).json({ error: "Not found" });
    }
    try {
      const { type } = req.body ?? {};
      if (type === "happy") {
        const t = manager.createTask("Build a REST API for task management");
        res.status(201).json(t);
      } else if (type === "healing") {
        const t = manager.createTask("Refactor the broken retry logic to work correctly");
        res.status(201).json(t);
      } else {
        return res.status(400).json({ error: "type must be 'happy' or 'healing'" });
      }
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Manual trigger for proactive "alive" behavior (Chunk 28).
  app.post("/api/dev/proactive-trigger", async (req, res) => {
    const access = await authorize(req, res, "operator.manage", { targetType: "dev" });
    if (!access) return;
    try {
      const proactiveAgent = getNeuroAliveState().proactiveAgent;
      if (!proactiveAgent) {
        return res.status(400).json({ error: "Proactive agent not enabled (local mode or no router)" });
      }
      const { conversationId } = req.body ?? {};
      if (!conversationId) {
        return res.status(400).json({ error: "conversationId required" });
      }
      const result = await proactiveAgent.triggerCheckIn({ conversationId });
      res.json({ triggered: true, ...result });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // --- SPA fallback ---
  app.get("*", (_req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });

  // Manual trigger for proactive "alive" behavior (Chunk 28). Useful for demo and tests.
  // (Placed late so it doesn't interfere with earlier routes during registration.)
  // Note: duplicate safety - the real one is registered earlier; this is a no-op guard.
  if (false) {
    app.post("/api/dev/proactive-trigger", async (_req, res) => res.json({}));
  }

  return app;
}

function resolvePublicDir(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, "../public"),
    path.resolve(moduleDir, "../../src/public"),
    path.resolve(process.cwd(), "src/public"),
  ];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, "index.html"))) ?? candidates[0];
}

function securityHeadersMiddleware(_req: express.Request, res: express.Response, next: express.NextFunction): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
}

function corsMiddleware(options: ApiSecurityOptions): express.RequestHandler {
  const configuredOrigins = new Set([
    ...(options.corsAllowedOrigins ?? []),
    ...parseCsvEnv(process.env.CORS_ALLOWED_ORIGINS),
  ]);

  return (req, res, next) => {
    const origin = req.header("Origin");
    if (origin && (configuredOrigins.has(origin) || isDevLocalhostOrigin(origin))) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
      res.setHeader("Access-Control-Max-Age", "600");
    }

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}

function csrfProtectionMiddleware(authConfig: ParsedAuthConfig, options: ApiSecurityOptions): express.RequestHandler {
  const configuredOrigins = new Set([
    ...(options.corsAllowedOrigins ?? []),
    ...parseCsvEnv(process.env.CORS_ALLOWED_ORIGINS),
  ]);

  return (req, res, next) => {
    if (!authConfig.enabled) {
      next();
      return;
    }
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      next();
      return;
    }
    const origin = req.header("Origin");
    if (!origin) {
      next();
      return;
    }
    const host = req.header("Host");
    let allowed = configuredOrigins.has(origin) || isDevLocalhostOrigin(origin);
    if (!allowed && host) {
      try {
        const url = new URL(origin);
        allowed = url.host === host;
      } catch {
        allowed = false;
      }
    }
    if (!allowed) {
      res.status(403).json({ error: "CSRF origin denied" });
      return;
    }
    next();
  };
}

function apiRateLimitMiddleware(
  options: ApiSecurityOptions,
  authConfig: ParsedAuthConfig,
): express.RequestHandler {
  const policy = createRateLimitPolicy(options.rateLimit, process.env);
  const limiter = options.rateLimiter ?? new InMemoryRateLimiter(policy);

  return async (req, res, next) => {
    const route = classifyRateLimitRoute(req.method, req.path);
    if (!route) {
      next();
      return;
    }
    const key = rateLimitKeyForRequest(req, authConfig);
    const now = Date.now();

    try {
      const checked = await limiter.check(key, route, now);
      if (checked.disabled) {
        next();
        return;
      }
      if (!checked.allowed) {
        sendRateLimitDenied(res, checked, rateLimitErrorMessage(route));
        return;
      }

      const committed = await limiter.commit(key, route, now);
      if (committed.disabled) {
        next();
        return;
      }
      if (!committed.allowed) {
        sendRateLimitDenied(res, committed, rateLimitErrorMessage(route));
        return;
      }

      writeRateLimitHeaders(res, committed);
      next();
    } catch (error) {
      const rule = rateLimitRuleFor(policy, route);
      if (!rule.failClosed) {
        next();
        return;
      }
      sendRedacted(res, 503, {
        error: "Rate limiter unavailable",
        message: redactString(error instanceof Error ? error.message : String(error)),
      });
    }
  };
}

function classifyRateLimitRoute(method: string, requestPath: string): string | undefined {
  if (method === "POST" && requestPath.startsWith("/api/chat/")) return "chat";
  if (method === "POST" && requestPath === "/api/auth/login") return "auth-login";
  if (method === "POST" && requestPath === "/api/setup/test-connection") return "provider-test-connection";
  if (method === "POST" && /^\/api\/memory-providers\/[^/]+\/test-connection$/.test(requestPath)) {
    return "memory-provider-test";
  }
  return undefined;
}

function rateLimitKeyForRequest(req: express.Request, authConfig: ParsedAuthConfig): string {
  if (req.rectorAuth?.userId) return `user:${req.rectorAuth.userId}`;

  if (authConfig.enabled) {
    const cookies = parseCookieHeader(req.header("cookie"));
    const session = verifySessionToken(cookies[SESSION_COOKIE_NAME], authConfig.sessionSecret);
    if (session) return `user:${session.userId}`;
  }

  return `ip:${req.ip || req.socket.remoteAddress || "unknown"}`;
}

function parseCookieHeader(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1);
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

function sendRateLimitDenied(res: express.Response, decision: RateLimitDecision, message: string): void {
  writeRateLimitHeaders(res, decision);
  res.setHeader("Retry-After", String(Math.ceil(decision.retryAfterMs / 1000)));
  sendRedacted(res, 429, { error: message });
}

function writeRateLimitHeaders(res: express.Response, decision: RateLimitDecision): void {
  res.setHeader("X-RateLimit-Limit", String(decision.limit));
  res.setHeader("X-RateLimit-Remaining", String(Math.max(0, decision.remaining)));
  res.setHeader("X-RateLimit-Reset", String(Math.ceil(decision.resetAt / 1000)));
}

function rateLimitErrorMessage(route: string): string {
  switch (route) {
    case "chat":
      return "Too many chat requests";
    case "auth-login":
      return "Too many authentication requests";
    case "provider-test-connection":
      return "Too many provider test requests";
    case "memory-provider-test":
      return "Too many memory provider test requests";
    default:
      return "Too many requests";
  }
}

function parseCsvEnv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isDevLocalhostOrigin(origin: string): boolean {
  if (process.env.NODE_ENV === "production") return false;
  try {
    const url = new URL(origin);
    return ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

function nonEmptyOrDefault(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

type OperatorEnvelopePayload = Record<string, unknown>;

type OperatorArtifactHandle = {
  artifactId: string;
  kind?: string;
  uri?: string;
  summary?: string;
  hash?: string;
  sizeBytes?: number;
  piiState?: string;
  retentionPolicy?: string;
};

function operatorEnvelope(payload: OperatorEnvelopePayload): OperatorEnvelopePayload {
  return {
    localOnly: true,
    auth: "local-only-no-auth",
    surface: "retool-operator-console-api",
    ...payload,
  };
}

function summarizeOperatorRun(run: Run): Record<string, unknown> {
  return {
    id: run.id,
    conversationId: run.conversationId,
    userMessageId: run.userMessageId,
    status: run.status,
    phase: run.phase,
    route: run.route,
    complexity: run.complexity,
    traceId: run.traceId,
    attempts: run.attempts,
    healingAttempts: run.healingAttempts,
    validationAttempts: run.validationAttempts,
    lastError: run.lastError,
    dagId: run.dagId,
    estimatedUsd: numericField(run.costEstimate, "usd"),
    actualUsd: numericField(run.actualCost, "usd"),
    estimatedInputTokens: numericField(run.tokenEstimate, "input"),
    estimatedOutputTokens: numericField(run.tokenEstimate, "output"),
    actualInputTokens: numericField(run.actualTokens, "input"),
    actualOutputTokens: numericField(run.actualTokens, "output"),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function summarizeOperatorCosts(runs: Run[]): Record<string, unknown> {
  return runs.reduce(
    (summary, run) => ({
      runCount: summary.runCount + 1,
      estimatedUsd: summary.estimatedUsd + numericField(run.costEstimate, "usd"),
      actualUsd: summary.actualUsd + numericField(run.actualCost, "usd"),
      estimatedInputTokens: summary.estimatedInputTokens + numericField(run.tokenEstimate, "input"),
      estimatedOutputTokens: summary.estimatedOutputTokens + numericField(run.tokenEstimate, "output"),
      actualInputTokens: summary.actualInputTokens + numericField(run.actualTokens, "input"),
      actualOutputTokens: summary.actualOutputTokens + numericField(run.actualTokens, "output"),
      modelCalls: summary.modelCalls + numericField(run.actualCost, "modelCalls"),
    }),
    {
      runCount: 0,
      estimatedUsd: 0,
      actualUsd: 0,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      actualInputTokens: 0,
      actualOutputTokens: 0,
      modelCalls: 0,
    }
  );
}

function isOperatorFailureRun(run: Run): boolean {
  return run.status === "failed" || run.status === "aborted" || run.status === "needs_decision" || run.lastError !== undefined;
}

function isFailureEvent(event: RunEvent): boolean {
  return event.type === "RUN_FAILED" || event.type === "RUN_ABORTED" || event.type === "DECISION_REQUESTED";
}

function collectArtifactHandles(events: RunEvent[]): OperatorArtifactHandle[] {
  const handles = new Map<string, OperatorArtifactHandle>();
  for (const event of events) {
    collectArtifactHandlesFromValue(event.payload, handles);
  }
  return Array.from(handles.values());
}

function collectArtifactHandlesFromValue(value: unknown, handles: Map<string, OperatorArtifactHandle>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectArtifactHandlesFromValue(item, handles);
    return;
  }

  if (!isRecord(value)) return;

  if (typeof value.artifactId === "string") {
    handles.set(value.artifactId, {
      artifactId: value.artifactId,
      kind: stringField(value, "kind"),
      uri: stringField(value, "uri"),
      summary: stringField(value, "summary"),
      hash: stringField(value, "hash"),
      sizeBytes: numberField(value, "sizeBytes"),
      piiState: stringField(value, "piiState"),
      retentionPolicy: stringField(value, "retentionPolicy"),
    });
  }

  for (const nested of Object.values(value)) {
    collectArtifactHandlesFromValue(nested, handles);
  }
}

function artifactMetadataOnly(artifact: Artifact): Artifact {
  const { content: _content, ...metadata } = artifact.metadata;
  return {
    ...artifact,
    metadata,
  };
}

function stableStubIssueNumber(seed: string): string {
  const hash = crypto.createHash("sha256").update(seed).digest("hex");
  return String(Number.parseInt(hash.slice(0, 8), 16) % 1_000_000).padStart(6, "0");
}

function numericField(value: Record<string, unknown> | undefined, key: string): number {
  if (value === undefined) return 0;
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : 0;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
