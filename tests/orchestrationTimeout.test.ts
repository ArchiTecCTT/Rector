import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_MAX_ORCHESTRATION_RUNTIME_MS,
  runOrchestratedChatRun,
  type ChatRunArgs,
  type ChatRunnerDeps,
} from "../src/orchestration/chatRunner";
import { InMemoryRectorStore } from "../src/store/inMemoryRectorStore";
import { RuntimeSettingsSchema } from "../src/config/runtimeSettings";
import { createInMemoryObservabilityTrace } from "../src/observability";
import type { LLMInvokeOptions, LLMProvider, LLMRequest, LLMResponse, LLMUsage, ModelRouter, ModelSelection } from "../src/providers/llm";
import { PlannerOutputSchema } from "../src/orchestration/planner";
import {
  makeContextPack,
  SpyLLMProvider,
  DEFAULT_SPY_USAGE,
} from "./support/byokArbitraries";
import { triageUserMessage } from "../src/orchestration/triage";

// ---------------------------------------------------------------------------
// Shared spy plan (same pattern as chatRunner.test.ts)
// ---------------------------------------------------------------------------

const SPY_PIPELINE_PLAN = PlannerOutputSchema.parse({
  goal: "Answer the user question from available conversation context",
  assumptions: ["User expects a concise synthesis, not changes."],
  tasks: [
    {
      id: "answer.synthesize",
      title: "Synthesize direct answer",
      description: "Use available conversation context to produce a concise response.",
      dependencies: [],
      expectedArtifacts: ["Assistant answer"],
      validation: ["Answer addresses the stated question"],
      risk: "low",
      approvalRequired: false,
    },
  ],
  dependencies: [],
  validation: { summary: "Direct answer plan stays non-executing", checks: ["Confirm response is grounded in context"] },
  riskLevel: "low",
  approvalGates: [],
});

// ---------------------------------------------------------------------------
// Slow provider — invoke() observes the abort signal and rejects with AbortError
// ---------------------------------------------------------------------------

