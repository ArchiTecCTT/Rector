import { describe, expect, it, vi } from "vitest";
import type { Run } from "../src/store";
import {
  AzureOpenAIProvider,
  CloudflareWorkersAIProvider,
  FakeLLMProvider,
  LLMResponseSchema,
  ProviderError,
  TogetherAIProvider,
  buildModelRouter,
  invokeWithBudget,
} from "../src/providers";

const baseRun: Run = {
  id: "run-provider-1",
  conversationId: "conv-1",
  userMessageId: "msg-1",
  status: "running",
  phase: "PLANNING",
  route: "CODE_EDIT",
  complexity: "medium",
  budget: {
    maxUsd: 0.01,
    maxInputTokens: 10_000,
    maxOutputTokens: 2_000,
    maxModelCalls: 1,
    maxRuntimeMs: 60_000,
    maxHealingAttempts: 1,
    allowedProviders: ["fake", "together", "cloudflare", "azure-openai"],
    approvalRequiredAboveUsd: 0,
  },
  costEstimate: { usd: 0, modelCalls: 0, runtimeMs: 0 },
  tokenEstimate: { input: 0, output: 0 },
  traceId: "trace-provider-1",
  attempts: 1,
  healingAttempts: 0,
  validationAttempts: 0,
  createdAt: "2026-06-03T00:00:00.000Z",
  updatedAt: "2026-06-03T00:00:00.000Z",
};

const request = {
  messages: [{ role: "user" as const, content: "Summarize provider contract" }],
  route: "DIRECT_ANSWER",
  task: "provider contract test",
  maxOutputTokens: 128,
};

