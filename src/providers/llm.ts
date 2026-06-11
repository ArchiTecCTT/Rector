import { z } from "zod";
import { evaluateBudget, type BudgetUsage } from "../security/budget";
import type { Run } from "../store";

export const MODEL_ROUTES = ["cheap", "fast", "flagship", "research", "fake"] as const;
export const ModelRouteSchema = z.enum(MODEL_ROUTES);
export type ModelRoute = z.infer<typeof ModelRouteSchema>;

export const LLMMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
});
export type LLMMessage = z.infer<typeof LLMMessageSchema>;

export const LLMRequestSchema = z.object({
  messages: z.array(LLMMessageSchema).min(1),
  route: z.string().min(1).optional(),
  task: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  modelRoute: ModelRouteSchema.optional(),
  maxOutputTokens: z.number().int().positive().max(128_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  responseFormat: z.object({ type: z.enum(["text", "json_object"]) }).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type LLMRequest = z.infer<typeof LLMRequestSchema>;

export const LLMUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  estimatedUsd: z.number().nonnegative(),
  modelCalls: z.number().int().nonnegative(),
});
export type LLMUsage = z.infer<typeof LLMUsageSchema>;

export const LLMResponseSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  content: z.string(),
  finishReason: z.enum(["stop", "length", "tool_calls", "error"]),
  usage: LLMUsageSchema,
  raw: z.unknown().optional(),
});
export type LLMResponse = z.infer<typeof LLMResponseSchema>;

export const ProviderCapabilityMetadataSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  routes: z.array(ModelRouteSchema).min(1),
  models: z.record(z.string().min(1)),
  supportsJson: z.boolean(),
  supportsStreaming: z.boolean(),
  maxContextTokens: z.number().int().positive(),
  estimatedUsdPer1kInputTokens: z.number().nonnegative(),
  estimatedUsdPer1kOutputTokens: z.number().nonnegative(),
});
export type ProviderCapabilityMetadata = z.infer<typeof ProviderCapabilityMetadataSchema>;

export type ProviderErrorCode =
  | "CONFIG_INVALID"
  | "BUDGET_DENIED"
  | "NETWORK_DISABLED"
  | "PROVIDER_HTTP_ERROR"
  | "PROVIDER_RESPONSE_INVALID";

export class ProviderError extends Error {
  readonly name = "ProviderError";
  readonly code: ProviderErrorCode;
  readonly provider: string;
  readonly retryable: boolean;
  readonly status?: number;
  readonly details?: unknown;

  constructor(input: {
    code: ProviderErrorCode;
    provider: string;
    message: string;
    retryable?: boolean;
    status?: number;
    details?: unknown;
  }) {
    super(input.message);
    this.code = input.code;
    this.provider = input.provider;
    this.retryable = input.retryable ?? false;
    this.status = input.status;
    this.details = input.details;
  }
}

export interface LLMProvider {
  readonly metadata: ProviderCapabilityMetadata;
  validateConfig(): void;
  estimateRequest(request: LLMRequest): LLMUsage;
  invoke(request: LLMRequest): Promise<LLMResponse>;
}

export class FakeLLMProvider implements LLMProvider {
  readonly metadata = ProviderCapabilityMetadataSchema.parse({
    id: "fake",
    displayName: "Fake Local LLM Provider",
    routes: ["cheap", "fast", "flagship", "research", "fake"],
    models: {
      cheap: "fake-local-deterministic",
      fast: "fake-local-deterministic",
      flagship: "fake-local-deterministic",
      research: "fake-local-deterministic",
      fake: "fake-local-deterministic",
    },
    supportsJson: true,
    supportsStreaming: false,
    maxContextTokens: 1_000_000,
    estimatedUsdPer1kInputTokens: 0,
    estimatedUsdPer1kOutputTokens: 0,
  });

  validateConfig(): void {
    return undefined;
  }

  estimateRequest(request: LLMRequest): LLMUsage {
    const parsed = LLMRequestSchema.parse(request);
    const inputTokens = estimateInputTokens(parsed);
    const outputTokens = parsed.maxOutputTokens ?? 128;
    return LLMUsageSchema.parse({
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      estimatedUsd: 0,
      modelCalls: 1,
    });
  }

