import { describe, it, expect, vi } from "vitest";
import {
  callWithResilience,
  type CallWithResilienceInput,
  ProviderResilienceError,
} from "../src/providers/failover";
import { ProviderError, type ModelSelection, type LLMProvider, type LLMResponse } from "../src/providers/llm";
import { TurnRetryState } from "../src/providers/turnRetryState";

/** Minimal ModelSelection double. */
function mockSelection(providerId: string, invokeResult?: LLMResponse, invokeError?: Error): ModelSelection {
  const provider: LLMProvider = {
    metadata: {
      id: providerId,
      models: { default: "model-a" } as Record<string, string>,
      modelRoute: "default" as const,
    },
    validateConfig: vi.fn(),
    estimateRequest: vi.fn().mockReturnValue({ estimatedUsd: 0.001, inputTokens: 100, outputTokens: 100 }),
    invoke: invokeError
      ? vi.fn().mockRejectedValue(invokeError)
      : vi.fn().mockResolvedValue(invokeResult ?? { content: "ok", usage: { inputTokens: 0, outputTokens: 0 } }),
  };
  return { provider, providerId, model: "model-a" };
}

function make429Error(provider: string): ProviderError {
  return new ProviderError({
    code: "PROVIDER_HTTP_ERROR",
    provider,
    status: 429,
    retryable: true,
    message: "Rate limited",
  });
}

function makeAuthError(provider: string): ProviderError {
  return new ProviderError({
    code: "PROVIDER_HTTP_ERROR",
    provider,
    status: 401,
    retryable: false,
    message: "Unauthorized",
  });
}

function makeGenericError(provider: string): ProviderError {
  return new ProviderError({
    code: "PROVIDER_HTTP_ERROR",
    provider,
    status: 500,
    retryable: true,
    message: "Internal error",
  });
}