describe("LLM provider layer", () => {
  it("FakeLLMProvider satisfies the provider contract with deterministic zero-cost output", async () => {
    const provider = new FakeLLMProvider();

    const response = await provider.invoke(request);

    expect(LLMResponseSchema.parse(response)).toEqual(response);
    expect(response.provider).toBe("fake");
    expect(response.model).toBe("fake-local-deterministic");
    expect(response.content).toContain("Fake provider response");
    expect(response.content).toContain("provider contract test");
    expect(response.usage.modelCalls).toBe(1);
    expect(response.usage.estimatedUsd).toBe(0);
  });

  it("model router picks fake provider by default for local contributor mode", () => {
    const router = buildModelRouter();

    const selection = router.select({ route: "CODE_EDIT", task: "edit tests", run: baseRun });

    expect(selection.provider.metadata.id).toBe("fake");
    expect(selection.modelRoute).toBe("fake");
    expect(selection.reason).toContain("local mode");
  });

  it("model router can select Together for external mode when budget and capability allow it", () => {
    const router = buildModelRouter({ mode: "external", env: { TOGETHER_API_KEY: "test-key" } });

    const selection = router.select({ route: "RESEARCH", task: "research current options", run: baseRun });

    expect(selection.provider.metadata.id).toBe("together");
    expect(selection.modelRoute).toBe("research");
    expect(selection.model).toBe("meta-llama/Llama-3.3-70B-Instruct-Turbo");
  });

  it("budget gate denies maxModelCalls before provider invocation", async () => {
    const provider = new FakeLLMProvider();
    const spy = vi.spyOn(provider, "invoke");
    const deniedRun: Run = {
      ...baseRun,
      budget: { ...baseRun.budget, maxModelCalls: 0 },
    };

    await expect(invokeWithBudget(provider, request, deniedRun)).rejects.toMatchObject({
      code: "BUDGET_DENIED",
      provider: "fake",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("budget gate denies maxUsd before provider invocation", async () => {
    const provider = new TogetherAIProvider({ apiKey: "test-key" });
    const spy = vi.spyOn(provider, "invoke");
    const deniedRun: Run = {
      ...baseRun,
      budget: { ...baseRun.budget, maxUsd: 0 },
    };

    await expect(invokeWithBudget(provider, request, deniedRun)).rejects.toMatchObject({
      code: "BUDGET_DENIED",
      provider: "together",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("Together config validation fails cleanly when API key is missing", () => {
    const provider = new TogetherAIProvider({ apiKey: "" });

    expect(() => provider.validateConfig()).toThrow(ProviderError);
    expect(() => provider.validateConfig()).toThrow(/TOGETHER_API_KEY is required/);
  });

  it("Together request builder emits OpenAI-compatible chat shape without network", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const provider = new TogetherAIProvider({ apiKey: "test-key", baseUrl: "https://unit.test/v1" });

    const built = provider.buildRequest({
      ...request,
      model: "Qwen/Qwen2.5-Coder-7B-Instruct",
      temperature: 0.2,
      responseFormat: { type: "json_object" },
    });

    expect(built.url).toBe("https://unit.test/v1/chat/completions");
    expect(built.init.method).toBe("POST");
    expect(built.init.headers).toMatchObject({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(built.init.body))).toEqual({
      model: "Qwen/Qwen2.5-Coder-7B-Instruct",
      messages: request.messages,
      max_tokens: 128,
      temperature: 0.2,
      response_format: { type: "json_object" },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("Together live invocation is disabled unless explicitly enabled", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const provider = new TogetherAIProvider({ apiKey: "test-key", enableNetwork: false });

    await expect(provider.invoke(request)).rejects.toMatchObject({
      code: "NETWORK_DISABLED",
      provider: "together",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("invokeWithBudget happy path when allowed by budget", async () => {
    const provider = new FakeLLMProvider();
    const response = await invokeWithBudget(provider, request, baseRun);

    expect(response.provider).toBe("fake");
    expect(response.usage.estimatedUsd).toBe(0);
    expect(response.content).toContain("Fake provider response");
  });

  it("Cloudflare config validation fails cleanly when account id or token is missing", () => {
    const provider = new CloudflareWorkersAIProvider({ accountId: "", apiToken: "" });

    expect(() => provider.validateConfig()).toThrow(ProviderError);
    expect(() => provider.validateConfig()).toThrow(/CLOUDFLARE_ACCOUNT_ID is required/);
  });

  it("Cloudflare request builder emits Workers AI chat shape without network", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const provider = new CloudflareWorkersAIProvider({
      accountId: "account-123",
      apiToken: "cf-token",
      baseUrl: "https://unit.cloudflare.test/client/v4",
    });

    const built = provider.buildRequest({ ...request, modelRoute: "cheap", temperature: 0.1 });

    expect(built.url).toBe(
      "https://unit.cloudflare.test/client/v4/accounts/account-123/ai/run/@cf/meta/llama-3.1-8b-instruct"
    );
    expect(built.init.method).toBe("POST");
    expect(built.init.headers).toMatchObject({
      Authorization: "Bearer cf-token",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(built.init.body))).toEqual({
      messages: request.messages,
      max_tokens: 128,
      temperature: 0.1,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("Cloudflare live invocation is disabled unless explicitly enabled", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const provider = new CloudflareWorkersAIProvider({ accountId: "account-123", apiToken: "cf-token" });

    await expect(provider.invoke(request)).rejects.toMatchObject({
      code: "NETWORK_DISABLED",
      provider: "cloudflare",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("budget gate denies Cloudflare before external invocation", async () => {
    const provider = new CloudflareWorkersAIProvider({ accountId: "account-123", apiToken: "cf-token" });
    const spy = vi.spyOn(provider, "invoke");
    const deniedRun: Run = {
      ...baseRun,
      budget: { ...baseRun.budget, maxUsd: 0 },
    };

    await expect(invokeWithBudget(provider, request, deniedRun)).rejects.toMatchObject({
      code: "BUDGET_DENIED",
      provider: "cloudflare",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("Cloudflare provider executes mocked fetch/parse response", async () => {
    const mockJson = {
      success: true,
      result: {
        response: "Mocked Cloudflare response",
        usage: { prompt_tokens: 12, completion_tokens: 18, total_tokens: 30 },
      },
    };
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => mockJson });
    const provider = new CloudflareWorkersAIProvider({
      accountId: "account-123",
      apiToken: "cf-token",
      enableNetwork: true,
      fetchImpl: mockFetch as any,
    });

    const response = await provider.invoke({ ...request, modelRoute: "fast" });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(response.provider).toBe("cloudflare");
    expect(response.content).toBe("Mocked Cloudflare response");
    expect(response.usage.inputTokens).toBe(12);
    expect(response.usage.outputTokens).toBe(18);
    expect(response.usage.totalTokens).toBe(30);
  });

  it("Azure OpenAI config validation fails cleanly when endpoint or key is missing", () => {
    const provider = new AzureOpenAIProvider({ apiKey: "", endpoint: "" });

    expect(() => provider.validateConfig()).toThrow(ProviderError);
    expect(() => provider.validateConfig()).toThrow(/AZURE_OPENAI_API_KEY is required/);
  });

  it("Azure OpenAI request builder emits deployment chat shape without network", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const provider = new AzureOpenAIProvider({
      apiKey: "azure-key",
      endpoint: "https://unit-resource.openai.azure.com",
      apiVersion: "2025-01-01-preview",
      deployments: { flagship: "gpt-5-test" },
    });

    const built = provider.buildRequest({ ...request, modelRoute: "flagship", responseFormat: { type: "json_object" } });

    expect(built.url).toBe(
      "https://unit-resource.openai.azure.com/openai/deployments/gpt-5-test/chat/completions?api-version=2025-01-01-preview"
    );
    expect(built.init.method).toBe("POST");
    expect(built.init.headers).toMatchObject({
      "api-key": "azure-key",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(built.init.body))).toEqual({
      messages: request.messages,
      max_tokens: 128,
      response_format: { type: "json_object" },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("Azure OpenAI live invocation is disabled unless explicitly enabled", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const provider = new AzureOpenAIProvider({
      apiKey: "azure-key",
      endpoint: "https://unit-resource.openai.azure.com",
      deployments: { fast: "gpt-4o-mini-test" },
    });

    await expect(provider.invoke(request)).rejects.toMatchObject({
      code: "NETWORK_DISABLED",
      provider: "azure-openai",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("Azure OpenAI provider executes mocked fetch/parse response", async () => {
    const mockJson = {
      model: "gpt-4o-mini-test",
      choices: [{ message: { content: "Mocked Azure response" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 },
    };
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => mockJson });
    const provider = new AzureOpenAIProvider({
      apiKey: "azure-key",
      endpoint: "https://unit-resource.openai.azure.com",
      deployments: { fast: "gpt-4o-mini-test" },
      enableNetwork: true,
      fetchImpl: mockFetch as any,
    });

    const response = await provider.invoke({ ...request, modelRoute: "fast" });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(response.provider).toBe("azure-openai");
    expect(response.model).toBe("gpt-4o-mini-test");
    expect(response.content).toBe("Mocked Azure response");
    expect(response.usage.inputTokens).toBe(20);
    expect(response.usage.outputTokens).toBe(30);
  });

  it("model router assigns configured external providers by route", () => {
    const router = buildModelRouter({
      mode: "external",
      env: {
        CLOUDFLARE_ACCOUNT_ID: "account-123",
        CLOUDFLARE_API_TOKEN: "cf-token",
        AZURE_OPENAI_API_KEY: "azure-key",
        AZURE_OPENAI_ENDPOINT: "https://unit-resource.openai.azure.com",
        AZURE_OPENAI_FAST_DEPLOYMENT: "gpt-4o-mini-test",
        AZURE_OPENAI_FLAGSHIP_DEPLOYMENT: "gpt-5-test",
      },
    });

    expect(router.select({ capability: "cheap", run: baseRun }).provider.metadata.id).toBe("cloudflare");
    expect(router.select({ capability: "fast", run: baseRun }).provider.metadata.id).toBe("cloudflare");
    expect(router.select({ capability: "flagship", run: baseRun }).provider.metadata.id).toBe("azure-openai");
  });

  it("TogetherAIProvider executes mocked fetch/parse response with enableNetwork true and no real network", async () => {
    const mockJson = {
      model: "Qwen/Qwen2.5-Coder-7B-Instruct",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Mocked response content from Together AI",
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 15,
        completion_tokens: 25,
        total_tokens: 40,
      },
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockJson,
    });

    const provider = new TogetherAIProvider({
      apiKey: "mocked-api-key",
      baseUrl: "https://api.together.xyz/v1",
      enableNetwork: true,
      fetchImpl: mockFetch as any,
    });

    const response = await provider.invoke(request);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.together.xyz/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer mocked-api-key",
          "Content-Type": "application/json",
        }),
      })
    );

    expect(response.provider).toBe("together");
    expect(response.model).toBe("Qwen/Qwen2.5-Coder-7B-Instruct");
    expect(response.content).toBe("Mocked response content from Together AI");
    expect(response.finishReason).toBe("stop");
    expect(response.usage.inputTokens).toBe(15);
    expect(response.usage.outputTokens).toBe(25);
    expect(response.usage.totalTokens).toBe(40);
    expect(response.usage.modelCalls).toBe(1);
    expect(response.usage.estimatedUsd).toBeGreaterThan(0);
    expect(response.raw).toEqual(mockJson);
  });

  it("TogetherAIProvider handles HTTP 429 and throws retryable PROVIDER_HTTP_ERROR", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
    });
    const provider = new TogetherAIProvider({
      apiKey: "test-key",
      enableNetwork: true,
      fetchImpl: mockFetch as any,
    });

    await expect(provider.invoke(request)).rejects.toThrow(ProviderError);
    try {
      await provider.invoke(request);
    } catch (err: any) {
      expect(err.code).toBe("PROVIDER_HTTP_ERROR");
      expect(err.status).toBe(429);
      expect(err.retryable).toBe(true);
      expect(err.provider).toBe("together");
    }
  });

  it("TogetherAIProvider handles HTTP 500 and throws retryable PROVIDER_HTTP_ERROR", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });
    const provider = new TogetherAIProvider({
      apiKey: "test-key",
      enableNetwork: true,
      fetchImpl: mockFetch as any,
    });

    try {
      await provider.invoke(request);
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.code).toBe("PROVIDER_HTTP_ERROR");
      expect(err.status).toBe(500);
      expect(err.retryable).toBe(true);
      expect(err.provider).toBe("together");
    }
  });

  it("TogetherAIProvider handles malformed response and throws PROVIDER_RESPONSE_INVALID", async () => {
    // Return empty model name which fails LLMResponseSchema validation (model must be min(1) length)
    const mockJson = {
      model: "",
      choices: [{ message: { content: "invalid model response" } }],
    };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockJson,
    });
    const provider = new TogetherAIProvider({
      apiKey: "test-key",
      enableNetwork: true,
      fetchImpl: mockFetch as any,
    });

    try {
      await provider.invoke(request);
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.code).toBe("PROVIDER_RESPONSE_INVALID");
      expect(err.provider).toBe("together");
    }
  });

  it("CloudflareWorkersAIProvider handles HTTP 500 and throws retryable PROVIDER_HTTP_ERROR", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });
    const provider = new CloudflareWorkersAIProvider({
      accountId: "account-123",
      apiToken: "cf-token",
      enableNetwork: true,
      fetchImpl: mockFetch as any,
    });

    try {
      await provider.invoke(request);
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.code).toBe("PROVIDER_HTTP_ERROR");
      expect(err.status).toBe(500);
      expect(err.retryable).toBe(true);
      expect(err.provider).toBe("cloudflare");
    }
  });

  it("AzureOpenAIProvider handles HTTP 429 and throws retryable PROVIDER_HTTP_ERROR", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
    });
    const provider = new AzureOpenAIProvider({
      apiKey: "azure-key",
      endpoint: "https://unit-resource.openai.azure.com",
      deployments: { fast: "gpt-4o-mini-test" },
      enableNetwork: true,
      fetchImpl: mockFetch as any,
    });

    try {
      await provider.invoke({ ...request, modelRoute: "fast" });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.code).toBe("PROVIDER_HTTP_ERROR");
      expect(err.status).toBe(429);
      expect(err.retryable).toBe(true);
      expect(err.provider).toBe("azure-openai");
    }
  });

  it("AzureOpenAIProvider handles malformed response and throws PROVIDER_RESPONSE_INVALID", async () => {
    const mockJson = {
      model: "", // empty model to fail LLMResponseSchema validation
      choices: [{ message: { content: "invalid model response" } }],
    };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockJson,
    });
    const provider = new AzureOpenAIProvider({
      apiKey: "azure-key",
      endpoint: "https://unit-resource.openai.azure.com",
      deployments: { fast: "gpt-4o-mini-test" },
      enableNetwork: true,
      fetchImpl: mockFetch as any,
    });

    try {
      await provider.invoke({ ...request, modelRoute: "fast" });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.code).toBe("PROVIDER_RESPONSE_INVALID");
      expect(err.provider).toBe("azure-openai");
    }
  });
});