  async invoke(request: LLMRequest): Promise<LLMResponse> {
    const parsed = LLMRequestSchema.parse(request);
    const usage = this.estimateRequest(parsed);
    const lastUserMessage = [...parsed.messages].reverse().find((message) => message.role === "user")?.content ?? "";
    const task = parsed.task ?? parsed.route ?? "local request";

    return LLMResponseSchema.parse({
      provider: this.metadata.id,
      model: this.metadata.models.fake,
      content: `Fake provider response for ${task}: ${lastUserMessage}`.trim(),
      finishReason: "stop",
      usage,
    });
  }
}

export interface TogetherAIProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  enableNetwork?: boolean;
  fetchImpl?: typeof fetch;
}

export interface BuiltProviderRequest {
  url: string;
  init: RequestInit & { headers: Record<string, string>; body: string };
}

export type BuiltTogetherRequest = BuiltProviderRequest;

export class TogetherAIProvider implements LLMProvider {
  readonly metadata = ProviderCapabilityMetadataSchema.parse({
    id: "together",
    displayName: "Together AI",
    routes: ["cheap", "fast", "flagship", "research"],
    models: {
      cheap: "meta-llama/Llama-3.2-3B-Instruct-Turbo",
      fast: "Qwen/Qwen2.5-Coder-7B-Instruct",
      flagship: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      research: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    },
    supportsJson: true,
    supportsStreaming: false,
    maxContextTokens: 128_000,
    estimatedUsdPer1kInputTokens: 0.0009,
    estimatedUsdPer1kOutputTokens: 0.0009,
  });

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly enableNetwork: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TogetherAIProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.TOGETHER_API_KEY ?? "";
    this.baseUrl = (options.baseUrl ?? process.env.TOGETHER_BASE_URL ?? "https://api.together.xyz/v1").replace(/\/+$/, "");
    this.enableNetwork = options.enableNetwork ?? false;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  validateConfig(): void {
    if (!this.apiKey.trim()) {
      throw new ProviderError({
        code: "CONFIG_INVALID",
        provider: this.metadata.id,
        message: "TOGETHER_API_KEY is required to use Together AI provider",
      });
    }
    if (!/^https?:\/\//i.test(this.baseUrl)) {
      throw new ProviderError({
        code: "CONFIG_INVALID",
        provider: this.metadata.id,
        message: "TOGETHER_BASE_URL must be an absolute http(s) URL",
      });
    }
  }

  estimateRequest(request: LLMRequest): LLMUsage {
    const parsed = LLMRequestSchema.parse(request);
    const inputTokens = estimateInputTokens(parsed);
    const outputTokens = parsed.maxOutputTokens ?? 512;
    const estimatedUsd = roundUsd(
      (inputTokens / 1_000) * this.metadata.estimatedUsdPer1kInputTokens +
      (outputTokens / 1_000) * this.metadata.estimatedUsdPer1kOutputTokens
    );

    return LLMUsageSchema.parse({
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      estimatedUsd,
      modelCalls: 1,
    });
  }

