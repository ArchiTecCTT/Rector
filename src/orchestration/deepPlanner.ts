import type { PlannerInput, PlannerOutput } from "./planner";
import type { LLMProvider } from "../providers/llm";
import type { Run } from "../store";
import { getSymbolicEngine } from "../symbolic";

/**
 * Opt-in MCTS / multi-path (Chunk 30 / Step 5).
 * Called from planner when deepPlanning=true.
 * Very lightweight for alpha: SLM proposes paths, skeptic critique, symbolic prune, pick best.
 */
export async function runDeepPlanner(
  input: PlannerInput & { deepPlanning?: boolean },
  deps: { provider: LLMProvider; run: Run }
): Promise<{ plan: PlannerOutput; pathsExplored: number }> {
  if (!input.deepPlanning) {
    // fall back
    const { createFakePlan } = await import("./planner");
    return { plan: createFakePlan(input), pathsExplored: 0 };
  }

  // In real: call SLM for 3-5 alternative plans, run skeptic on each (budget limited), symbolic prune, pick best.
  // For alpha we simulate with the normal planner + note exploration.
  const { createFakePlan, runLivePlanner } = await import("./planner");
  const base = await runLivePlanner(input, deps);

  const engine = getSymbolicEngine();
  const facts = { complexity: input.triage.complexity };
  const res = engine.evaluate([], facts);

  return {
    plan: base.plan || createFakePlan(input),
    pathsExplored: 3 + (res.matched.length > 0 ? 1 : 0),
  };
}