import {
  AzureOpenAIProvider,
  CloudflareWorkersAIProvider,
  OpenAICompatibleProvider,
  TogetherAIProvider,
  type LLMProvider,
} from "../../providers/llm";
import type { ProviderConfigRecord } from "../../providers/config";
import type { ProbeTarget, ResolveProviderOptions } from "../../providers/configBridge";
import { KindProviderRegistry } from "../providerRegistry";

export type LlmProviderFactory = (
  record: ProviderConfigRecord,
  secret: string | undefined,
  options: ResolveProviderOptions,
  target?: ProbeTarget,
) => LLMProvider;

const llmProviderRegistry = new KindProviderRegistry<
  ProviderConfigRecord,
  LLMProvider,
  ResolveProviderOptions,
  [ProbeTarget?]
>();

function registerLlmProviderModules(): void {
  llmProviderRegistry.register("together", (record, secret, options) =>
    new TogetherAIProvider({
      apiKey: secret,
      baseUrl: record.baseUrl,
      enableNetwork: options.enableNetwork ?? false,
      fetchImpl: options.fetchImpl,
    }),
  );

  llmProviderRegistry.register("cloudflare", (record, secret, options) =>
    new CloudflareWorkersAIProvider({
      apiToken: secret,
      accountId: record.cloudflare?.accountId,
      baseUrl: record.baseUrl,
      enableNetwork: options.enableNetwork ?? false,
      fetchImpl: options.fetchImpl,
    }),
  );

  llmProviderRegistry.register("azure-openai", (record, secret, options, target = {}) => {
    const azureTarget = target.deployment ?? target.model;
    return new AzureOpenAIProvider({
      apiKey: secret,
      endpoint: record.azure?.endpoint ?? record.baseUrl,
      apiVersion: record.azure?.apiVersion,
      deployments: {
        fast: azureTarget ?? record.models?.slm ?? record.azure?.deployment ?? record.model,
        flagship:
          azureTarget ?? record.models?.flagship ?? record.azure?.deployment ?? record.model,
      },
      enableNetwork: options.enableNetwork ?? false,
      fetchImpl: options.fetchImpl,
    });
  });

  llmProviderRegistry.register("openai-compatible", (record, secret, options, target = {}) =>
    new OpenAICompatibleProvider({
      apiKey: secret,
      baseUrl: record.baseUrl,
      model: target.model ?? record.model ?? record.models?.flagship,
      headers: record.headers,
      enableNetwork: options.enableNetwork ?? false,
      fetchImpl: options.fetchImpl,
    }),
  );
}

registerLlmProviderModules();

export function getLlmProviderRegistry(): KindProviderRegistry<
  ProviderConfigRecord,
  LLMProvider,
  ResolveProviderOptions,
  [ProbeTarget?]
> {
  return llmProviderRegistry;
}