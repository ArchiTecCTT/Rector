import { evaluateBudget, type BudgetDecision } from "../security/budget";
import type { Run } from "../store/schemas";

/** Fixed per-operation cost estimates for external memory provider calls (USD). */
export const MEMORY_OP_COST_USD = {
  create: 0.001,
  read: 0.001,
  list: 0.001,
  update: 0.001,
  delete: 0.001,
  search: 0.001,
  prune: 0.002,
} as const;

export type MemoryBudgetOperation = keyof typeof MEMORY_OP_COST_USD;

/**
 * Pre-flight budget gate for a single memory-provider network operation.
 * Wraps {@link evaluateBudget} with small fixed per-op cost constants.
 */
export function evaluateMemoryBudget(
  run: Run,
  estimate: { estimatedUsd: number; provider: string },
): BudgetDecision {
  return evaluateBudget(run, {
    estimatedUsd: estimate.estimatedUsd,
    provider: estimate.provider,
    modelCalls: 0,
  });
}