  buildRequest(request: LLMRequest): BuiltTogetherRequest {
    this.validateConfig();
    const parsed = LLMRequestSchema.parse(request);
    const modelRoute = parsed.modelRoute ?? "fast";
    const model = parsed.model ?? this.metadata.models[modelRoute] ?? this.metadata.models.fast;
    const body: Record<string, unknown> = {
      model,
      messages: parsed.messages,
      max_tokens: parsed.maxOutputTokens ?? 512,
    };

    if (parsed.temperature !== undefined) body.temperature = parsed.temperature;
    if (parsed.responseFormat !== undefined) body.response_format = parsed.responseFormat;

    return {
      url: `${this.baseUrl}/chat/completions`,
      init: {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    };
  }

  async invoke(request: LLMRequest): Promise<LLMResponse> {
    const parsed = LLMRequestSchema.parse(request);
    const built = this.buildRequest(parsed);

    if (!this.enableNetwork) {
      throw new ProviderError({
        code: "NETWORK_DISABLED",
        provider: this.metadata.id,
        message: "Together AI network calls are disabled unless enableNetwork is explicitly true",
      });
    }

    const response = await this.fetchImpl(built.url, built.init);
    if (!response.ok) {
      throw new ProviderError({
        code: "PROVIDER_HTTP_ERROR",
        provider: this.metadata.id,
        status: response.status,
        retryable: response.status >= 500 || response.status === 429,
        message: `Together AI request failed with HTTP ${response.status}`,
      });
    }

    const raw = await response.json();
    return this.parseResponse(parsed, raw);
  }

  private parseResponse(request: LLMRequest, raw: unknown): LLMResponse {
    const rawRecord = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const choices = Array.isArray(rawRecord.choices) ? rawRecord.choices : [];
    const first = choices[0] && typeof choices[0] === "object" ? choices[0] as Record<string, unknown> : {};
    const message = first.message && typeof first.message === "object" ? first.message as Record<string, unknown> : {};
    const content = typeof message.content === "string" ? message.content : "";
    const model = typeof rawRecord.model === "string" ? rawRecord.model : request.model ?? this.metadata.models[request.modelRoute ?? "fast"];
    const usageRecord = rawRecord.usage && typeof rawRecord.usage === "object" ? rawRecord.usage as Record<string, unknown> : {};
    const fallback = this.estimateRequest(request);
    const inputTokens = numberValue(usageRecord.prompt_tokens, fallback.inputTokens);
    const outputTokens = numberValue(usageRecord.completion_tokens, fallback.outputTokens);
    const usage = LLMUsageSchema.parse({
      inputTokens,
      outputTokens,
      totalTokens: numberValue(usageRecord.total_tokens, inputTokens + outputTokens),
      estimatedUsd: this.estimateRequest({ ...request, maxOutputTokens: outputTokens }).estimatedUsd,
      modelCalls: 1,
    });

    try {
      return LLMResponseSchema.parse({
        provider: this.metadata.id,
        model,
        content,
        finishReason: normalizeFinishReason(first.finish_reason),
        usage,
        raw,
      });
    } catch (error) {
      throw new ProviderError({
        code: "PROVIDER_RESPONSE_INVALID",
        provider: this.metadata.id,
        message: "Together AI response did not match LLM response contract",
        details: error,
      });
    }
  }
}

export interface CloudflareWorkersAIProviderOptions {
  accountId?: string;
  apiToken?: string;
  baseUrl?: string;
  enableNetwork?: boolean;
  fetchImpl?: typeof fetch;
}

export class CloudflareWorkersAIProvider implements LLMProvider {
  readonly metadata = ProviderCapabilityMetadataSchema.parse({
    id: "cloudflare",
    displayName: "Cloudflare Workers AI",
    routes: ["cheap", "fast"],
    models: {
      cheap: "@cf/meta/llama-3.1-8b-instruct",
      fast: "@cf/meta/llama-3.1-8b-instruct",
    },
    supportsJson: false,
    supportsStreaming: false,
    maxContextTokens: 32_000,
    estimatedUsdPer1kInputTokens: 0.0002,
    estimatedUsdPer1kOutputTokens: 0.0002,
  });

