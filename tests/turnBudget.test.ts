import { describe, expect, it } from "vitest";

import { IterationBudget, TurnBudgetConfigSchema } from "../src/orchestration/turnBudget";

describe("turn budget", () => {
  it("parses configured defaults", () => {
    expect(TurnBudgetConfigSchema.parse({})).toEqual({
      maxIterations: 40,
      maxToolCalls: 80,
      graceCallOnExhaustion: true,
    });
  });

  it("consumeToolCall decrements until exhausted", () => {
    const budget = new IterationBudget({ maxToolCalls: 2 });

    expect(budget.consumeToolCall()).toBe(true);
    expect(budget.toolCallsRemaining).toBe(1);
    expect(budget.consumeToolCall()).toBe(true);
    expect(budget.toolCallsRemaining).toBe(0);
    expect(budget.consumeToolCall()).toBe(false);
    expect(budget.snapshot()).toMatchObject({
      toolCallsUsed: 2,
      toolCallsRemaining: 0,
    });
  });

  it("grantGraceCall allows exactly one exhausted iteration when enabled", () => {
    const budget = new IterationBudget({ maxIterations: 1, graceCallOnExhaustion: true });

    expect(budget.consumeIteration()).toBe(true);
    expect(budget.consumeIteration()).toBe(false);

    budget.grantGraceCall();

    expect(budget.consumeIteration()).toBe(true);
    expect(budget.consumeIteration()).toBe(false);
    expect(budget.snapshot()).toMatchObject({
      iterationsUsed: 1,
      iterationsRemaining: 0,
      graceCallAvailable: false,
      graceCallUsed: true,
    });
  });

  it("does not grant a grace iteration when disabled", () => {
    const budget = new IterationBudget({ maxIterations: 1, graceCallOnExhaustion: false });

    expect(budget.consumeIteration()).toBe(true);
    budget.grantGraceCall();

    expect(budget.consumeIteration()).toBe(false);
    expect(budget.graceCallAvailable).toBe(false);
  });
});
