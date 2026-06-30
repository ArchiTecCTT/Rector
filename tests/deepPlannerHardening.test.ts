import { describe, expect, it } from "vitest";

import { createMultiCandidatePlanner, runDeepPlanner } from "../src/orchestration/deepPlanner";
import { createFakePlan, PlannerOutputSchema, type PlannerOutput } from "../src/orchestration/planner";
import { triageUserMessage } from "../src/orchestration/triage";
import {
  DEFAULT_SPY_USAGE,
  SpyLLMProvider,
  generousBudget,
  makeContextPack,
  makeExternalRun,
  planToJson,
} from "./support/byokArbitraries";

function makeInput(prompt = "Update package.json safely and run tests") {
  const triage = triageUserMessage(prompt);
  return {
    triage,
    contextPack: makeContextPack(triage, prompt),
    messageContent: prompt,
  };
}

function oneTaskPlan(overrides: Partial<PlannerOutput> = {}): PlannerOutput {
  return PlannerOutputSchema.parse({
    goal: "Update package metadata",
    assumptions: ["Test plan"],
    tasks: [
      {
        id: "code.edit",
        title: "Update package.json",
        description: "Update package.json with a focused script change.",
        dependencies: [],
        expectedArtifacts: ["Updated source files"],
        validation: ["Change is validated"],
        risk: "low",
        approvalRequired: false,
      },
    ],
    dependencies: [],
    validation: { summary: "Validate output", checks: ["Relevant checks pass"] },
    riskLevel: "low",
    approvalGates: [],
    ...overrides,
  });
}

describe("deep planner hardening", () => {
  it("prunes symbolically unsafe candidates and records rejection reasons", async () => {
    const input = makeInput();
    const unsafePlan = oneTaskPlan();
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [{ content: planToJson(unsafePlan) }],
    });

    const result = await runDeepPlanner(
      { ...input, deepPlanning: true },
      { provider, run: makeExternalRun(generousBudget()) },
    );

    expect(result.status).toBe("ok");
    expect(result.plan?.goal).toContain("risk-minimized");
    expect(result.plan?.tasks[0].title).not.toContain("package.json");
    expect(result.pathsExplored?.some((line) => line.includes("base-live") && line.includes("rejected"))).toBe(true);
    expect(result.pathsExplored?.join("\n")).toContain("symbolic rule violations");
  });

  it("selects the best scored candidate deterministically", () => {
    const input = makeInput("Fix src/server.ts and update tests");
    const basePlan = createFakePlan(input);
    const planner = createMultiCandidatePlanner();

    const first = planner.plan(input, basePlan);
    const second = planner.plan(input, basePlan);

    expect(first.selectedSource).toBe("risk-minimized");
    expect(second.selectedSource).toBe(first.selectedSource);
    expect(second.traces).toEqual(first.traces);
    expect(first.traces.find((trace) => trace.selected)?.source).toBe("risk-minimized");
  });

  it("propagates a live planner blocker when provider planning fails", async () => {
    const input = makeInput("Explain Rector");
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [{ error: new Error("provider unavailable") }],
    });

    const result = await runDeepPlanner(
      { ...input, deepPlanning: true },
      { provider, run: makeExternalRun(generousBudget()) },
    );

    expect(result.status).toBe("blocked");
    expect(provider.invokeCount).toBe(1);
    expect(result.plan).toBeUndefined();
    expect(result.blocker?.code).toBe("PROVIDER_ERROR");
    expect(result.fallbackPlan).toBeUndefined();
  });

  it("delegates deep-planning-off path to the live planner", async () => {
    const input = makeInput("What is Rector?");
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [{ content: planToJson(oneTaskPlan({ goal: "Answer Rector question" })) }],
    });

    const result = await runDeepPlanner(
      { ...input, deepPlanning: false },
      { provider, run: makeExternalRun(generousBudget()) },
    );

    expect(result.status).toBe("ok");
    expect(result.attempts).toBe(1);
    expect(provider.invokeCount).toBe(1);
    expect(result.plan?.goal).toBe("Answer Rector question");
  });

  it("returns the live base plan instead of manufacturing a deterministic fallback when all candidates fail", () => {
    const input = makeInput("Update package.json safely and run tests");
    const basePlan = oneTaskPlan();
    const planner = createMultiCandidatePlanner({ maxEstimatedRuntimeMs: 1 });

    const result = planner.plan(input, basePlan);

    expect(result.selectedSource).toBe("base-live");
    expect(result.selectedPlan).toEqual(basePlan);
    expect(result.traces.filter((trace) => trace.selected)).toHaveLength(1);
    expect(result.traces.find((trace) => trace.selected)?.rejected).toBe(false);
    expect(result.traces.some((trace) => trace.rejected)).toBe(true);
  });
});
