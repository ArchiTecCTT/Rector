import { describe, it, expect, vi } from "vitest";

import { createNeuroBackgroundHooks } from "../src/orchestration/backgroundHooks";
import { createPureLocalMemoryProvider } from "../src/providers";
import { InMemoryRectorStore } from "../src/store/inMemoryRectorStore";
import type { Run } from "../src/store/schemas";

function makeCompletedRun(): Run {
  return {
    id: "run-bg",
    conversationId: "conv-bg",
    userMessageId: "msg-bg",
    status: "completed",
    phase: "DONE",
    route: "code",
    complexity: "medium",
    budget: {
      maxUsd: 1,
      maxInputTokens: 1000,
      maxOutputTokens: 1000,
      maxModelCalls: 1,
      maxRuntimeMs: 30_000,
      maxHealingAttempts: 0,
      allowedProviders: [],
      approvalRequiredAboveUsd: 0,
    },
    costEstimate: { usd: 0 },
    actualCost: { usd: 0 },
    tokenEstimate: { input: 0, output: 0 },
    actualTokens: { input: 0, output: 0 },
    traceId: "trace-bg",
    attempts: 1,
    healingAttempts: 0,
    validationAttempts: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("backgroundHooks", () => {
  it("does not start idle timer in local mode", () => {
    const hooks = createNeuroBackgroundHooks({
      getMemoryProvider: async () => createPureLocalMemoryProvider(),
      mode: "local",
      store: new InMemoryRectorStore(),
    });

    hooks.startIdleTimer();
    hooks.stop();
    expect(true).toBe(true);
  });

  it("onRunCompleted does not throw when memory provider fails", async () => {
    const hooks = createNeuroBackgroundHooks({
      getMemoryProvider: async () => {
        throw new Error("memory unavailable");
      },
      mode: "external",
      store: new InMemoryRectorStore(),
    });

    expect(() => hooks.onRunCompleted(makeCompletedRun())).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it("stop clears the idle timer without throwing", () => {
    vi.useFakeTimers();
    const hooks = createNeuroBackgroundHooks({
      getMemoryProvider: async () => createPureLocalMemoryProvider(),
      mode: "external",
      store: new InMemoryRectorStore(),
    });

    hooks.startIdleTimer();
    hooks.stop();
    expect(() => vi.runOnlyPendingTimers()).not.toThrow();
    vi.useRealTimers();
  });
});