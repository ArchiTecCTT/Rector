import { describe, expect, it, vi } from "vitest";
import type { Run } from "../src/store";
import {
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
    allowedProviders: ["fake", "together"],
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
});