function makeAbortAwareSlowProvider(): LLMProvider {
  return {
    metadata: {
      id: "slow-provider",
      kind: "together-ai",
      models: { flagship: "test-flagship", cheap: "test-cheap" },
    },
    validateConfig() {},
    estimateRequest(): LLMUsage {
      return DEFAULT_SPY_USAGE;
    },
    invoke(_request: LLMRequest, options?: LLMInvokeOptions): Promise<LLMResponse> {
      return new Promise((_resolve, reject) => {
        const signal = options?.abortSignal;
        if (signal?.aborted) {
          reject(new DOMException("The operation was aborted", "AbortError"));
          return;
        }
        const onAbort = () => {
          reject(new DOMException("The operation was aborted", "AbortError"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore(): InMemoryRectorStore {
  return new InMemoryRectorStore();
}

async function buildArgs(store: InMemoryRectorStore, options?: { maxRuntimeMs?: number }): Promise<ChatRunArgs> {
  const prompt = "test prompt for timeout";
  const triage = triageUserMessage(prompt);
  const contextPack = makeContextPack(triage, prompt);

  const conversation = await store.createConversation({
    title: "timeout-test",
    workspaceId: "local",
    retentionPolicy: "session",
  });
  const userMessage = await store.createMessage({
    conversationId: conversation.id,
    role: "user",
    content: prompt,
    status: "created",
    redactionState: "none",
  });

  const observability = createInMemoryObservabilityTrace();

  return {
    conversationId: conversation.id,
    userMessageId: userMessage.id,
    prompt,
    triage,
    contextPack,
    observability,
    options: {
      ...(options?.maxRuntimeMs ? { maxRuntimeMs: options.maxRuntimeMs } : {}),
    },
  };
}

function makeSlowRouter(): ModelRouter {
  const provider = makeAbortAwareSlowProvider();
  return {
    select(): ModelSelection {
      return {
        provider,
        modelRoute: "flagship",
        model: provider.metadata.models.flagship,
        reason: "slow router for timeout test",
      };
    },
  };
}

function makeNormalRouter(): ModelRouter {
  const provider = new SpyLLMProvider({
    estimate: DEFAULT_SPY_USAGE,
    responses: [
      { content: JSON.stringify(SPY_PIPELINE_PLAN), usage: DEFAULT_SPY_USAGE },
    ],
  });
  return {
    select(): ModelSelection {
      return {
        provider,
        modelRoute: "flagship",
        model: provider.metadata.models.flagship,
        reason: "normal spy router for timeout test",
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("M23 — Orchestration timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- Constant & schema tests ---

  it("exports DEFAULT_MAX_ORCHESTRATION_RUNTIME_MS as 30 minutes", () => {
    expect(DEFAULT_MAX_ORCHESTRATION_RUNTIME_MS).toBe(30 * 60 * 1000);
    expect(DEFAULT_MAX_ORCHESTRATION_RUNTIME_MS).toBe(1_800_000);
  });

  it("runtime settings schema includes orchestration.maxRuntimeMs with the same default", () => {
    const settings = RuntimeSettingsSchema.parse({
      schemaVersion: "rector.runtime.v1",
      orchestrationProfile: "unconfigured",
      requireProvidersForChat: true,
      updatedAt: new Date().toISOString(),
    });
    expect(settings.orchestration.maxRuntimeMs).toBe(DEFAULT_MAX_ORCHESTRATION_RUNTIME_MS);
  });

  it("runtime settings schema accepts custom maxRuntimeMs", () => {
    const settings = RuntimeSettingsSchema.parse({
      schemaVersion: "rector.runtime.v1",
      orchestrationProfile: "configured",
      requireProvidersForChat: true,
      updatedAt: new Date().toISOString(),
      orchestration: { maxRuntimeMs: 60_000 },
    });
    expect(settings.orchestration.maxRuntimeMs).toBe(60_000);
  });

  it("runtime settings schema rejects negative maxRuntimeMs", () => {
    const result = RuntimeSettingsSchema.safeParse({
      schemaVersion: "rector.runtime.v1",
      orchestrationProfile: "configured",
      requireProvidersForChat: true,
      updatedAt: new Date().toISOString(),
      orchestration: { maxRuntimeMs: -1 },
    });
    expect(result.success).toBe(false);
  });

  it("runtime settings schema rejects non-integer maxRuntimeMs", () => {
    const result = RuntimeSettingsSchema.safeParse({
      schemaVersion: "rector.runtime.v1",
      orchestrationProfile: "configured",
      requireProvidersForChat: true,
      updatedAt: new Date().toISOString(),
      orchestration: { maxRuntimeMs: 1.5 },
    });
    expect(result.success).toBe(false);
  });

  // --- Timeout behavior tests ---

  it("transitions run to FAILED on timeout with slow provider", async () => {
    const store = makeStore();
    const args = await buildArgs(store, { maxRuntimeMs: 50 });
    const deps: ChatRunnerDeps = {
      router: makeSlowRouter(),
    };

    const promise = runOrchestratedChatRun(store, args, deps);

    // Advance timers past the timeout — this triggers the AbortController abort
    await vi.advanceTimersByTimeAsync(100);

    const result = await promise;
    expect(result.synthesis.status).toBe("FAILED");
    expect(result.synthesis.response).toContain("Orchestration timeout exceeded");

    // The run should be in failed status
    const run = await store.getRun(result.run.id);
    expect(run?.status).toBe("failed");
  });

  it("timeout error message includes maxRuntimeMs value", async () => {
    const customMs = 99;
    const store = makeStore();
    const args = await buildArgs(store, { maxRuntimeMs: customMs });
    const deps: ChatRunnerDeps = {
      router: makeSlowRouter(),
    };

    const promise = runOrchestratedChatRun(store, args, deps);
    await vi.advanceTimersByTimeAsync(customMs + 50);

    const result = await promise;
    expect(result.synthesis.status).toBe("FAILED");
    expect(result.synthesis.response).toContain(`${customMs}ms`);
  });

  it("clears timeout timer on successful completion (no spurious timeout)", async () => {
    const store = makeStore();
    const args = await buildArgs(store, { maxRuntimeMs: 50_000 });
    const deps: ChatRunnerDeps = {
      router: makeNormalRouter(),
    };

    // Should complete normally (no timeout) — the spy router returns immediately
    const result = await runOrchestratedChatRun(store, args, deps);
    expect(result).toBeDefined();

    // Advance timers well past the timeout — no error should occur since timer was cleared
    await vi.advanceTimersByTimeAsync(60_000);
  });
});
