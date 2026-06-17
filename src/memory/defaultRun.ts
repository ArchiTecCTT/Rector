import type { Budget, Run } from "../store/schemas";

/** Permissive default budget used when no active run context is available. */
export const DEFAULT_MEMORY_BUDGET: Budget = {
  maxUsd: 10,
  maxInputTokens: 500_000,
  maxOutputTokens: 500_000,
  maxModelCalls: 1_000,
  maxRuntimeMs: 3_600_000,
  maxHealingAttempts: 10,
  allowedProviders: [],
  approvalRequiredAboveUsd: 1,
};

/** A minimal run shell for memory-provider budget preflight when no live run exists. */
export function defaultMemoryBudgetRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "memory-budget-run",
    conversationId: "memory-budget-conv",
    userMessageId: "memory-budget-msg",
    status: "running",
    phase: "TRIAGE",
    route: "local",
    complexity: "simple",
    budget: DEFAULT_MEMORY_BUDGET,
    costEstimate: { usd: 0 },
    tokenEstimate: { input: 0, output: 0 },
    traceId: "memory-budget-trace",
    attempts: 1,
    healingAttempts: 0,
    validationAttempts: 0,
    version: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}