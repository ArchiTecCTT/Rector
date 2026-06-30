import type { SecretStore } from "../security/secretStore";
import {
  AzureOpenAIProvider,
  CloudflareWorkersAIProvider,
  OpenAICompatibleProvider,
  TogetherAIProvider,
  buildModelRouter,
  type LLMProvider,
  type ModelRoute,
  type ModelRouter,
  type ModelRouterInput,
  type ModelSelection,
} from "./llm";
import type { ProviderConfigRecord, ProviderModelRole } from "./config";
import type { ProviderConfigStore } from "./configStore";
import { getLlmProviderRegistry } from "../modules/builtin/llmProviderModules";
import { CredentialPool, type CredentialPoolEntry } from "./credentialPool";

/**
 * Config_Bridge (design section C5/C6).
 *
 * Resolves persisted {@link ProviderConfigRecord}s plus their `Secret_Store`
 * secrets into the inputs used to (a) construct providers for the connection
 * test path and (b) build the External_Mode {@link ModelRouter}. It is the only
 * place where a stored secret is read back out, and even then the value lives
 * only transiently inside a provider instance — it is never serialized to a
 * response, log, or event.
 *
 * ## Precedence (Requirement 13.4, Correctness Property 6)
 *
 * For any provider field, **persisted UI configuration takes precedence over
 * `process.env`**. Rector is a local-first product and a value the user set
 * explicitly in-app is the more intentional signal than an ambient environment
 * variable. {@link resolveProviderEnv} therefore overlays each record's resolved
 * fields (and its injected secret) onto a *copy* of the base environment, with
 * `process.env` acting purely as the fallback for any field the user did not
 * set. The overlay is deterministic: identical inputs always yield an identical
 * effective environment, on every resolution.
 *
 * ## Sandbox isolation (Requirement 13.5, Correctness Property 8)
 *
 * The output of this bridge is confined to provider construction and the
 * connection-test path. It MUST NEVER be used to construct the sandbox executor
 * environment or any command the sandbox can run. The effective environment
 * produced here carries injected secrets and is deliberately kept out of the
 * sandbox boundary; callers must not forward it there.
 *
 * ## Secret presence (Requirement 13.6)
 *
 * Secret *presence* is surfaced elsewhere via `SecretStore.hasSecret` as a
 * boolean only. This bridge reads secret *values* solely at provider
 * construction time and never returns them to a caller.
 */

/** A plain environment map, mirroring the shape of `process.env`. */
export type ProviderEnv = Record<string, string | undefined>;

