import type { PlannerInput, PlannerOutput, LivePlannerResult } from "./planner";
import type { LLMProvider } from "../providers/llm";
import type { Run } from "../store";
import { DEFAULT_PREPROCESSOR_RULES } from "../symbolic/defaultRules";
import { getSymbolicEngine } from "../symbolic";

/**
 * Opt-in MCTS / multi-path (Chunk 30 / Step 5).
 * Called from chatRunner when deepPlanning=true.
 * Lightweight for alpha: flagship planner proposes a base plan, symbolic alternatives are
 * generated, each path is symbolically pruned, and the best surviving plan is returned in the
 * same shape as runLivePlanner.
 */
export async function runDeepPlanner(
  input: PlannerInput & { deepPlanning?: boolean },
  deps: { provider: LLMProvider; run: Run }
): Promise<LivePlannerResult> {
  const { createFakePlan, runLivePlanner } = await import("./planner");

  if (!input.deepPlanning) {
    const fallback = createFakePlan(input);
    return {
      status: "ok",
      plan: fallback,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimatedUsd: 0,
        modelCalls: 0,
      },
      provider: deps.provider.metadata.id,
      model: deps.provider.metadata.models.flagship,
      attempts: 0,
    };
  }

  const base = await runLivePlanner(input, deps);
  if (base.status === "blocked" || !base.plan) {
    return base;
  }

  const engine = getSymbolicEngine();
  const candidates: PlannerOutput[] = [
    base.plan,
    createFakePlan(input),
    createFakePlan({
      ...input,
      messageContent: `${input.messageContent ?? ""} (alternative path: prioritize tests first)`,
    }),
    createFakePlan({
      ...input,
      messageContent: `${input.messageContent ?? ""} (alternative path: minimize risk)`,
    }),
  ];

  const surviving = candidates.filter((plan) => !planBlockedBySymbolicRules(plan, engine));
  const selected = pickBestPlan(surviving.length > 0 ? surviving : [base.plan], base.plan);

  return {
    status: "ok",
    plan: selected,
    usage: base.usage,
    provider: base.provider,
    model: base.model,
    attempts: base.attempts,
  };
}

function planBlockedBySymbolicRules(
  plan: PlannerOutput,
  engine: ReturnType<typeof getSymbolicEngine>
): boolean {
  for (const task of plan.tasks) {
    const text = `${task.title} ${task.description}`;
    for (const path of extractWritePaths(text)) {
      const evaluation = engine.evaluate(DEFAULT_PREPROCESSOR_RULES, {
        tool: "write_file",
        args: { path },
      });
      if (evaluation.blocked) {
        return true;
      }
    }
  }
  return false;
}

function extractWritePaths(text: string): string[] {
  const matches = text.match(/\b(?:write|edit|patch|update)\s+(?:to\s+)?((?:src\/|\.\/)?[\w./-]+\.\w+)\b/gi) ?? [];
  const paths = matches
    .map((match) => match.replace(/^(?:write|edit|patch|update)\s+(?:to\s+)?/i, ""))
    .filter(Boolean);
  return [...new Set(paths)];
}

function pickBestPlan(candidates: PlannerOutput[], preferred: PlannerOutput): PlannerOutput {
  const riskRank: Record<string, number> = { low: 0, medium: 1, high: 2, destructive: 3 };
  const sorted = [...candidates].sort((left, right) => {
    const leftRank = riskRank[left.riskLevel] ?? 99;
    const rightRank = riskRank[right.riskLevel] ?? 99;
    if (leftRank !== rightRank) return leftRank - rightRank;
    if (left.goal === preferred.goal && right.goal !== preferred.goal) return -1;
    if (right.goal === preferred.goal && left.goal !== preferred.goal) return 1;
    return left.tasks.length - right.tasks.length;
  });
  return sorted[0] ?? preferred;
}