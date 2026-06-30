import { defaultRuntimeSettings, type RuntimeSettingsStore } from "../config/runtimeSettings";
import { resolveTestProvider } from "../providers/configBridge";
import type { ProviderConfigRecord } from "../providers/config";
import type { ProviderConfigStore } from "../providers/configStore";
import {
  OpenAICompatibleProvider,
  isLiveLLMProvider,
  type LLMProvider,
  type ModelRoute,
} from "../providers/llm";
import { redactString } from "../security/redaction";
import type { SecretStore } from "../security/secretStore";

export type RequestedLiveProvider = "zai";
export type LiveProviderSource = "env" | "runtime-settings";
export type LiveProviderRejectionReason =
  | "missing_env"
  | "base_url_invalid"
  | "zai_host_required"
  | "adapter_not_openai_compatible"
  | "test_double_rejected"
  | "runtime_not_configured"
  | "no_configured_zai_provider"
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

const ZAI_ENV_KEYS = [
  "OPENAI_COMPATIBLE_API_KEY",
  "OPENAI_COMPATIBLE_BASE_URL",
  "OPENAI_COMPATIBLE_MODEL",
] as const;

const TEST_DOUBLE_PATTERN = /fake|deterministic|spy|mock|fixture|scripted|test[-_\s]?double/i;

export function normalizeRequestedLiveProvider(value: string | undefined): RequestedLiveProvider | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized === "zai" || normalized === "z.ai" ? "zai" : undefined;
}

export function isZaiCompatibleHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/\.$/, "");
  return normalized === "api.z.ai" || normalized.endsWith(".z.ai");
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
  if (requested !== "zai") {
    return { selected: undefined, rejections: [] };
  }

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

function discoverZaiFromEnv(
  env: Record<string, string | undefined>,
  options: LiveProviderDiscoveryOptions,
): LiveProviderDiscoveryResult {
  const apiKey = env.OPENAI_COMPATIBLE_API_KEY?.trim() ?? "";
  const baseUrl = env.OPENAI_COMPATIBLE_BASE_URL?.trim() ?? "";
  const model = env.OPENAI_COMPATIBLE_MODEL?.trim() ?? "";
  if (!apiKey || !baseUrl || !model) {
    return { selected: undefined, rejections: [rejection("env", "missing_env")] };
  }

  const host = hostFromUrl(baseUrl);
  if (!host) {
    return { selected: undefined, rejections: [rejection("env", "base_url_invalid")] };
  }
  if (!isZaiCompatibleHost(host)) {
    return { selected: undefined, rejections: [rejection("env", "zai_host_required", host)] };
  }

  const provider = new OpenAICompatibleProvider({
    apiKey,
    baseUrl,
    model,
    enableNetwork: true,
    fetchImpl: options.fetchImpl,
  });
  return selectedFromProvider({
    provider,
    providerId: "zai:env",
    modelId: model,
    host,
    source: "env",
    discoveryLabel: "RECTOR_LIVE_PROVIDER=zai OPENAI_COMPATIBLE_*",
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
    return { selected: undefined, rejections: [rejection("runtime-settings", "runtime_not_configured")] };
  }

  const state = await providerConfigStore.getState();
  const record = selectZaiRecord(state.providers, [
    state.activeRoutes.slm,
    state.activeRoutes.flagship,
  ]);
  if (!record) {
    return { selected: undefined, rejections: [rejection("runtime-settings", "no_configured_zai_provider")] };
  }

  const host = hostFromUrl(record.baseUrl ?? "");
  if (!host) {
    return { selected: undefined, rejections: [rejection("runtime-settings", "base_url_invalid")] };
  }
  if (!isZaiCompatibleHost(host)) {
    return { selected: undefined, rejections: [rejection("runtime-settings", "zai_host_required", host)] };
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
    return { selected: undefined, rejections: [rejection("runtime-settings", "config_invalid")] };
  }

  return selectedFromProvider({
    provider,
    providerId: record.id,
    modelId,
    host,
    source: "runtime-settings",
    discoveryLabel: "configured runtime provider state",
  });
}

function selectedFromProvider(input: {
  readonly provider: LLMProvider;
  readonly providerId: string;
  readonly modelId: string;
  readonly host: string;
  readonly source: LiveProviderSource;
  readonly discoveryLabel: string;
}): LiveProviderDiscoveryResult {
  const adapterId = input.provider.metadata.id;
  if (adapterId !== "openai-compatible") {
    return { selected: undefined, rejections: [rejection(input.source, "adapter_not_openai_compatible", input.host)] };
  }

  if (!isAcceptableLiveEvidenceProvider({
    provider: input.provider,
    providerId: input.providerId,
    displayName: input.provider.metadata.displayName,
  })) {
    return { selected: undefined, rejections: [rejection(input.source, "test_double_rejected", input.host)] };
  }

  try {
    input.provider.validateConfig();
  } catch (error) {
    return {
      selected: undefined,
      rejections: [rejection(input.source, "config_invalid", input.host, safeErrorMessage(error))],
    };
  }

  const route: ModelRoute = "cheap";
  const modelId = input.modelId || input.provider.metadata.models[route] || input.provider.metadata.models.fast;
  if (!modelId) {
    return { selected: undefined, rejections: [rejection(input.source, "config_invalid", input.host)] };
  }

  return {
    selected: {
      requestedProvider: "zai",
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

function selectZaiRecord(
  records: readonly ProviderConfigRecord[],
  preferredIds: readonly (string | undefined)[],
): ProviderConfigRecord | undefined {
  const candidates = records.filter((record) =>
    record.kind === "openai-compatible" && isZaiCompatibleHost(hostFromUrl(record.baseUrl ?? "") ?? ""),
  );
  for (const id of preferredIds) {
    const candidate = candidates.find((record) => record.id === id);
    if (candidate) return candidate;
  }
  return candidates[0];
}

function hasUsableZaiEnvConfiguration(env: Record<string, string | undefined>): boolean {
  const apiKey = env.OPENAI_COMPATIBLE_API_KEY?.trim() ?? "";
  const baseUrl = env.OPENAI_COMPATIBLE_BASE_URL?.trim() ?? "";
  const model = env.OPENAI_COMPATIBLE_MODEL?.trim() ?? "";
  const host = hostFromUrl(baseUrl);
  return Boolean(apiKey && model && host && isZaiCompatibleHost(host));
}

function hasAnyZaiEnvCoordinate(env: Record<string, string | undefined>): boolean {
  return ZAI_ENV_KEYS.some((key) => (env[key]?.trim() ?? "").length > 0);
}

function hostFromUrl(value: string): string | undefined {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function rejection(
  source: LiveProviderSource,
  reason: LiveProviderRejectionReason,
  host?: string,
  message?: string,
): LiveProviderRejection {
  return { provider: "zai", source, reason, ...(host ? { host } : {}), ...(message ? { message } : {}) };
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