/** Options shared by the provider-construction helpers. */
export interface ResolveProviderOptions {
  /**
   * Whether constructed providers may perform network calls. Defaults to
   * `false` so nothing reaches the network unless a caller (e.g. the connection
   * test, or the live External_Mode server) explicitly opts in.
   */
  enableNetwork?: boolean;
  /** Injectable `fetch`, primarily for deterministic tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Optional model/deployment targeting for the per-model Model_Probe
 * (Requirement 22.1, 22.2). When the Setup_UI tests a selected Model_Candidate
 * it threads the candidate's `model` (and, for Azure OpenAI, its `deployment`)
 * here so the single connection ping targets exactly that candidate rather than
 * the record's default route.
 *
 * The override is applied at provider construction for the kinds that bind a
 * model/deployment at build time (`openai-compatible`, `azure-openai`); the
 * connection-test ping additionally sets the request `model` so route-aware
 * providers (Together AI) target the candidate too. Both fields are optional:
 * when absent the provider is built exactly as before from the persisted record.
 */
export interface ProbeTarget {
  /** The selected candidate's model id, targeting a single model on the ping. */
  model?: string;
  /** The selected candidate's deployment name (Azure OpenAI), targeting a single deployment. */
  deployment?: string;
}

/** Read a secret value for `secretRef`, or `undefined` when absent/unreadable. */
async function readSecretValue(secrets: SecretStore, secretRef: string): Promise<string | undefined> {
  const result = await secrets.getSecret(secretRef);
  return result.ok ? result.value : undefined;
}

/** Assign `value` onto `env[key]` only when defined, so a record field that the
 * user left unset never clobbers the `process.env` fallback with `undefined`. */
function overlay(env: ProviderEnv, key: string, value: string | undefined): void {
  if (value !== undefined && value !== "") {
    env[key] = value;
  }
}

/**
 * Map a single record's resolved fields + injected secret onto the effective
 * environment, using the env-var names each preset adapter reads. Persisted
 * values win over whatever the base environment carried (Requirement 13.4).
 */
function overlayRecord(env: ProviderEnv, record: ProviderConfigRecord, secret: string | undefined): void {
  switch (record.kind) {
    case "together":
      overlay(env, "TOGETHER_API_KEY", secret);
      overlay(env, "TOGETHER_BASE_URL", record.baseUrl);
      break;
    case "cloudflare":
      overlay(env, "CLOUDFLARE_API_TOKEN", secret);
      overlay(env, "CLOUDFLARE_ACCOUNT_ID", record.cloudflare?.accountId);
      overlay(env, "CLOUDFLARE_BASE_URL", record.baseUrl);
      break;
    case "azure-openai":
      overlay(env, "AZURE_OPENAI_API_KEY", secret);
      overlay(env, "AZURE_OPENAI_ENDPOINT", record.azure?.endpoint ?? record.baseUrl);
      overlay(env, "AZURE_OPENAI_API_VERSION", record.azure?.apiVersion);
      overlay(env, "AZURE_OPENAI_DEPLOYMENT", record.azure?.deployment ?? record.model);
      overlay(env, "AZURE_OPENAI_FLAGSHIP_DEPLOYMENT", record.models?.flagship);
      overlay(env, "AZURE_OPENAI_FAST_DEPLOYMENT", record.models?.slm);
      break;
    case "openai-compatible":
      overlay(env, "OPENAI_COMPATIBLE_API_KEY", secret);
      overlay(env, "OPENAI_COMPATIBLE_BASE_URL", record.baseUrl);
      overlay(env, "OPENAI_COMPATIBLE_MODEL", record.model ?? record.models?.flagship);
      break;
  }
}

/**
 * Resolve persisted configuration + secrets into an effective environment map.
 *
 * Produces a fresh copy of `baseEnv` (typically `process.env`) overlaid with
 * each record's resolved fields and its injected secret, applying the documented
 * precedence (persisted UI config over env). The result is intended only for
 * provider construction and the connection-test path — never for the sandbox
 * executor environment (Requirement 13.5).
 *
 * @returns a new map; `baseEnv` is never mutated.
 */
export async function resolveProviderEnv(
  store: ProviderConfigStore,
  secrets: SecretStore,
  baseEnv: ProviderEnv,
): Promise<ProviderEnv> {
  // Start from a copy so the caller's environment is never mutated; process.env
  // is the documented fallback for any field the user did not set.
  const effective: ProviderEnv = { ...baseEnv };
  const state = await store.getState();
  for (const record of state.providers) {
    const secret = await readSecretValue(secrets, record.secretRef);
    overlayRecord(effective, record, secret);
  }
  return effective;
}

export function buildCredentialPoolFromProviderRecords(records: readonly ProviderConfigRecord[]): CredentialPool {
  const entries: CredentialPoolEntry[] = [];
  for (const record of records) {
    entries.push({ providerId: record.id, secretRef: record.secretRef, label: record.label });
    for (const secretRef of record.additionalSecretRefs ?? []) {
      entries.push({ providerId: record.id, secretRef, label: record.label });
    }
  }
  return new CredentialPool(entries);
}

export async function buildCredentialPoolFromProviderStore(
  store: ProviderConfigStore,
  secrets: SecretStore,
  options: ResolveProviderOptions = {},
): Promise<CredentialPool> {
  const state = await store.getState();
  const entries: CredentialPoolEntry[] = [];
  for (const record of state.providers) {
    for (const secretRef of [record.secretRef, ...(record.additionalSecretRefs ?? [])]) {
      const secret = await readSecretValue(secrets, secretRef);
      entries.push({
        providerId: record.id,
        secretRef,
        label: record.label,
        provider: buildProviderFromRecord(record, secret, options),
      });
    }
  }
  return new CredentialPool(entries);
}

/**
 * Construct a single {@link LLMProvider} from one persisted record and its
 * (already-resolved) secret. Shared by {@link resolveTestProvider} and
 * {@link buildConfiguredRouter} so construction stays consistent.
 */
function buildProviderFromRecord(
  record: ProviderConfigRecord,
  secret: string | undefined,
  options: ResolveProviderOptions,
  target: ProbeTarget = {},
): LLMProvider {
  const enableNetwork = options.enableNetwork ?? false;
  const fetchImpl = options.fetchImpl;
  // A per-model probe (Req 22.1/22.2) targets a single candidate. For Azure the
  // candidate is addressed by its deployment name; for the OpenAI-compatible
  // kind it is addressed by its model id. The override is applied here only when
  // supplied, so a plain connection test (no target) builds the record verbatim.
  const built = getLlmProviderRegistry().build(record, secret, { enableNetwork, fetchImpl }, target);
  if (!built) {
    throw new Error(`No LLM provider module registered for kind: ${record.kind}`);
  }
  return built;
}

/**
 * Resolve exactly one provider for the connection-test path, built from the
 * persisted record identified by `providerId` and its `Secret_Store` secret
 * (Requirement 13.2). Returns `undefined` when no record with that id exists,
 * so the caller can reject an unsupported id before any network call
 * (Requirement 15.6).
 *
 * The optional {@link ProbeTarget} threads a selected Model_Candidate's `model`
 * (and, for Azure OpenAI, its `deployment`) into provider construction so a
 * per-model Model_Probe pings exactly that candidate (Requirement 22.1, 22.2).
 * When omitted, the provider is built verbatim from the record — the existing
 * connection-test behavior is unchanged.
 */
export async function resolveTestProvider(
  providerId: string,
  store: ProviderConfigStore,
  secrets: SecretStore,
  options: ResolveProviderOptions = {},
  target: ProbeTarget = {},
): Promise<LLMProvider | undefined> {
  const state = await store.getState();
  const record = state.providers.find((candidate) => candidate.id === providerId);
  if (!record) return undefined;
  const secret = await readSecretValue(secrets, record.secretRef);
  return buildProviderFromRecord(record, secret, options, target);
}

/** Dependencies for {@link buildConfiguredRouter}. */
export interface BuildConfiguredRouterOptions extends ResolveProviderOptions {
  /** The non-secret Provider_Config_Store. */
  store: ProviderConfigStore;
  /** The encrypted Secret_Store. */
  secrets: SecretStore;
  /** Orchestration mode; defaults to `"external"` (the BYOK live mode). */
  mode?: "local" | "external";
  /** Base environment used as the precedence fallback (defaults to `process.env`). */
  baseEnv?: ProviderEnv;
}

/** Map a resolved {@link ModelRoute} to the Active_Route_Map role it belongs to. */
function roleForRoute(route: ModelRoute): ProviderModelRole | undefined {
  if (route === "flagship") return "flagship";
  // The `slm` (small/fast) tier covers the cheap/fast capability routes.
  if (route === "fast" || route === "cheap") return "slm";
  return undefined;
}

/** Returns true when the provider's config validates (mirrors router gating). */
function isProviderValid(provider: LLMProvider): boolean {
  try {
    provider.validateConfig();
    return true;
  } catch {
    return false;
  }
}

/** Build a {@link ModelSelection} for an active-route override. */
function selectionFor(provider: LLMProvider, route: ModelRoute, role: ProviderModelRole, recordId: string): ModelSelection {
  const model = provider.metadata.models[route] ?? provider.metadata.models.fast ?? provider.metadata.models.fake;
  return {
    provider,
    providerId: recordId,
    modelRoute: route,
    model,
    reason: `active route ${role} -> ${recordId}`,
  };
}

/**
 * Build the External_Mode {@link ModelRouter} from persisted configuration.
 *
 * Construction:
 * - Preset providers (Cloudflare, Azure OpenAI, Together AI) are built from the
 *   effective environment produced by {@link resolveProviderEnv}, so persisted
 *   UI configuration takes precedence over env for those single-instance presets
 *   (Requirement 13.4).
 * - One {@link OpenAICompatibleProvider} is constructed per configured
 *   `openai-compatible` record, each with its own injected secret/headers, since
 *   multiple such deployments can be configured.
 * Selection honors the persisted Active_Route_Map (Requirement 14.3): when a
 * provider is designated for the selected route's role (`flagship`/`slm`) and
 * that provider is configured, valid, and supports the route, it is chosen;
 * otherwise the existing capability-priority selection is used as the fallback
 * (Requirement 14.4). The provider designated by a role is matched by its
 * persisted record id, not by adapter id, so distinct deployments sharing an
 * adapter remain addressable.
 *
 * The constructed router and providers are confined to provider selection and
 * invocation; the bridge never injects secrets into the sandbox executor
 * environment (Requirement 13.5).
 */
export async function buildConfiguredRouter(options: BuildConfiguredRouterOptions): Promise<ModelRouter> {
  const { store, secrets } = options;
  const mode = options.mode ?? "external";
  const baseEnv = options.baseEnv ?? process.env;
  const resolveOptions: ResolveProviderOptions = {
    enableNetwork: options.enableNetwork ?? false,
    fetchImpl: options.fetchImpl,
  };

  const effectiveEnv = await resolveProviderEnv(store, secrets, baseEnv);
  const state = await store.getState();

  const cloudflare = new CloudflareWorkersAIProvider({
    accountId: effectiveEnv.CLOUDFLARE_ACCOUNT_ID,
    apiToken: effectiveEnv.CLOUDFLARE_API_TOKEN,
    baseUrl: effectiveEnv.CLOUDFLARE_BASE_URL,
    enableNetwork: resolveOptions.enableNetwork,
    fetchImpl: resolveOptions.fetchImpl,
  });
  const azure = new AzureOpenAIProvider({
    apiKey: effectiveEnv.AZURE_OPENAI_API_KEY,
    endpoint: effectiveEnv.AZURE_OPENAI_ENDPOINT,
    apiVersion: effectiveEnv.AZURE_OPENAI_API_VERSION,
    deployments: {
      cheap: effectiveEnv.AZURE_OPENAI_CHEAP_DEPLOYMENT,
      fast: effectiveEnv.AZURE_OPENAI_FAST_DEPLOYMENT ?? effectiveEnv.AZURE_OPENAI_DEPLOYMENT,
      flagship: effectiveEnv.AZURE_OPENAI_FLAGSHIP_DEPLOYMENT ?? effectiveEnv.AZURE_OPENAI_DEPLOYMENT,
      research: effectiveEnv.AZURE_OPENAI_RESEARCH_DEPLOYMENT,
    },
    enableNetwork: resolveOptions.enableNetwork,
    fetchImpl: resolveOptions.fetchImpl,
  });
  const together = new TogetherAIProvider({
    apiKey: effectiveEnv.TOGETHER_API_KEY,
    baseUrl: effectiveEnv.TOGETHER_BASE_URL,
    enableNetwork: resolveOptions.enableNetwork,
    fetchImpl: resolveOptions.fetchImpl,
  });

  const providers: LLMProvider[] = [cloudflare, azure, together];

  // Map each persisted record id to the provider instance it controls, so the
  // Active_Route_Map (which addresses providers by record id) can resolve a
  // designated provider regardless of adapter id collisions.
  const providerByRecordId = new Map<string, LLMProvider>();
  for (const record of state.providers) {
    if (record.kind === "openai-compatible") {
      const secret = await readSecretValue(secrets, record.secretRef);
      const provider = buildProviderFromRecord(record, secret, resolveOptions);
      providers.push(provider);
      providerByRecordId.set(record.id, provider);
    } else if (record.kind === "cloudflare") {
      providerByRecordId.set(record.id, cloudflare);
    } else if (record.kind === "azure-openai") {
      providerByRecordId.set(record.id, azure);
    } else if (record.kind === "together") {
      providerByRecordId.set(record.id, together);
    }
  }

  const inner = buildModelRouter({ mode, providers, env: effectiveEnv, allowFakeFallback: mode === "local" });
  const activeRoutes = state.activeRoutes;

  return {
    select(input: ModelRouterInput = {}): ModelSelection {
      const base = inner.select(input);

      // Never override the fake fallback: it is returned for Local_Mode, a
      // budget denial, or when no configured provider supports the route. In
      // each case honoring an active route would be wrong.
      if (base.provider.metadata.id === "fake") {
        return base;
      }

      const role = roleForRoute(base.modelRoute);
      if (!role) return base;

      const designatedId = activeRoutes[role];
      if (!designatedId) return base;

      const designated = providerByRecordId.get(designatedId);
      // Fallback (Requirement 5.4): the designated provider is no longer
      // configured, fails validation, or cannot serve this route — keep the
      // capability-priority selection rather than failing the run. Record a
      // secret-free substitution marker in the trace so the run surfaces that a
      // designated route was substituted by the fallback (Requirement 5.5). The
      // marker carries only the role, the designated record id, the substitute
      // provider's adapter id, and the route — never any secret value.
      if (!designated || !isProviderValid(designated) || !designated.metadata.routes.includes(base.modelRoute)) {
        return {
          ...base,
          reason: `fallback substitution: designated ${role} provider ${designatedId} unavailable; using ${base.provider.metadata.id} for ${base.modelRoute}`,
        };
      }

      return selectionFor(designated, base.modelRoute, role, designatedId);
    },
  };
}
