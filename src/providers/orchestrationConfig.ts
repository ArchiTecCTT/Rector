import { redactString } from "../security/redaction";
import type { SecretStore } from "../security/secretStore";
import {
  ORCHESTRATOR_MODES,
  OrchestrationConfigError,
  type OrchestrationConfig,
  type OrchestratorMode,
} from "../deployment";
import {
  emptyProviderConfigState,
  type ProviderConfigRecord,
  type ProviderConfigState,
  type ProviderKind,
} from "./config";
import type { ProviderConfigStore } from "./configStore";

/**
 * Boot-tolerant orchestration config resolution (design section C1; Requirements
 * 1.1, 1.2, 1.3, 1.6, 1.8, 9.5).
 *
 * This module replaces the synchronous, env-only `parseOrchestrationConfig`
 * (retained in `../deployment` for pure-env callers/tests) on the **live boot
 * path** with an async, store-aware resolver. The architectural inversion is
 * deliberate: the legacy parser *throws* in external mode whenever no provider
 * validates from `process.env` alone (the startup catch-22), whereas
 * {@link resolveOrchestrationConfig} consults both the environment **and** the
 * initialized Provider_Config_Store + Secret_Store, never reads a secret
 * *value* (presence-only via {@link SecretStore.hasSecret}), and halts startup
 * for exactly one reason — an `ORCHESTRATOR_MODE` value that is neither `local`
 * nor `external` (case-sensitive).
 *
 * The configured-provider list is the **union** of:
 *  - every provider whose required env keys are all present and non-empty, and
 *  - every Provider_Config_Record whose required secret refs are all reported
 *    present by the Secret_Store.
 *
 * A store that cannot be read is treated as carrying **absent** credentials: a
 * redacted error is emitted and resolution continues (Requirement 1.8), so a
 * transient store fault never crashes startup.
 */

/** Reasons resolution may halt startup — the only hard-exit path here. */
export type ResolveOrchestrationLogger = {
  /** Emit a redacted, secret-free error line (defaults to `console.error`). */
  error(message: string): void;
};

/** Dependencies for {@link resolveOrchestrationConfig}. */
export interface ResolveOrchestrationDeps {
  /** Environment map carrying `ORCHESTRATOR_MODE` and provider env keys. */
  env: Record<string, string | undefined>;
  /** The non-secret Provider_Config_Store, awaited for stored records. */
  providerConfigStore: ProviderConfigStore;
  /** The encrypted Secret_Store, queried presence-only via `hasSecret`. */
  secretStore: SecretStore;
  /**
   * Optional sink for redacted store-read errors (Requirement 1.8). Defaults to
   * `console.error`. Every message routed here is passed through the
   * Redaction_Layer first, so no secret value can escape.
   */
  logger?: ResolveOrchestrationLogger;
}

/**
 * A per-kind provider descriptor (design section C1).
 *
 * Carries the required env-key NAMES (never values) used to decide env
 * satisfaction, and — given a record of this kind — the set of secret refs the
 * Secret_Store must report present for store satisfaction. Each supported kind
 * binds exactly one credential secret, so {@link requiredSecretRefs} resolves to
 * the record's single `secretRef`; the function shape keeps the table open to a
 * future multi-secret kind without a signature change.
 */
export interface ProviderDescriptor {
  /** The Provider_Kind this descriptor governs. */
  kind: ProviderKind;
  /**
   * The provider id contributed when satisfaction comes purely from the
   * environment. Matches the preset adapter id (e.g. `"together"`), so an
   * env-configured preset and a store record of the same kind never collide on
   * id unless they are genuinely the same logical provider.
   */
  envProviderId: string;
  /** Env-key names that must ALL be present and non-empty for env satisfaction. */
  requiredEnvKeys: readonly string[];
  /** The secret refs the Secret_Store must report present for a record of this kind. */
  requiredSecretRefs: (record: ProviderConfigRecord) => readonly string[];
}