describe("resilience retry budget check", () => {
  it("skips 429 retry when budgetPreflight returns false", async () => {
    const retryState = new TurnRetryState();
    const error = make429Error("provider-a");
    let invokeCount = 0;
    const selection = {
      ...mockSelection("provider-a"),
      provider: {
        ...mockSelection("provider-a").provider,
        invoke: vi.fn().mockImplementation(() => {
          invokeCount++;
          if (invokeCount === 1) throw error;
          return Promise.resolve({ content: "retried", usage: { inputTokens: 0, outputTokens: 0 } });
        }),
      },
    };

    const result = callWithResilience({
      site: "planner",
      primary: selection,
      retryState,
      budgetPreflight: () => Promise.resolve(false),
      invoke: async (s) => s.provider.invoke({ model: s.model } as any),
    });

    await expect(result).rejects.toThrow(ProviderResilienceError);
    expect(invokeCount).toBe(1); // retry was skipped
  });

  it("proceeds with 429 retry when budgetPreflight returns true", async () => {
    const retryState = new TurnRetryState();
    const error = make429Error("provider-a");
    let invokeCount = 0;
    const selection = {
      ...mockSelection("provider-a"),
      provider: {
        ...mockSelection("provider-a").provider,
        invoke: vi.fn().mockImplementation(() => {
          invokeCount++;
          if (invokeCount === 1) throw error;
          return Promise.resolve({ content: "retried", usage: { inputTokens: 0, outputTokens: 0 } });
        }),
      },
    };

    const result = await callWithResilience({
      site: "planner",
      primary: selection,
      retryState,
      retryDelayMs: 0,
      budgetPreflight: () => Promise.resolve(true),
      invoke: async (s) => s.provider.invoke({ model: s.model } as any),
    });

    expect(result.result).toEqual({ content: "retried", usage: { inputTokens: 0, outputTokens: 0 } });
    expect(invokeCount).toBe(2); // initial + retry
  });

  it("skips auth retry when budgetPreflight returns false", async () => {
    const retryState = new TurnRetryState();
    const error = makeAuthError("provider-a");
    let invokeCount = 0;
    const selection = {
      ...mockSelection("provider-a"),
      provider: {
        ...mockSelection("provider-a").provider,
        invoke: vi.fn().mockImplementation(() => {
          invokeCount++;
          if (invokeCount === 1) throw error;
          return Promise.resolve({ content: "retried", usage: { inputTokens: 0, outputTokens: 0 } });
        }),
      },
    };

    const result = callWithResilience({
      site: "planner",
      primary: selection,
      retryState,
      budgetPreflight: () => Promise.resolve(false),
      invoke: async (s) => s.provider.invoke({ model: s.model } as any),
    });

    await expect(result).rejects.toThrow(ProviderResilienceError);
    expect(invokeCount).toBe(1); // auth retry was skipped
  });

  it("skips fallback when budgetPreflight returns false", async () => {
    const retryState = new TurnRetryState();
    const error = makeGenericError("provider-a");
    let primaryInvokeCount = 0;
    let fallbackInvokeCount = 0;

    const primarySelection = {
      ...mockSelection("provider-a"),
      provider: {
        ...mockSelection("provider-a").provider,
        invoke: vi.fn().mockImplementation(() => {
          primaryInvokeCount++;
          throw error;
        }),
      },
    };
    const fallbackSelection = {
      ...mockSelection("provider-b"),
      provider: {
        ...mockSelection("provider-b").provider,
        invoke: vi.fn().mockImplementation(() => {
          fallbackInvokeCount++;
          return Promise.resolve({ content: "fallback", usage: { inputTokens: 0, outputTokens: 0 } });
        }),
      },
    };

    const result = callWithResilience({
      site: "planner",
      primary: primarySelection,
      fallback: fallbackSelection,
      retryState,
      budgetPreflight: () => Promise.resolve(false),
      invoke: async (s) => s.provider.invoke({ model: s.model } as any),
    });

    await expect(result).rejects.toThrow(ProviderResilienceError);
    expect(primaryInvokeCount).toBe(1);
    expect(fallbackInvokeCount).toBe(0); // fallback skipped
  });

  it("proceeds with fallback when budgetPreflight returns true", async () => {
    const retryState = new TurnRetryState();
    const error = makeGenericError("provider-a");

    const primarySelection = {
      ...mockSelection("provider-a"),
      provider: {
        ...mockSelection("provider-a").provider,
        invoke: vi.fn().mockRejectedValue(error),
      },
    };
    const fallbackSelection = {
      ...mockSelection("provider-b"),
      provider: {
        ...mockSelection("provider-b").provider,
        invoke: vi.fn().mockResolvedValue({ content: "fallback", usage: { inputTokens: 0, outputTokens: 0 } }),
      },
    };

    const result = await callWithResilience({
      site: "planner",
      primary: primarySelection,
      fallback: fallbackSelection,
      retryState,
      budgetPreflight: () => Promise.resolve(true),
      invoke: async (s) => s.provider.invoke({ model: s.model } as any),
    });

    expect(result.result).toEqual({ content: "fallback", usage: { inputTokens: 0, outputTokens: 0 } });
    expect(result.substituted).toBe(true);
  });

  it("works without budgetPreflight (backward compat)", async () => {
    const retryState = new TurnRetryState();
    const selection = mockSelection("provider-a");
    const response = { content: "ok", usage: { inputTokens: 0, outputTokens: 0 } };
    (selection.provider as any).invoke = vi.fn().mockResolvedValue(response);

    const result = await callWithResilience({
      site: "planner",
      primary: selection,
      retryState,
      invoke: async (s) => s.provider.invoke({ model: s.model } as any),
    });

    expect(result.result).toEqual(response);
  });

  it("budgetPreflight is called before 429 retry attempt", async () => {
    const retryState = new TurnRetryState();
    const error = make429Error("provider-a");
    let invokeCount = 0;
    const budgetCalls: string[] = [];

    const selection = {
      ...mockSelection("provider-a"),
      provider: {
        ...mockSelection("provider-a").provider,
        invoke: vi.fn().mockImplementation(() => {
          invokeCount++;
          if (invokeCount === 1) throw error;
          return Promise.resolve({ content: "retried", usage: { inputTokens: 0, outputTokens: 0 } });
        }),
      },
    };

    await callWithResilience({
      site: "planner",
      primary: selection,
      retryState,
      retryDelayMs: 0,
      budgetPreflight: async () => {
        budgetCalls.push("429");
        return true;
      },
      invoke: async (s) => s.provider.invoke({ model: s.model } as any),
    });

    expect(budgetCalls).toEqual(["429"]);
  });

  it("budgetPreflight is called before fallback attempt", async () => {
    const retryState = new TurnRetryState();
    const error = makeGenericError("provider-a");
    const budgetCalls: string[] = [];

    const primarySelection = {
      ...mockSelection("provider-a"),
      provider: {
        ...mockSelection("provider-a").provider,
        invoke: vi.fn().mockRejectedValue(error),
      },
    };
    const fallbackSelection = {
      ...mockSelection("provider-b"),
      provider: {
        ...mockSelection("provider-b").provider,
        invoke: vi.fn().mockResolvedValue({ content: "fallback", usage: { inputTokens: 0, outputTokens: 0 } }),
      },
    };

    await callWithResilience({
      site: "planner",
      primary: primarySelection,
      fallback: fallbackSelection,
      retryState,
      budgetPreflight: async () => {
        budgetCalls.push("fallback");
        return true;
      },
      invoke: async (s) => s.provider.invoke({ model: s.model } as any),
    });

    expect(budgetCalls).toEqual(["fallback"]);
  });

  it("error from budgetPreflight propagates", async () => {
    const retryState = new TurnRetryState();
    const error = make429Error("provider-a");
    let invokeCount = 0;

    const selection = {
      ...mockSelection("provider-a"),
      provider: {
        ...mockSelection("provider-a").provider,
        invoke: vi.fn().mockImplementation(() => {
          invokeCount++;
          if (invokeCount === 1) throw error;
          return Promise.resolve({ content: "retried", usage: { inputTokens: 0, outputTokens: 0 } });
        }),
      },
    };

    await expect(
      callWithResilience({
        site: "planner",
        primary: selection,
        retryState,
        budgetPreflight: async () => {
          throw new Error("Budget check failed");
        },
        invoke: async (s) => s.provider.invoke({ model: s.model } as any),
      }),
    ).rejects.toThrow("Budget check failed");
  });
});
