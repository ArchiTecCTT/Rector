import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { runDeepPlanner } from "../src/orchestration/deepPlanner";
import { createFakePlan } from "../src/orchestration/planner";
import { decomposeIntoTasks } from "../src/orchestration/taskDecomposer";
import { DEFAULT_SPY_USAGE, SpyLLMProvider, generousBudget, makeExternalRun, arbPlannerInput } from "./support/byokArbitraries";

describe("neuro local/provider-free invariants", () => {
  it("keeps deep planning disabled path deterministic and provider-free", async () => {
    await fc.assert(
      fc.asyncProperty(arbPlannerInput(), async (input) => {
        const provider = new SpyLLMProvider({ estimate: DEFAULT_SPY_USAGE });
        const result = await runDeepPlanner(
          { ...input, deepPlanning: false },
          { provider, run: makeExternalRun(generousBudget()) },
        );

        expect(result.status).toBe("ok");
        expect(result.attempts).toBe(0);
        expect(provider.invokeCount).toBe(0);
        expect(result.plan).toEqual(createFakePlan(input));
      }),
      { numRuns: 100 },
    );
  });

  it("keeps deterministic task decomposition pure for identical inputs", () => {
    fc.assert(
      fc.property(arbPlannerInput(), (input) => {
        const first = decomposeIntoTasks(input.messageContent ?? input.contextPack.userIntentSummary, input.contextPack);
        const second = decomposeIntoTasks(input.messageContent ?? input.contextPack.userIntentSummary, input.contextPack);

        expect(second).toEqual(first);
        expect(first.subGoals.length).toBeLessThanOrEqual(4);
        expect(first.subGoalGraph.maxConcurrency).toBeGreaterThanOrEqual(1);
        expect(first.subGoalGraph.maxConcurrency).toBeLessThanOrEqual(8);
      }),
      { numRuns: 100 },
    );
  });
});
