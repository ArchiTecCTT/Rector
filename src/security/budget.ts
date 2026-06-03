import type { Budget, Run } from "../store/schemas";

export type BudgetDecisionStatus = "allowed" | "NEEDS_DECISION" | "denied";

export interface BudgetUsage {
  estimatedUsd?: number;
  actualUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  modelCalls?: number;
  runtimeMs?: number;
  healingAttempts?: number;
  provider?: string;
}

export interface BudgetDecision {
  status: BudgetDecisionStatus;
  reasons: string[];
  usage: Required<Omit<BudgetUsage, "provider">> & { provider?: string };
}

export function evaluateBudget(run: Run, usage: BudgetUsage = {}): BudgetDecision {
  const budget = run.budget;
  const normalized = normalizeUsage(run, usage);
  const deniedReasons = hardLimitReasons(budget, normalized);

  if (deniedReasons.length > 0) {
    return { status: "denied", reasons: deniedReasons, usage: normalized };
  }

  const approvalReasons = approvalReasonsFor(budget, normalized);
  if (approvalReasons.length > 0) {
    return { status: "NEEDS_DECISION", reasons: approvalReasons, usage: normalized };
  }

  return { status: "allowed", reasons: [], usage: normalized };
}

function normalizeUsage(run: Run, usage: BudgetUsage): BudgetDecision["usage"] {
  return {
    estimatedUsd: numberFrom(usage.estimatedUsd, run.costEstimate.usd, 0),
    actualUsd: numberFrom(usage.actualUsd, run.actualCost?.usd, 0),
    inputTokens: intFrom(usage.inputTokens, run.actualTokens?.input, run.tokenEstimate.input, 0),
    outputTokens: intFrom(usage.outputTokens, run.actualTokens?.output, run.tokenEstimate.output, 0),
    modelCalls: intFrom(usage.modelCalls, run.actualCost?.modelCalls, run.costEstimate.modelCalls, 0),
    runtimeMs: intFrom(usage.runtimeMs, run.actualCost?.runtimeMs, run.costEstimate.runtimeMs, 0),
    healingAttempts: intFrom(usage.healingAttempts, run.healingAttempts, 0),
    provider: usage.provider ?? stringFrom(run.actualCost?.provider, run.costEstimate.provider),
  };
}

function hardLimitReasons(budget: Budget, usage: BudgetDecision["usage"]): string[] {
  const reasons: string[] = [];
  const cost = usage.actualUsd > 0 ? usage.actualUsd : usage.estimatedUsd;

  if (cost > budget.maxUsd) reasons.push(`estimated cost ${cost} exceeds maxUsd ${budget.maxUsd}`);
  if (usage.inputTokens > budget.maxInputTokens) {
    reasons.push(`input tokens ${usage.inputTokens} exceed maxInputTokens ${budget.maxInputTokens}`);
  }
  if (usage.outputTokens > budget.maxOutputTokens) {
    reasons.push(`output tokens ${usage.outputTokens} exceed maxOutputTokens ${budget.maxOutputTokens}`);
  }
  if (usage.modelCalls > budget.maxModelCalls) {
    reasons.push(`model calls ${usage.modelCalls} exceed maxModelCalls ${budget.maxModelCalls}`);
  }
  if (usage.runtimeMs > budget.maxRuntimeMs) {
    reasons.push(`runtime ${usage.runtimeMs}ms exceeds maxRuntimeMs ${budget.maxRuntimeMs}ms`);
  }
  if (usage.healingAttempts > budget.maxHealingAttempts) {
    reasons.push(`healing attempts ${usage.healingAttempts} exceed maxHealingAttempts ${budget.maxHealingAttempts}`);
  }
  if (usage.provider && budget.allowedProviders.length > 0 && !budget.allowedProviders.includes(usage.provider)) {
    reasons.push(`provider ${usage.provider} is not allowed`);
  }

  return reasons;
}

function approvalReasonsFor(budget: Budget, usage: BudgetDecision["usage"]): string[] {
  const cost = usage.actualUsd > 0 ? usage.actualUsd : usage.estimatedUsd;
  if (budget.approvalRequiredAboveUsd > 0 && cost > budget.approvalRequiredAboveUsd) {
    return [`estimated cost ${cost} requires approval above ${budget.approvalRequiredAboveUsd}`];
  }
  return [];
}

function numberFrom(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

function intFrom(...values: unknown[]): number {
  return Math.trunc(numberFrom(...values));
}

function stringFrom(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}
