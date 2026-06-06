import { describe, expect, it } from "vitest";
import {
  ConversationCostAggregateSchema,
  RunCostAggregateSchema,
  aggregateConversationCost,
  aggregateRunCost,
} from "../src/observability";
import { enforceMaxPerRunBudget } from "../src/security/budget";
import type { Budget, Run, RunEvent } from "../src/store/schemas";

/**
 * Unit tests for cost-aggregation edge cases and the budget `allowed` boundary (task 10.5).
 *
 * These are example-based companions to the property tests in `costTracking.test.ts`
 * (aggregation correctness) and `costTracking.budget.test.ts` (budget enforcement). They pin the two
 * acceptance criteria that the folds/gate must honor at their boundaries:
 *
 *   - Requirement 3.8: a run event with NO `providerCall`, or with `providerCall` but no `usage`, or
 *     with partial/invalid usage fields, contributes 0 for the missing parts and the resulting
 *     aggregate is still schema-valid (the fold never raises).
 *   - Requirement 3.9: `enforceMaxPerRunBudget` ALLOWS when the projected totals are EXACTLY EQUAL to
 *     the ceilings (`<=`), i.e. projectedUsd == budget.maxUsd and projectedModelCalls ==
 *     budget.maxModelCalls.
 *
 * Pure + offline: events/runs are synthesized in memory; no store, no provider, no network, no API
 * key.
 *
 * Validates: Requirements 3.8, 3.9
 */

// --- Minimal valid entity builders (reuse the shapes used by the sibling cost tests) -------------

const EVENT_BASE = Date.parse("2026-01-01T00:00:00.000Z");

/**
 * Build one valid `RunEvent` with the given free-form payload. `payload` is the only thing that
 * varies across the edge cases below — every other field is a constant valid value.
 */
function buildEvent(runId: string, index: number, payload: Record<string, unknown>): RunEvent {
  return {
    id: `evt-${runId}-${index}`,
    runId,
    type: "PHASE_CHANGED",
    phase: "PLANNING",
    traceId: `trace-${runId}`,
    payload,
    createdAt: new Date(EVENT_BASE + index * 1000).toISOString(),
  };
}

function makeBudget(maxUsd: number, maxModelCalls: number): Budget {
  return {
    maxUsd,
    maxModelCalls,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 1_000_000,
    maxRuntimeMs: 60_000_000,
    maxHealingAttempts: 1_000,
    allowedProviders: [],
    approvalRequiredAboveUsd: 0,
  };
}

function makeRun(budget: Budget): Run {
  return {
    id: "run-1",
    conversationId: "conv-1",
    userMessageId: "msg-1",
    status: "running",
    phase: "TRIAGE",
    route: "local",
    complexity: "simple",
    budget,
    costEstimate: { usd: 0 },
    tokenEstimate: { input: 0, output: 0 },
    traceId: "trace-1",
    attempts: 0,
    healingAttempts: 0,
    validationAttempts: 0,
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
  };
}

// --- Requirement 3.8: missing / partial / invalid usage contributes 0 and never raises ----------