  private readonly accountId: string;
  private readonly apiToken: string;
  private readonly baseUrl: string;
  private readonly enableNetwork: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CloudflareWorkersAIProviderOptions = {}) {
    this.accountId = options.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
    this.apiToken = options.apiToken ?? process.env.CLOUDFLARE_API_TOKEN ?? "";
    this.baseUrl = (options.baseUrl ?? process.env.CLOUDFLARE_BASE_URL ?? "https://api.cloudflare.com/client/v4").replace(/\/+$/, "");
    this.enableNetwork = options.enableNetwork ?? false;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  validateConfig(): void {
    if (!this.accountId.trim()) {
      throw new ProviderError({
        code: "CONFIG_INVALID",
        provider: this.metadata.id,
        message: "CLOUDFLARE_ACCOUNT_ID is required to use Cloudflare Workers AI provider",
      });
    }
    if (!this.apiToken.trim()) {
      throw new ProviderError({
        code: "CONFIG_INVALID",
        provider: this.metadata.id,
        message: "CLOUDFLARE_API_TOKEN is required to use Cloudflare Workers AI provider",
      });
    }
    if (!/^https?:\/\//i.test(this.baseUrl)) {
      throw new ProviderError({
        code: "CONFIG_INVALID",
        provider: this.metadata.id,
        message: "CLOUDFLARE_BASE_URL must be an absolute http(s) URL",
      });
    }
  }

  estimateRequest(request: LLMRequest): LLMUsage {
    return estimateCostedRequest(request, this.metadata, 256);
  }

  buildRequest(request: LLMRequest): BuiltProviderRequest {
    this.validateConfig();
    const parsed = LLMRequestSchema.parse(request);
    const modelRoute = parsed.modelRoute ?? "fast";
    const model = parsed.model ?? this.metadata.models[modelRoute] ?? this.metadata.models.fast;
    const body: Record<string, unknown> = {
      messages: parsed.messages,
      max_tokens: parsed.maxOutputTokens ?? 256,
    };

    if (parsed.temperature !== undefined) body.temperature = parsed.temperature;

    return {
      url: `${this.baseUrl}/accounts/${this.accountId}/ai/run/${model}`,
      init: {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    };
  }

  async invoke(request: LLMRequest): Promise<LLMResponse> {
    const parsed = LLMRequestSchema.parse(request);
    const built = this.buildRequest(parsed);

    if (!this.enableNetwork) {
      throw new ProviderError({
        code: "NETWORK_DISABLED",
        provider: this.metadata.id,
        message: "Cloudflare Workers AI network calls are disabled unless enableNetwork is explicitly true",
      });
    }

    const response = await this.fetchImpl(built.url, built.init);
    if (!response.ok) throwProviderHttpError(this.metadata.id, response.status, "Cloudflare Workers AI");

    const raw = await response.json();
    return parseCloudflareResponse(this, parsed, raw);
  }
}

export interface AzureOpenAIProviderOptions {
  apiKey?: string;
  endpoint?: string;
  apiVersion?: string;
  deployments?: Partial<Record<ModelRoute, string>>;
  enableNetwork?: boolean;
  fetchImpl?: typeof fetch;
}

export class AzureOpenAIProvider implements LLMProvider {
  readonly metadata = ProviderCapabilityMetadataSchema.parse({
    id: "azure-openai",
    displayName: "Azure OpenAI",
    routes: ["fast", "flagship"],
    models: {
      fast: "gpt-4o-mini",
      flagship: "gpt-5",
    },
    supportsJson: true,
    supportsStreaming: false,
    maxContextTokens: 128_000,
    estimatedUsdPer1kInputTokens: 0.0025,
    estimatedUsdPer1kOutputTokens: 0.01,
  });

  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly apiVersion: string;
  private readonly deployments: Partial<Record<ModelRoute, string>>;
  private readonly enableNetwork: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AzureOpenAIProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.AZURE_OPENAI_API_KEY ?? "";
    this.endpoint = (options.endpoint ?? process.env.AZURE_OPENAI_ENDPOINT ?? "").replace(/\/+$/, "");
    this.apiVersion = options.apiVersion ?? process.env.AZURE_OPENAI_API_VERSION ?? "2024-10-21";
    this.deployments = {
      cheap: process.env.AZURE_OPENAI_CHEAP_DEPLOYMENT,
      fast: process.env.AZURE_OPENAI_FAST_DEPLOYMENT ?? process.env.AZURE_OPENAI_DEPLOYMENT,
      flagship: process.env.AZURE_OPENAI_FLAGSHIP_DEPLOYMENT ?? process.env.AZURE_OPENAI_DEPLOYMENT,
      research: process.env.AZURE_OPENAI_RESEARCH_DEPLOYMENT,
      ...options.deployments,
    };
    this.enableNetwork = options.enableNetwork ?? false;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  validateConfig(): void {
    if (!this.apiKey.trim()) {
      throw new ProviderError({
        code: "CONFIG_INVALID",
        provider: this.metadata.id,
        message: "AZURE_OPENAI_API_KEY is required to use Azure OpenAI provider",
      });
    }
    if (!this.endpoint.trim()) {
      throw new ProviderError({
        code: "CONFIG_INVALID",
        provider: this.metadata.id,
        message: "AZURE_OPENAI_ENDPOINT is required to use Azure OpenAI provider",
      });
    }
    if (!/^https?:\/\//i.test(this.endpoint)) {
      throw new ProviderError({
        code: "CONFIG_INVALID",
        provider: this.metadata.id,
        message: "AZURE_OPENAI_ENDPOINT must be an absolute http(s) URL",
      });
    }
    if (!this.apiVersion.trim()) {
      throw new ProviderError({
        code: "CONFIG_INVALID",
        provider: this.metadata.id,
        message: "AZURE_OPENAI_API_VERSION is required to use Azure OpenAI provider",
      });
    }
    const hasSupportedDeployment = this.metadata.routes.some((route) => this.deploymentFor(route));
    if (!hasSupportedDeployment) {
      throw new ProviderError({
        code: "CONFIG_INVALID",
        provider: this.metadata.id,
        message: "AZURE_OPENAI_DEPLOYMENT or route-specific Azure deployment env is required to use Azure OpenAI provider",
      });
    }
  }

  estimateRequest(request: LLMRequest): LLMUsage {
    return estimateCostedRequest(request, this.metadata, 512);
  }

  buildRequest(request: LLMRequest): BuiltProviderRequest {
    this.validateConfig();
    const parsed = LLMRequestSchema.parse(request);
    const modelRoute = parsed.modelRoute ?? "fast";
    const deployment = parsed.model ?? this.deploymentFor(modelRoute);

    if (!deployment) {
      throw new ProviderError({
        code: "CONFIG_INVALID",
        provider: this.metadata.id,
        message: `Azure OpenAI deployment is not configured for ${modelRoute} route`,
      });
    }

    const body: Record<string, unknown> = {
      messages: parsed.messages,
      max_tokens: parsed.maxOutputTokens ?? 512,
    };

    if (parsed.temperature !== undefined) body.temperature = parsed.temperature;
    if (parsed.responseFormat !== undefined) body.response_format = parsed.responseFormat;

    return {
      url: `${this.endpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(this.apiVersion)}`,
      init: {
        method: "POST",
        headers: {
          "api-key": this.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    };
  }

  async invoke(request: LLMRequest): Promise<LLMResponse> {
    const parsed = LLMRequestSchema.parse(request);
    const built = this.buildRequest(parsed);

    if (!this.enableNetwork) {
      throw new ProviderError({
        code: "NETWORK_DISABLED",
        provider: this.metadata.id,
        message: "Azure OpenAI network calls are disabled unless enableNetwork is explicitly true",
      });
    }

    const response = await this.fetchImpl(built.url, built.init);
    if (!response.ok) throwProviderHttpError(this.metadata.id, response.status, "Azure OpenAI");

    const raw = await response.json();
    return parseOpenAICompatibleResponse(this.metadata.id, this.metadata, parsed, raw, this.estimateRequest(parsed));
  }

  private deploymentFor(route: ModelRoute): string | undefined {
    return valueOrUndefined(this.deployments[route]);
  }
}

export interface OpenAICompatibleProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  headers?: Record<string, string>;
  enableNetwork?: boolean;
  fetchImpl?: typeof fetch;
}

const OPENAI_COMPATIBLE_PLACEHOLDER_MODEL = "openai-compatible-model";

export class OpenAICompatibleProvider implements LLMProvider {
  readonly metadata: ProviderCapabilityMetadata;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly headers: Record<string, string>;
  private readonly enableNetwork: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAICompatibleProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENAI_COMPATIBLE_API_KEY ?? "";
    this.baseUrl = (options.baseUrl ?? process.env.OPENAI_COMPATIBLE_BASE_URL ?? "").replace(/\/+$/, "");
    this.model = (options.model ?? process.env.OPENAI_COMPATIBLE_MODEL ?? "").trim();
    this.headers = { ...(options.headers ?? {}) };
    this.enableNetwork = options.enableNetwork ?? false;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;

    const metadataModel = this.model || OPENAI_COMPATIBLE_PLACEHOLDER_MODEL;
    this.metadata = ProviderCapabilityMetadataSchema.parse({
      id: "openai-compatible",
      displayName: "OpenAI-Compatible",
      routes: ["cheap", "fast", "flagship", "research"],
      models: {
        cheap: metadataModel,
        fast: metadataModel,
        flagship: metadataModel,
        research: metadataModel,
      },
      supportsJson: true,
      supportsStreaming: false,
      maxContextTokens: 128_000,
      estimatedUsdPer1kInputTokens: 0.001,
      estimatedUsdPer1kOutputTokens: 0.001,
    });
  }

  validateConfig(): void {
    if (!this.apiKey.trim()) {
      throw new ProviderError({
        code: "CONFIG_INVALID",
        provider: this.metadata.id,
        message: "An API key is required to use the OpenAI-compatible provider",
      });
    }
    if (!/^https?:\/\//i.test(this.baseUrl)) {
      throw new ProviderError({
        code: "CONFIG_INVALID",
        provider: this.metadata.id,
        message: "An absolute http(s) base URL is required to use the OpenAI-compatible provider",
      });
    }
    if (!this.model.trim()) {
      throw new ProviderError({
        code: "CONFIG_INVALID",
        provider: this.metadata.id,
        message: "A model id is required to use the OpenAI-compatible provider",
      });
    }
  }

  estimateRequest(request: LLMRequest): LLMUsage {
    return estimateCostedRequest(request, this.metadata, 512);
  }

  buildRequest(request: LLMRequest): BuiltProviderRequest {
    this.validateConfig();
    const parsed = LLMRequestSchema.parse(request);
    const model = parsed.model ?? this.model;
    const body: Record<string, unknown> = {
      model,
      messages: parsed.messages,
      max_tokens: parsed.maxOutputTokens ?? 512,
    };

    if (parsed.temperature !== undefined) body.temperature = parsed.temperature;
    if (parsed.responseFormat !== undefined) body.response_format = parsed.responseFormat;

    return {
      url: `${this.baseUrl}/chat/completions`,
      init: {
        method: "POST",
        headers: {
          ...this.headers,
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    };
  }

  async invoke(request: LLMRequest): Promise<LLMResponse> {
    const parsed = LLMRequestSchema.parse(request);
    const built = this.buildRequest(parsed);

    if (!this.enableNetwork) {
      throw new ProviderError({
        code: "NETWORK_DISABLED",
        provider: this.metadata.id,
        message: "OpenAI-compatible network calls are disabled unless enableNetwork is explicitly true",
      });
    }

    const response = await this.fetchImpl(built.url, built.init);
    if (!response.ok) throwProviderHttpError(this.metadata.id, response.status, this.metadata.displayName);

    const raw = await response.json();
    return parseOpenAICompatibleResponse(this.metadata.id, this.metadata, parsed, raw, this.estimateRequest(parsed));
  }
}

export interface ModelRouterOptions {
  mode?: "local" | "external";
  providers?: LLMProvider[];
  env?: Record<string, string | undefined>;
}

export interface ModelRouterInput {
  route?: string;
  task?: string;
  capability?: ModelRoute;
  run?: Run;
}

export interface ModelSelection {
  provider: LLMProvider;
  modelRoute: ModelRoute;
  model: string;
  reason: string;
}

export interface ModelRouter {
  select(input?: ModelRouterInput): ModelSelection;
}

export function buildModelRouter(options: ModelRouterOptions = {}): ModelRouter {
  const mode = options.mode ?? "local";
  const env = options.env ?? {};
  const providers = options.providers ?? [
    new FakeLLMProvider(),
    new CloudflareWorkersAIProvider({
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      apiToken: env.CLOUDFLARE_API_TOKEN,
      baseUrl: env.CLOUDFLARE_BASE_URL,
    }),
    new AzureOpenAIProvider({
      apiKey: env.AZURE_OPENAI_API_KEY,
      endpoint: env.AZURE_OPENAI_ENDPOINT,
      apiVersion: env.AZURE_OPENAI_API_VERSION,
      deployments: {
        cheap: env.AZURE_OPENAI_CHEAP_DEPLOYMENT,
        fast: env.AZURE_OPENAI_FAST_DEPLOYMENT ?? env.AZURE_OPENAI_DEPLOYMENT,
        flagship: env.AZURE_OPENAI_FLAGSHIP_DEPLOYMENT ?? env.AZURE_OPENAI_DEPLOYMENT,
        research: env.AZURE_OPENAI_RESEARCH_DEPLOYMENT,
      },
    }),
    new TogetherAIProvider({
      apiKey: env.TOGETHER_API_KEY,
      baseUrl: env.TOGETHER_BASE_URL,
    }),
  ];
  const fake = providers.find((provider) => provider.metadata.id === "fake") ?? new FakeLLMProvider();

  return {
    select(input: ModelRouterInput = {}): ModelSelection {
      const targetRoute = input.capability ?? inferModelRoute(input);

      if (mode === "local") {
        return selection(fake, "fake", "local mode default selects fake provider");
      }

      if (input.run && (input.run.budget.maxModelCalls <= 0 || input.run.budget.maxUsd <= 0)) {
        return selection(fake, "fake", "budget does not allow paid provider calls; selecting fake provider");
      }

      const allowedProviders = input.run?.budget.allowedProviders ?? [];
      const candidates = providers.filter((provider) =>
        provider.metadata.id !== "fake" &&
        provider.metadata.routes.includes(targetRoute) &&
        (allowedProviders.length === 0 || allowedProviders.includes(provider.metadata.id)) &&
        isProviderConfigValid(provider)
      );

      const provider = prioritizeProvidersForRoute(candidates, targetRoute)[0];
      if (!provider) {
        return selection(fake, "fake", `no configured provider supports ${targetRoute}; selecting fake provider`);
      }

      return selection(provider, targetRoute, `selected ${provider.metadata.id} for ${targetRoute} capability`);
    },
  };
}

export async function invokeWithBudget(provider: LLMProvider, request: LLMRequest, run: Run): Promise<LLMResponse> {
  const parsed = LLMRequestSchema.parse(request);
  const estimate = provider.estimateRequest(parsed);
  const usage = providerBudgetUsage(provider.metadata.id, estimate, run);
  const decision = evaluateBudget(run, usage);

  if (decision.status !== "allowed") {
    throw new ProviderError({
      code: "BUDGET_DENIED",
      provider: provider.metadata.id,
      message: `Provider invocation denied by budget: ${decision.reasons.join("; ")}`,
      details: decision,
    });
  }

  return provider.invoke(parsed);
}

function estimateCostedRequest(request: LLMRequest, metadata: ProviderCapabilityMetadata, defaultOutputTokens: number): LLMUsage {
  const parsed = LLMRequestSchema.parse(request);
  const inputTokens = estimateInputTokens(parsed);
  const outputTokens = parsed.maxOutputTokens ?? defaultOutputTokens;
  const estimatedUsd = roundUsd(
    (inputTokens / 1_000) * metadata.estimatedUsdPer1kInputTokens +
    (outputTokens / 1_000) * metadata.estimatedUsdPer1kOutputTokens
  );

  return LLMUsageSchema.parse({
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimatedUsd,
    modelCalls: 1,
  });
}

function parseOpenAICompatibleResponse(
  provider: string,
  metadata: ProviderCapabilityMetadata,
  request: LLMRequest,
  raw: unknown,
  fallback: LLMUsage
): LLMResponse {
  const rawRecord = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const choices = Array.isArray(rawRecord.choices) ? rawRecord.choices : [];
  const first = choices[0] && typeof choices[0] === "object" ? choices[0] as Record<string, unknown> : {};
  const message = first.message && typeof first.message === "object" ? first.message as Record<string, unknown> : {};
  const content = typeof message.content === "string" ? message.content : "";
  const model = typeof rawRecord.model === "string"
    ? rawRecord.model
    : request.model ?? metadata.models[request.modelRoute ?? "fast"] ?? metadata.models.research ?? metadata.models.fast;
  const usageRecord = rawRecord.usage && typeof rawRecord.usage === "object" ? rawRecord.usage as Record<string, unknown> : {};
  const inputTokens = numberValue(usageRecord.prompt_tokens, fallback.inputTokens);
  const outputTokens = numberValue(usageRecord.completion_tokens, fallback.outputTokens);
  const usage = LLMUsageSchema.parse({
    inputTokens,
    outputTokens,
    totalTokens: numberValue(usageRecord.total_tokens, inputTokens + outputTokens),
    estimatedUsd: roundUsd(
      (inputTokens / 1_000) * metadata.estimatedUsdPer1kInputTokens +
      (outputTokens / 1_000) * metadata.estimatedUsdPer1kOutputTokens
    ),
    modelCalls: 1,
  });

  try {
    return LLMResponseSchema.parse({
      provider,
      model,
      content,
      finishReason: normalizeFinishReason(first.finish_reason),
      usage,
      raw,
    });
  } catch (error) {
    throw new ProviderError({
      code: "PROVIDER_RESPONSE_INVALID",
      provider,
      message: `${metadata.displayName} response did not match LLM response contract`,
      details: error,
    });
  }
}

function parseCloudflareResponse(provider: CloudflareWorkersAIProvider, request: LLMRequest, raw: unknown): LLMResponse {
  const rawRecord = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const result = rawRecord.result && typeof rawRecord.result === "object" ? rawRecord.result as Record<string, unknown> : {};
  const content = typeof result.response === "string"
    ? result.response
    : typeof result.content === "string"
      ? result.content
      : "";
  const usageRecord = result.usage && typeof result.usage === "object" ? result.usage as Record<string, unknown> : {};
  const fallback = provider.estimateRequest(request);
  const inputTokens = numberValue(usageRecord.prompt_tokens, fallback.inputTokens);
  const outputTokens = numberValue(usageRecord.completion_tokens, fallback.outputTokens);
  const metadata = provider.metadata;
  const usage = LLMUsageSchema.parse({
    inputTokens,
    outputTokens,
    totalTokens: numberValue(usageRecord.total_tokens, inputTokens + outputTokens),
    estimatedUsd: roundUsd(
      (inputTokens / 1_000) * metadata.estimatedUsdPer1kInputTokens +
      (outputTokens / 1_000) * metadata.estimatedUsdPer1kOutputTokens
    ),
    modelCalls: 1,
  });

  try {
    return LLMResponseSchema.parse({
      provider: metadata.id,
      model: request.model ?? metadata.models[request.modelRoute ?? "fast"] ?? metadata.models.fast,
      content,
      finishReason: "stop",
      usage,
      raw,
    });
  } catch (error) {
    throw new ProviderError({
      code: "PROVIDER_RESPONSE_INVALID",
      provider: metadata.id,
      message: "Cloudflare Workers AI response did not match LLM response contract",
      details: error,
    });
  }
}

function throwProviderHttpError(provider: string, status: number, displayName: string): never {
  throw new ProviderError({
    code: "PROVIDER_HTTP_ERROR",
    provider,
    status,
    retryable: status >= 500 || status === 429,
    message: `${displayName} request failed with HTTP ${status}`,
  });
}

function prioritizeProvidersForRoute(providers: LLMProvider[], route: ModelRoute): LLMProvider[] {
  const priority: Record<ModelRoute, string[]> = {
    cheap: ["cloudflare", "azure-openai", "together"],
    fast: ["cloudflare", "azure-openai", "together"],
    flagship: ["azure-openai", "together"],
    research: ["azure-openai", "together"],
    fake: ["fake"],
  };
  const preferred = priority[route] ?? [];
  return [...providers].sort((left, right) => {
    const leftRank = preferred.includes(left.metadata.id) ? preferred.indexOf(left.metadata.id) : preferred.length;
    const rightRank = preferred.includes(right.metadata.id) ? preferred.indexOf(right.metadata.id) : preferred.length;
    return leftRank - rightRank;
  });
}

function valueOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function providerBudgetUsage(provider: string, estimate: LLMUsage, run: Run): BudgetUsage {
  return {
    provider,
    estimatedUsd: currentNumber(run.actualCost?.usd, run.costEstimate.usd) + estimate.estimatedUsd,
    inputTokens: currentNumber(run.actualTokens?.input, run.tokenEstimate.input) + estimate.inputTokens,
    outputTokens: currentNumber(run.actualTokens?.output, run.tokenEstimate.output) + estimate.outputTokens,
    modelCalls: currentNumber(run.actualCost?.modelCalls, run.costEstimate.modelCalls) + estimate.modelCalls,
    runtimeMs: currentNumber(run.actualCost?.runtimeMs, run.costEstimate.runtimeMs),
    healingAttempts: run.healingAttempts,
  };
}

function selection(provider: LLMProvider, modelRoute: ModelRoute, reason: string): ModelSelection {
  const model = provider.metadata.models[modelRoute] ?? provider.metadata.models.fake ?? provider.metadata.models.fast;
  return { provider, modelRoute, model, reason };
}

function inferModelRoute(input: ModelRouterInput): ModelRoute {
  const route = input.route?.toUpperCase() ?? "";
  const task = input.task?.toLowerCase() ?? "";

  if (route === "RESEARCH" || /\b(research|current|latest|sources?)\b/.test(task)) return "research";
  if (route === "DIRECT_ANSWER" || /\b(summarize|explain|answer)\b/.test(task)) return "cheap";
  if (route === "CODE_EDIT" && /\b(architecture|complex|migration|security)\b/.test(task)) return "flagship";
  if (route === "PLAN_ONLY" && /\b(architecture|design|roadmap)\b/.test(task)) return "flagship";
  return "fast";
}

function isProviderConfigValid(provider: LLMProvider): boolean {
  try {
    provider.validateConfig();
    return true;
  } catch {
    return false;
  }
}

function estimateInputTokens(request: LLMRequest): number {
  const chars = request.messages.reduce((total, message) => total + message.role.length + message.content.length, 0);
  return Math.max(1, Math.ceil(chars / 4));
}

function roundUsd(value: number): number {
  return Math.max(0, Math.ceil(value * 1_000_000) / 1_000_000);
}

function currentNumber(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : fallback;
}

function normalizeFinishReason(value: unknown): LLMResponse["finishReason"] {
  if (value === "length" || value === "tool_calls" || value === "error") return value;
  return "stop";
}
