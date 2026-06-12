import { describe, expect, it } from "vitest";
import { createFakePlan, type PlannerInput, type PlannerOutput } from "../src/orchestration/planner";
import {
  deduplicateSkepticFindings,
  reviewPlanWithSkeptic,
  runLiveSkeptic,
  type SkepticFinding,
} from "../src/orchestration/skeptic";
import { triageUserMessage } from "../src/orchestration/triage";
import { DEFAULT_SPY_USAGE, SpyLLMProvider, generousBudget, makeContextPack, makeExternalRun } from "./support/byokArbitraries";

function inputFor(prompt: string): PlannerInput {
  const triage = triageUserMessage(prompt);
  return { triage, contextPack: makeContextPack(triage, prompt), messageContent: prompt };
}

function finding(overrides: Partial<SkepticFinding> = {}): SkepticFinding {
  return {
    id: "finding-1",
    severity: "MAJOR",
    category: "risk",
    message: "Risk is underestimated.",
    evidence: "risk=low",
    recommendation: "Raise risk.",
    ...overrides,
  };
}

describe("skeptic hardening", () => {
  it("does not let a live reviewer suppress deterministic blockers", async () => {
    const input = inputFor("Build the entire feature end-to-end, run all tests, benchmark, iterate, and deploy.");
    const plan = createFakePlan(input);
    const invalid: PlannerOutput = {
      ...plan,
      approvalGates: [],
      tasks: plan.tasks.map((task) =>
        task.risk === "high" ? { ...task, approvalRequired: false, risk: "high" } : task
      ),
    };
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [JSON.stringify({ verdict: "SOUND", findings: [] })],
    });

    const result = await runLiveSkeptic(
      { plannerOutput: invalid, contextPack: input.contextPack, triage: input.triage },
      { provider, run: makeExternalRun(generousBudget()) }
    );

    expect(result.status).toBe("ok");
    expect(result.review?.verdict).toBe("BLOCKED");
    expect(result.review?.findings.some((item) => item.severity === "BLOCKER" && item.category === "approval")).toBe(true);
    expect(provider.invokeCount).toBe(0);
    expect(result.attempts).toBe(0);
  });

  it("collapses duplicate findings after redaction", () => {
    const duplicate = finding();
    const deduped = deduplicateSkepticFindings([duplicate, { ...duplicate, id: "finding-duplicate" }]);

    expect(deduped).toHaveLength(1);
    expect(deduped[0]).toMatchObject({ category: "risk", message: "Risk is underestimated." });
  });

  it("flags unsafe implementation language on a low-risk plan", () => {
    const input = inputFor("Explain Rector.");
    const plan = createFakePlan(input);
    const underestimated: PlannerOutput = {
      ...plan,
      riskLevel: "low",
      tasks: [
        {
          ...plan.tasks[0],
          description: "Edit files and deploy this to production.",
          risk: "low",
        },
      ],
    };

    const review = reviewPlanWithSkeptic(underestimated, input.contextPack);

    expect(review.verdict).toBe("NEEDS_REVISION");
    expect(review.findings.some((item) => item.category === "risk" && item.severity === "MAJOR")).toBe(true);
  });
});
