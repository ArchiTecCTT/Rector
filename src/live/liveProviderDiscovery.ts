import { defaultRuntimeSettings, type RuntimeSettingsStore } from "../config/runtimeSettings";
import {
  OpenAICompatibleProvider,
  isLiveLLMProvider,
  resolveTestProvider,
  type LLMProvider,
  type ModelRoute,
  type ProviderConfigRecord,
  type ProviderConfigStore,
} from "../providers";
import { redactString } from "../security/redaction";
import type { SecretStore } from "../security/secretStore";

export type RequestedLiveProvider = "zai" | "regolo";
export type LiveProviderSource = "env" | "runtime-settings";
export type LiveProviderRejectionReason =
  | "missing_env"
  | "base_url_invalid"
  | "zai_host_required"
  | "regolo_host_required"
  | "adapter_not_openai_compatible"
  | "test_double_rejected"
  | "runtime_not_configured"
  | "no_configured_zai_provider"
  | "no_configured_regolo_provider"
  | "config_invalid";

export interface LiveProviderRejection {
  readonly provider: RequestedLiveProvider;
  readonly source: LiveProviderSource;
  readonly reason: LiveProviderRejectionReason;
  readonly host?: string;
  readonly message?: string;
}

export interface DiscoveredLiveProvider {
  readonly requestedProvider: RequestedLiveProvider;
  readonly provider: LLMProvider;
  readonly providerId: string;
  readonly adapterId: string;
  readonly displayName: string;
  readonly modelId: string;
  readonly route: ModelRoute;
  readonly host: string;
  readonly source: LiveProviderSource;
  readonly liveEvidence: boolean;
  readonly discoveryLabel: string;
}

export interface LiveProviderDiscoveryResult {
  readonly selected?: DiscoveredLiveProvider;
  readonly rejections: readonly LiveProviderRejection[];
}

export interface LiveProviderDiscoveryOptions {
  readonly env?: Record<string, string | undefined>;
  readonly runtimeSettingsStore?: RuntimeSettingsStore;
  readonly providerConfigStore?: ProviderConfigStore;
  readonly secretStore?: SecretStore;
  readonly fetchImpl?: typeof fetch;
}

export interface LiveEvidenceProviderIdentity {
  readonly provider?: LLMProvider;
  readonly providerId?: string;
  readonly displayName?: string;
  readonly className?: string;
  readonly reportMetadata?: unknown;
}

export const ZAI_LIVE_ENV_KEYS = ["ZAI_API_KEY", "ZAI_BASE_URL", "ZAI_MODEL"] as const;
export const OPENAI_COMPATIBLE_LIVE_ENV_KEYS = [
  "OPENAI_COMPATIBLE_API_KEY",
  "OPENAI_COMPATIBLE_BASE_URL",
  "OPENAI_COMPATIBLE_MODEL",
] as const;

const ZAI_ENV_COORDINATE_KEYS = [...ZAI_LIVE_ENV_KEYS, ...OPENAI_COMPATIBLE_LIVE_ENV_KEYS] as const;

export type ZaiLiveEnvSourceLabel = "ZAI_*" | "OPENAI_COMPATIBLE_*";

export interface ResolvedZaiLiveEnvCoordinates {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly envSourceLabel: ZaiLiveEnvSourceLabel;
}

export function resolveZaiLiveEnvCoordinates(
  env: Record<string, string | undefined>,
): ResolvedZaiLiveEnvCoordinates {
  const apiKey = (env.ZAI_API_KEY?.trim() || env.OPENAI_COMPATIBLE_API_KEY?.trim()) ?? "";
  const baseUrl = (env.ZAI_BASE_URL?.trim() || env.OPENAI_COMPATIBLE_BASE_URL?.trim()) ?? "";
  const model = (env.ZAI_MODEL?.trim() || env.OPENAI_COMPATIBLE_MODEL?.trim()) ?? "";
  const usesZaiAlias = ZAI_LIVE_ENV_KEYS.some((key) => (env[key]?.trim() ?? "").length > 0);
  return {
    apiKey,
    baseUrl,
    model,
    envSourceLabel: usesZaiAlias ? "ZAI_*" : "OPENAI_COMPATIBLE_*",
  };
}

const TEST_DOUBLE_PATTERN = /fake|deterministic|spy|mock|fixture|scripted|test[-_\s]?double/i;

export function normalizeRequestedLiveProvider(value: string | undefined): RequestedLiveProvider | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "zai" || normalized === "z.ai") return "zai";
  if (normalized === "regolo") return "regolo";
  return undefined;
}