describe("aggregateRunCost — missing/partial usage edge cases (Requirement 3.8)", () => {
  const runId = "run-edge";

  it("treats an event with NO providerCall as a zero contribution and returns a schema-valid aggregate", () => {
    const events = [buildEvent(runId, 0, { note: "local-mode transition" })];

    const aggregate = aggregateRunCost(runId, events);

    // Does not raise + is schema-valid.
    expect(() => RunCostAggregateSchema.parse(aggregate)).not.toThrow();
    expect(aggregate).toEqual({
      runId,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedUsd: 0,
      modelCalls: 0,
      providers: [],
      models: [],
    });
  });

  it("treats a providerCall with NO usage as a zero contribution (provider/model still ignored for totals)", () => {
    const events = [
      buildEvent(runId, 0, { providerCall: { provider: "openai", model: "gpt-4o" } }),
    ];

    const aggregate = aggregateRunCost(runId, events);

    expect(() => RunCostAggregateSchema.parse(aggregate)).not.toThrow();
    // No usage => all numeric totals are zero, but the non-secret provider/model ids are collected.
    expect(aggregate.inputTokens).toBe(0);
    expect(aggregate.outputTokens).toBe(0);
    expect(aggregate.totalTokens).toBe(0);
    expect(aggregate.estimatedUsd).toBe(0);
    expect(aggregate.modelCalls).toBe(0);
    expect(aggregate.providers).toEqual(["openai"]);
    expect(aggregate.models).toEqual(["gpt-4o"]);
  });

  it("sums only the present usage field when usage is partial (only inputTokens)", () => {
    const events = [
      buildEvent(runId, 0, {
        providerCall: { provider: "openai", model: "gpt-4o", usage: { inputTokens: 100 } },
      }),
    ];

    const aggregate = aggregateRunCost(runId, events);

    expect(() => RunCostAggregateSchema.parse(aggregate)).not.toThrow();
    expect(aggregate.inputTokens).toBe(100);
    // Absent outputTokens/estimatedUsd/modelCalls all contribute 0.
    expect(aggregate.outputTokens).toBe(0);
    expect(aggregate.totalTokens).toBe(100);
    expect(aggregate.estimatedUsd).toBe(0);
    expect(aggregate.modelCalls).toBe(0);
  });

  it("treats non-number and negative usage fields as 0 without raising", () => {
    const events = [
      buildEvent(runId, 0, {
        providerCall: {
          provider: "openai",
          model: "gpt-4o",
          usage: {
            inputTokens: "not-a-number",
            outputTokens: -50,
            estimatedUsd: -1.25,
            modelCalls: Number.NaN,
          },
        },
      }),
    ];

    const aggregate = aggregateRunCost(runId, events);

    expect(() => RunCostAggregateSchema.parse(aggregate)).not.toThrow();
    expect(aggregate).toEqual({
      runId,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedUsd: 0,
      modelCalls: 0,
      providers: ["openai"],
      models: ["gpt-4o"],
    });
  });

  it("mixes a valid call with missing/partial-usage events and only counts the present contributions", () => {
    const events = [
      buildEvent(runId, 0, { note: "no providerCall" }),
      buildEvent(runId, 1, { providerCall: { provider: "anthropic", model: "claude-3-5" } }),
      buildEvent(runId, 2, {
        providerCall: {
          provider: "openai",
          model: "gpt-4o",
          usage: { inputTokens: 10, outputTokens: 5, estimatedUsd: 0.02, modelCalls: 1 },
        },
      }),
      buildEvent(runId, 3, {
        providerCall: { provider: "openai", model: "gpt-4o", usage: { outputTokens: 7 } },
      }),
    ];

    const aggregate = aggregateRunCost(runId, events);

    expect(() => RunCostAggregateSchema.parse(aggregate)).not.toThrow();
    expect(aggregate.inputTokens).toBe(10);
    expect(aggregate.outputTokens).toBe(12); // 5 + 7
    expect(aggregate.totalTokens).toBe(22);
    expect(aggregate.estimatedUsd).toBeCloseTo(0.02, 6);
    expect(aggregate.modelCalls).toBe(1);
    expect(aggregate.providers).toEqual(["anthropic", "openai"]);
    expect(aggregate.models).toEqual(["claude-3-5", "gpt-4o"]);
  });

  it("returns an all-zero, schema-valid conversation aggregate when every run's events lack usage", () => {
    const runs: Run[] = [
      { id: "run-a" } as unknown as Run,
      { id: "run-b" } as unknown as Run,
    ];
    const eventsByRun = new Map<string, RunEvent[]>([
      ["run-a", [buildEvent("run-a", 0, { note: "no providerCall" })]],
      ["run-b", [buildEvent("run-b", 0, { providerCall: { provider: "openai", model: "gpt-4o" } })]],
    ]);

    const conversation = aggregateConversationCost("conv-edge", runs, eventsByRun);

    expect(() => ConversationCostAggregateSchema.parse(conversation)).not.toThrow();
    expect(conversation.runCount).toBe(2);
    expect(conversation.inputTokens).toBe(0);
    expect(conversation.outputTokens).toBe(0);
    expect(conversation.totalTokens).toBe(0);
    expect(conversation.estimatedUsd).toBe(0);
    expect(conversation.modelCalls).toBe(0);
    expect(conversation.runs).toHaveLength(2);
    expect(conversation.runs.every((run) => run.totalTokens === 0 && run.estimatedUsd === 0)).toBe(true);
  });
});

// --- Requirement 3.9: the `allowed` boundary (projected totals EXACTLY EQUAL the ceilings) --------

describe("enforceMaxPerRunBudget — allowed boundary (Requirement 3.9)", () => {
  it("ALLOWS when projectedUsd == budget.maxUsd AND projectedModelCalls == budget.maxModelCalls", () => {
    const run = makeRun(makeBudget(10, 4));

    // accumulated + next == ceiling exactly on BOTH dimensions: 6 + 4 == 10 usd, 1 + 3 == 4 calls.
    const decision = enforceMaxPerRunBudget(
      run,
      { estimatedUsd: 6, modelCalls: 1 },
      { estimatedUsd: 4, modelCalls: 3 },
    );

    expect(decision.status).toBe("allowed");
    expect(decision.reasons).toEqual([]);
  });

  it("ALLOWS when the projected usd total exactly equals maxUsd and model calls are under the ceiling", () => {
    const run = makeRun(makeBudget(10, 50));

    const decision = enforceMaxPerRunBudget(
      run,
      { estimatedUsd: 7, modelCalls: 1 },
      { estimatedUsd: 3, modelCalls: 1 },
    );

    expect(decision.status).toBe("allowed");
    expect(decision.usage.estimatedUsd).toBe(10);
  });

  it("ALLOWS when the projected model-call total exactly equals maxModelCalls and usd is under the ceiling", () => {
    const run = makeRun(makeBudget(100, 4));

    const decision = enforceMaxPerRunBudget(
      run,
      { estimatedUsd: 1, modelCalls: 2 },
      { estimatedUsd: 1, modelCalls: 2 },
    );

    expect(decision.status).toBe("allowed");
    expect(decision.usage.modelCalls).toBe(4);
  });

  it("ALLOWS the zero/zero boundary (no accumulated cost, no next estimate, zero ceilings)", () => {
    const run = makeRun(makeBudget(0, 0));

    const decision = enforceMaxPerRunBudget(run, {}, {});

    expect(decision.status).toBe("allowed");
    expect(decision.usage.estimatedUsd).toBe(0);
    expect(decision.usage.modelCalls).toBe(0);
  });
});