/**
 * Every supported provider's required env keys + required secret refs.
 *
 * The required env keys mirror each preset provider's `validateConfig()`
 * contract in `./llm` (the credential plus the coordinates without a built-in
 * default), and the env-var names match the overlay conventions in
 * `./configBridge`. The single credential secret per kind is referenced through
 * the record's `secretRef`.
 */
export const PROVIDER_DESCRIPTORS: readonly ProviderDescriptor[] = [
  {
    kind: "together",
    envProviderId: "together",
    // baseUrl has a built-in default, so only the credential is required.
    requiredEnvKeys: ["TOGETHER_API_KEY"],
    requiredSecretRefs: (record) => [record.secretRef],
  },
  {
    kind: "cloudflare",
    envProviderId: "cloudflare",
    requiredEnvKeys: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"],
    requiredSecretRefs: (record) => [record.secretRef],
  },
  {
    kind: "azure-openai",
    envProviderId: "azure-openai",
    requiredEnvKeys: ["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_DEPLOYMENT"],
    requiredSecretRefs: (record) => [record.secretRef],
  },
  {
    kind: "openai-compatible",
    envProviderId: "openai-compatible",
    requiredEnvKeys: ["OPENAI_COMPATIBLE_API_KEY", "OPENAI_COMPATIBLE_BASE_URL", "OPENAI_COMPATIBLE_MODEL"],
    requiredSecretRefs: (record) => [record.secretRef],
  },
] as const;

/** Index {@link PROVIDER_DESCRIPTORS} by kind for O(1) record lookup. */
const DESCRIPTOR_BY_KIND: Readonly<Record<ProviderKind, ProviderDescriptor>> = Object.freeze(
  PROVIDER_DESCRIPTORS.reduce((map, descriptor) => {
    map[descriptor.kind] = descriptor;
    return map;
  }, {} as Record<ProviderKind, ProviderDescriptor>),
);

/**
 * Describe each supported provider's required env keys, for the boot-time
 * startup warning (Requirements 1.4, 1.7). The result names key NAMES only and
 * therefore carries no secret value; the caller may log it directly.
 */
export function describeRequiredProviderEnvKeys(): string {
  return PROVIDER_DESCRIPTORS.map(
    (descriptor) => `${descriptor.envProviderId} (${descriptor.requiredEnvKeys.join(", ")})`,
  ).join("; ");
}