export function isZaiCompatibleHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/\.$/, "");
  return normalized === "api.z.ai" || normalized.endsWith(".z.ai");
}

export const REGOLO_LIVE_ENV_KEYS = ["REGOLO_API_KEY", "REGOLO_BASE_URL", "REGOLO_MODEL"] as const;
export type RegoloLiveEnvSourceLabel = "REGOLO_*";

export interface ResolvedRegoloLiveEnvCoordinates {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly envSourceLabel: RegoloLiveEnvSourceLabel;
}

export function resolveRegoloLiveEnvCoordinates(
  env: Record<string, string | undefined>,
): ResolvedRegoloLiveEnvCoordinates {
  const apiKey = env.REGOLO_API_KEY?.trim() ?? "";
  const baseUrl = env.REGOLO_BASE_URL?.trim() ?? "";
  const model = env.REGOLO_MODEL?.trim() ?? "";
  return {
    apiKey,
    baseUrl,
    model,
    envSourceLabel: "REGOLO_*",
  };
}

export function isRegoloCompatibleHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/\.$/, "");
  return normalized === "api.regolo.ai" || normalized.endsWith(".regolo.ai");
}

export function isAcceptableLiveEvidenceProvider(identity: LiveEvidenceProviderIdentity): boolean {
  const provider = identity.provider;
  if (provider && !isLiveLLMProvider(provider)) return false;

  const parts = [
    identity.providerId,
    identity.displayName,
    identity.className,
    provider?.metadata.id,
    provider?.metadata.displayName,
    provider?.constructor.name,
    stringifyMetadata(identity.reportMetadata),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  return !TEST_DOUBLE_PATTERN.test(parts.join(" "));
}

export async function discoverLiveProvider(
  options: LiveProviderDiscoveryOptions = {},
): Promise<LiveProviderDiscoveryResult> {
  const env = options.env ?? process.env;
  const requested = normalizeRequestedLiveProvider(env.RECTOR_LIVE_PROVIDER);
  if (requested === "zai") {
    if (hasUsableZaiEnvConfiguration(env)) {
      return discoverZaiFromEnv(env, options);
    }
    const configuredResult = await discoverZaiFromConfiguredProduct(options);
    if (configuredResult.selected) {
      return configuredResult;
    }
    if (hasAnyZaiEnvCoordinate(env)) {
      return discoverZaiFromEnv(env, options);
    }
    return configuredResult;
  }
  if (requested === "regolo") {
    if (hasUsableRegoloEnvConfiguration(env)) {
      return discoverRegoloFromEnv(env, options);
    }
    const configuredResult = await discoverRegoloFromConfiguredProduct(options);
    if (configuredResult.selected) {
      return configuredResult;
    }
    if (hasAnyRegoloEnvCoordinate(env)) {
      return discoverRegoloFromEnv(env, options);
    }
    return configuredResult;
  }
  return { selected: undefined, rejections: [] };
}

function discoverRegoloFromEnv(
  env: Record<string, string | undefined>,
  options: LiveProviderDiscoveryOptions,
): LiveProviderDiscoveryResult {
  const { apiKey, baseUrl, model, envSourceLabel } = resolveRegoloLiveEnvCoordinates(env);
  if (!apiKey || !baseUrl || !model) {
    return { selected: undefined, rejections: [rejection("regolo", "env", "missing_env")] };
  }

  const host = hostFromUrl(baseUrl);
  if (!host) {
    return { selected: undefined, rejections: [rejection("regolo", "env", "base_url_invalid")] };
  }
  if (!isRegoloCompatibleHost(host)) {
    return { selected: undefined, rejections: [rejection("regolo", "env", "regolo_host_required", host)] };
  }

  const provider = new OpenAICompatibleProvider({
    apiKey,
    baseUrl,
    model,
    enableNetwork: true,
    fetchImpl: options.fetchImpl,
  });
  return selectedFromProvider({
    requestedProvider: "regolo",
    provider,
    providerId: "regolo:env",
    modelId: model,
    host,
    source: "env",
    discoveryLabel: `RECTOR_LIVE_PROVIDER=regolo ${envSourceLabel}`,
  });
}

async function discoverRegoloFromConfiguredProduct(
  options: LiveProviderDiscoveryOptions,
): Promise<LiveProviderDiscoveryResult> {
  const { providerConfigStore, secretStore } = options;
  if (!providerConfigStore || !secretStore) {
    return { selected: undefined, rejections: [] };
  }

  const settings = options.runtimeSettingsStore
    ? await options.runtimeSettingsStore.get()
    : defaultRuntimeSettings();
  if (settings.orchestrationProfile !== "configured") {
    return { selected: undefined, rejections: [rejection("regolo", "runtime-settings", "runtime_not_configured")] };
  }

  const state = await providerConfigStore.getState();
  const record = selectOpenAiCompatibleRecordByHost(state.providers, [
    state.activeRoutes.slm,
    state.activeRoutes.flagship,
  ], isRegoloCompatibleHost);
  if (!record) {
    return { selected: undefined, rejections: [rejection("regolo", "runtime-settings", "no_configured_regolo_provider")] };
  }

  const host = hostFromUrl(record.baseUrl ?? "");
  if (!host) {
    return { selected: undefined, rejections: [rejection("regolo", "runtime-settings", "base_url_invalid")] };
  }
  if (!isRegoloCompatibleHost(host)) {
    return { selected: undefined, rejections: [rejection("regolo", "runtime-settings", "regolo_host_required", host)] };
  }

  const modelId = record.models?.slm ?? record.model ?? record.manualModels?.[0] ?? "";
  const provider = await resolveTestProvider(
    record.id,
    providerConfigStore,
    secretStore,
    { enableNetwork: true, fetchImpl: options.fetchImpl },
    modelId ? { model: modelId } : {},
  );
  if (!provider) {
    return { selected: undefined, rejections: [rejection("regolo", "runtime-settings", "config_invalid")] };
  }

  return selectedFromProvider({
    requestedProvider: "regolo",
    provider,
    providerId: record.id,
    modelId,
    host,
    source: "runtime-settings",
    discoveryLabel: "configured runtime provider state",
  });
}

function discoverZaiFromEnv(
  env: Record<string, string | undefined>,
  options: LiveProviderDiscoveryOptions,
): LiveProviderDiscoveryResult {
  const { apiKey, baseUrl, model, envSourceLabel } = resolveZaiLiveEnvCoordinates(env);
  if (!apiKey || !baseUrl || !model) {
    return { selected: undefined, rejections: [rejection("zai", "env", "missing_env")] };
  }

  const host = hostFromUrl(baseUrl);
  if (!host) {
    return { selected: undefined, rejections: [rejection("zai", "env", "base_url_invalid")] };
  }
  if (!isZaiCompatibleHost(host)) {
    return { selected: undefined, rejections: [rejection("zai", "env", "zai_host_required", host)] };
  }

  const provider = new OpenAICompatibleProvider({
    apiKey,
    baseUrl,
    model,
    enableNetwork: true,
    fetchImpl: options.fetchImpl,
  });
  return selectedFromProvider({
    requestedProvider: "zai",
    provider,
    providerId: "zai:env",
    modelId: model,
    host,
    source: "env",
    discoveryLabel: `RECTOR_LIVE_PROVIDER=zai ${envSourceLabel}`,
  });
}

async function discoverZaiFromConfiguredProduct(
  options: LiveProviderDiscoveryOptions,
): Promise<LiveProviderDiscoveryResult> {
  const { providerConfigStore, secretStore } = options;
  if (!providerConfigStore || !secretStore) {
    return { selected: undefined, rejections: [] };
  }

  const settings = options.runtimeSettingsStore
    ? await options.runtimeSettingsStore.get()
    : defaultRuntimeSettings();
  if (settings.orchestrationProfile !== "configured") {
    return { selected: undefined, rejections: [rejection("zai", "runtime-settings", "runtime_not_configured")] };
  }

  const state = await providerConfigStore.getState();
  const record = selectOpenAiCompatibleRecordByHost(state.providers, [
    state.activeRoutes.slm,
    state.activeRoutes.flagship,
  ], isZaiCompatibleHost);
  if (!record) {
    return { selected: undefined, rejections: [rejection("zai", "runtime-settings", "no_configured_zai_provider")] };
  }

  const host = hostFromUrl(record.baseUrl ?? "");
  if (!host) {
    return { selected: undefined, rejections: [rejection("zai", "runtime-settings", "base_url_invalid")] };
  }
  if (!isZaiCompatibleHost(host)) {
    return { selected: undefined, rejections: [rejection("zai", "runtime-settings", "zai_host_required", host)] };
  }

  const modelId = record.models?.slm ?? record.model ?? record.manualModels?.[0] ?? "";
  const provider = await resolveTestProvider(
    record.id,
    providerConfigStore,
    secretStore,
    { enableNetwork: true, fetchImpl: options.fetchImpl },
    modelId ? { model: modelId } : {},
  );
  if (!provider) {
    return { selected: undefined, rejections: [rejection("zai", "runtime-settings", "config_invalid")] };
  }

  return selectedFromProvider({
    requestedProvider: "zai",
    provider,
    providerId: record.id,
    modelId,
    host,
    source: "runtime-settings",
    discoveryLabel: "configured runtime provider state",
  });
}

function selectedFromProvider(input: {
  readonly requestedProvider: RequestedLiveProvider;
  readonly provider: LLMProvider;
  readonly providerId: string;
  readonly modelId: string;
  readonly host: string;
  readonly source: LiveProviderSource;
  readonly discoveryLabel: string;
}): LiveProviderDiscoveryResult {
  const adapterId = input.provider.metadata.id;
  if (adapterId !== "openai-compatible") {
    return {
      selected: undefined,
      rejections: [rejection(input.requestedProvider, input.source, "adapter_not_openai_compatible", input.host)],
    };
  }

  if (!isAcceptableLiveEvidenceProvider({
    provider: input.provider,
    providerId: input.providerId,
    displayName: input.provider.metadata.displayName,
  })) {
    return {
      selected: undefined,
      rejections: [rejection(input.requestedProvider, input.source, "test_double_rejected", input.host)],
    };
  }

  try {
    input.provider.validateConfig();
  } catch (error) {
    return {
      selected: undefined,
      rejections: [
        rejection(input.requestedProvider, input.source, "config_invalid", input.host, safeErrorMessage(error)),
      ],
    };
  }

  const route: ModelRoute = "cheap";
  const modelId = input.modelId || input.provider.metadata.models[route] || input.provider.metadata.models.fast;
  if (!modelId) {
    return {
      selected: undefined,
      rejections: [rejection(input.requestedProvider, input.source, "config_invalid", input.host)],
    };
  }

  return {
    selected: {
      requestedProvider: input.requestedProvider,
      provider: input.provider,
      providerId: input.providerId,
      adapterId,
      displayName: input.provider.metadata.displayName,
      modelId,
      route,
      host: input.host,
      source: input.source,
      liveEvidence: true,
      discoveryLabel: input.discoveryLabel,
    },
    rejections: [],
  };
}

function selectOpenAiCompatibleRecordByHost(
  records: readonly ProviderConfigRecord[],
  preferredIds: readonly (string | undefined)[],
  hostGuard: (host: string) => boolean,
): ProviderConfigRecord | undefined {
  const candidates = records.filter((record) =>
    record.kind === "openai-compatible" && hostGuard(hostFromUrl(record.baseUrl ?? "") ?? ""),
  );
  for (const id of preferredIds) {
    const candidate = candidates.find((record) => record.id === id);
    if (candidate) return candidate;
  }
  return candidates[0];
}

function hasUsableZaiEnvConfiguration(env: Record<string, string | undefined>): boolean {
  const { apiKey, baseUrl, model } = resolveZaiLiveEnvCoordinates(env);
  const host = hostFromUrl(baseUrl);
  return Boolean(apiKey && model && host && isZaiCompatibleHost(host));
}

function hasAnyZaiEnvCoordinate(env: Record<string, string | undefined>): boolean {
  return ZAI_ENV_COORDINATE_KEYS.some((key) => (env[key]?.trim() ?? "").length > 0);
}

function hasUsableRegoloEnvConfiguration(env: Record<string, string | undefined>): boolean {
  const { apiKey, baseUrl, model } = resolveRegoloLiveEnvCoordinates(env);
  const host = hostFromUrl(baseUrl);
  return Boolean(apiKey && model && host && isRegoloCompatibleHost(host));
}

function hasAnyRegoloEnvCoordinate(env: Record<string, string | undefined>): boolean {
  return REGOLO_LIVE_ENV_KEYS.some((key) => (env[key]?.trim() ?? "").length > 0);
}

function hostFromUrl(value: string): string | undefined {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function rejection(
  provider: RequestedLiveProvider,
  source: LiveProviderSource,
  reason: LiveProviderRejectionReason,
  host?: string,
  message?: string,
): LiveProviderRejection {
  return { provider, source, reason, ...(host ? { host } : {}), ...(message ? { message } : {}) };
}

function stringifyMetadata(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value).slice(0, 2_000);
  } catch {
    return String(value).slice(0, 2_000);
  }
}

function safeErrorMessage(error: unknown): string {
  return redactString(error instanceof Error ? error.message : String(error));
}
