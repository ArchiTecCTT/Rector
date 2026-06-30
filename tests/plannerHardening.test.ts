import { describe, expect, it } from "vitest";
import {
  createFakePlan,
  normalizePlannerOutput,
  runLivePlanner,
  validatePlannerOutput,
  type PlannerInput,
  type PlannerOutput,
} from "../src/orchestration/planner";
import { triageUserMessage } from "../src/orchestration/triage";
import { ProviderError } from "../src/providers/llm";
import { DEFAULT_SPY_USAGE, SpyLLMProvider, generousBudget, makeContextPack, makeExternalRun } from "./support/byokArbitraries";

function inputFor(prompt: string): PlannerInput {
  const triage = triageUserMessage(prompt);
  return { triage, contextPack: makeContextPack(triage, prompt), messageContent: prompt };
}

describe("planner hardening", () => {
  it("rejects duplicate task ids through the hardened planner schema", () => {
    const plan = createFakePlan(inputFor("Fix src/api/server.ts and update tests."));
    const invalid = { ...plan, tasks: [plan.tasks[0], { ...plan.tasks[0] }] };

    expect(() => validatePlannerOutput(invalid)).toThrow(/unique/);
  });

  it("rejects approval gates that reference missing task ids", () => {
    const plan = createFakePlan(inputFor("Fix src/api/server.ts and update tests."));
    const invalid: PlannerOutput = {
      ...plan,
      tasks: plan.tasks.map((task) =>
        task.id === "code.edit" ? { ...task, risk: "high", approvalRequired: true } : task
      ),
      riskLevel: "high",
      approvalGates: [
        {
          id: "gate.bad",
          type: "approval",
          reason: "bad reference",
          required: true,
          taskIds: ["missing-task"],
        },
      ],
    };

    expect(() => validatePlannerOutput(invalid)).toThrow(/approval gate .* missing task/i);
  });

  it("requires destructive and high-risk tasks to require approval and be gated", () => {
    const plan = createFakePlan(inputFor("Fix src/api/server.ts and update tests."));
    const invalid: PlannerOutput = {
      ...plan,
      riskLevel: "destructive",
      tasks: plan.tasks.map((task) =>
        task.id === "code.edit" ? { ...task, risk: "destructive", approvalRequired: false } : task
      ),
      approvalGates: [],
    };

    expect(() => validatePlannerOutput(invalid)).toThrow(/must require approval|approval gate/i);
  });

  it("normalizes duplicate assumptions, checks, and dependency order", () => {
    const plan = createFakePlan(inputFor("Create an implementation plan for adding login, but do not edit files."));
    const noisy: PlannerOutput = {
      ...plan,
      assumptions: [...plan.assumptions, plan.assumptions[0]],
      dependencies: [plan.dependencies[0], plan.dependencies[0]],
      validation: { ...plan.validation, checks: [...plan.validation.checks, plan.validation.checks[0]] },
      tasks: plan.tasks.map((task) => ({ ...task, validation: [...task.validation, task.validation[0]] })),
    };

    const normalized = normalizePlannerOutput(noisy);

    expect(normalized.assumptions).toHaveLength(plan.assumptions.length);
    expect(normalized.dependencies).toHaveLength(1);
    expect(normalized.validation.checks).toHaveLength(plan.validation.checks.length);
    expect(normalized.tasks.every((task) => new Set(task.validation).size === task.validation.length)).toBe(true);
  });

  it("attaches a traceable deterministic fallback plan when live planner provider fails", async () => {
    const input = inputFor("Fix src/api/server.ts and update tests.");
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [{ error: new ProviderError({ code: "PROVIDER_HTTP_ERROR", provider: "spy", message: "boom" }) }],
    });
    const run = makeExternalRun(generousBudget());

    const result = await runLivePlanner(input, { provider, run, includeDeterministicFallback: true });

    expect(result.status).toBe("blocked");
    expect(result.blocker?.code).toBe("PROVIDER_ERROR");
    expect(result.fallbackReason).toContain("deterministic fallback");
    expect(result.fallbackPlan).toEqual(createFakePlan(input));
  });
});