/** A value counts as present only when defined and not blank/whitespace-only. */
function isNonEmpty(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

/**
 * Resolve the Orchestrator_Mode from a raw `ORCHESTRATOR_MODE` value.
 *
 * Unset, empty, or whitespace-only resolves to `local` (Requirement 9.5). Any
 * other value must match `local` or `external` exactly (case-sensitive);
 * otherwise an {@link OrchestrationConfigError} is thrown naming the accepted
 * values (Requirement 1.6). Note no trimming is applied to the comparison: a
 * value such as `" local "` carries content and is therefore invalid.
 */
function resolveOrchestratorMode(rawMode: string | undefined): OrchestratorMode {
  if (rawMode === undefined || rawMode.trim().length === 0) {
    return "local";
  }
  if (rawMode === "local" || rawMode === "external") {
    return rawMode;
  }
  throw new OrchestrationConfigError({
    code: "ORCHESTRATOR_MODE_INVALID",
    message: `ORCHESTRATOR_MODE must exactly match one of: ${ORCHESTRATOR_MODES.join(", ")}`,
    setupHint: `Set ORCHESTRATOR_MODE to one of: ${ORCHESTRATOR_MODES.join(", ")} (the provided value is not supported).`,
  });
}

/** Emit a redacted, secret-free store-read error and continue (Requirement 1.8). */
function emitStoreReadError(
  logger: ResolveOrchestrationLogger | undefined,
  source: string,
  error: unknown,
): void {
  const sink = logger ?? console;
  const message = error instanceof Error ? error.message : String(error);
  sink.error(`Rector could not read the ${source}; treating stored credentials as absent: ${redactString(message)}`);
}

/**
 * Read the Provider_Config_Store state, tolerating a read failure by reporting
 * an empty state (Requirement 1.8). The shipped local store already swallows
 * its own read errors, but an injected store may reject; this guard keeps the
 * resolver boot-tolerant regardless of the backing.
 */
async function readProviderConfigState(deps: ResolveOrchestrationDeps): Promise<ProviderConfigState> {
  try {
    return await deps.providerConfigStore.getState();
  } catch (error) {
    emitStoreReadError(deps.logger, "provider configuration store", error);
    return emptyProviderConfigState();
  }
}

/**
 * Report whether every required secret ref for a record is present in the
 * Secret_Store. A presence check that throws is treated as ABSENT (Requirement
 * 1.8): a redacted error is emitted and the record is considered unconfigured
 * rather than crashing the resolver.
 */
async function recordSecretsPresent(
  record: ProviderConfigRecord,
  deps: ResolveOrchestrationDeps,
): Promise<boolean> {
  const descriptor = DESCRIPTOR_BY_KIND[record.kind];
  for (const ref of descriptor.requiredSecretRefs(record)) {
    let present = false;
    try {
      present = await deps.secretStore.hasSecret(ref);
    } catch (error) {
      emitStoreReadError(deps.logger, "secret store", error);
      present = false;
    }
    if (!present) return false;
  }
  return true;
}

/**
 * Compute the configured-provider list as the union of env-satisfied providers
 * and store-satisfied records (Requirements 1.2, 1.3; Correctness Property 1).
 *
 * A `Set` deduplicates so an env-configured preset and a store record of the
 * same logical id contribute a single entry. The returned ids are never secret
 * values.
 */
async function resolveConfiguredProviders(deps: ResolveOrchestrationDeps): Promise<string[]> {
  const ids = new Set<string>();

  // Union part 1: env-satisfied providers (all required env keys present & non-empty).
  for (const descriptor of PROVIDER_DESCRIPTORS) {
    if (descriptor.requiredEnvKeys.every((key) => isNonEmpty(deps.env[key]))) {
      ids.add(descriptor.envProviderId);
    }
  }

  // Union part 2: store-satisfied records (all required secret refs reported present).
  const state = await readProviderConfigState(deps);
  for (const record of state.providers) {
    if (await recordSecretsPresent(record, deps)) {
      ids.add(record.id);
    }
  }

  return [...ids];
}

/**
 * Boot-tolerant orchestration config resolution (design section C1).
 *
 * - Resolves unset/empty/whitespace `ORCHESTRATOR_MODE` to `local` with an empty
 *   configured-provider list (Requirement 9.5).
 * - Throws {@link OrchestrationConfigError} (code `ORCHESTRATOR_MODE_INVALID`)
 *   for any non-empty value that is not exactly `local`/`external` — the only
 *   path that halts startup (Requirement 1.6).
 * - In `external` mode, awaits BOTH the Provider_Config_Store read and the
 *   Secret_Store presence checks before returning, and reports the union of
 *   env-satisfied providers and store-satisfied records (Requirements 1.1, 1.2,
 *   1.3). A store read failure is treated as absent credentials with a redacted
 *   error, and resolution continues (Requirement 1.8).
 *
 * Never reads a secret VALUE — provider satisfaction from the store is decided
 * purely by `hasSecret` presence booleans.
 */
export async function resolveOrchestrationConfig(
  deps: ResolveOrchestrationDeps,
): Promise<OrchestrationConfig> {
  const mode = resolveOrchestratorMode(deps.env.ORCHESTRATOR_MODE);

  // Local mode is the provider-free baseline: no store read, empty provider list.
  if (mode === "local") {
    return { mode, configuredProviders: [] };
  }

  const configuredProviders = await resolveConfiguredProviders(deps);
  return { mode, configuredProviders };
}
