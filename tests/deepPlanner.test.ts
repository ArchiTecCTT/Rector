import { describe, expect, it } from "vitest";

import { runDeepPlanner } from "../src/orchestration/deepPlanner";
import { PlannerOutputSchema } from "../src/orchestration/planner";
import { triageUserMessage } from "../src/orchestration/triage";
import {
  DEFAULT_SPY_USAGE,
  SpyLLMProvider,
  generousBudget,
  makeContextPack,
  makeExternalRun,
  planToJson,
} from "./support/byokArbitraries";

const SAFE_PLAN = PlannerOutputSchema.parse({
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

describe("deep planner", () => {
  it("returns LivePlannerResult-compatible shape when deepPlanning is enabled", async () => {
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [{ content: planToJson(SAFE_PLAN) }],
    });
    const triage = triageUserMessage("What is Rector?");
    const contextPack = makeContextPack(triage, "What is Rector?");
    const run = makeExternalRun(generousBudget());

    const result = await runDeepPlanner(
      { triage, contextPack, messageContent: "What is Rector?", deepPlanning: true },
      { provider, run }
    );

    expect(result.status).toBe("ok");
    expect(result.plan).toBeDefined();
    expect(result.provider).toBe(provider.metadata.id);
    expect(result.model).toBe(provider.metadata.models.flagship);
    expect(result.attempts).toBeGreaterThanOrEqual(1);
    expect(result.usage.modelCalls).toBeGreaterThanOrEqual(1);
  });

  it("delegates to live planner when deepPlanning is disabled", async () => {
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [{ content: planToJson(SAFE_PLAN) }],
    });
    const triage = triageUserMessage("What is Rector?");
    const contextPack = makeContextPack(triage, "What is Rector?");
    const run = makeExternalRun(generousBudget());

    const result = await runDeepPlanner(
      { triage, contextPack, messageContent: "What is Rector?", deepPlanning: false },
      { provider, run }
    );

    expect(result.status).toBe("ok");
    expect(result.plan).toEqual(SAFE_PLAN);
    expect(result.attempts).toBe(1);
    expect(provider.invokeCount).toBe(1);
  });
});