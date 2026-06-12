import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  runLiveTriage,
  scoreTriageSignals,
  triageUserMessage,
  TRIAGE_ROUTES,
} from "../src/orchestration/triage";
import { DEFAULT_SPY_USAGE, SpyLLMProvider, arbSubThresholdBudget, makeExternalRun } from "./support/byokArbitraries";

describe("triage hardening", () => {
  it("exposes deterministic route signals without changing the local classifier route", () => {
    const prompt = "Fix the TypeScript bug in src/api/server.ts and update tests.";
    const signals = scoreTriageSignals(prompt);
    const result = triageUserMessage(prompt);

    expect(result.route).toBe(TRIAGE_ROUTES.CODE_EDIT);
    expect(result.source).toBe("deterministic");
    expect(result.signals).toEqual(signals);
    expect(signals.routeScores.CODE_EDIT).toBeGreaterThanOrEqual(2);
    expect(signals.matchedSignals.codeEdit).toBeGreaterThanOrEqual(2);
  });

  it("routes conflicting plan-only plus edit intent to clarification", () => {
    const result = triageUserMessage("Plan only, but also edit src/api/server.ts and apply the fix.");

    expect(result.route).toBe(TRIAGE_ROUTES.NEEDS_CLARIFICATION);
    expect(result.riskFlags).toContain("conflicting_intent");
    expect(result.riskFlags).toContain("approval_required");
  });

  it("always carries risk and approval flags for destructive prompts", () => {
    const result = triageUserMessage("Delete obsolete source files in src/cleanup.ts and update tests.");

    expect(result.riskFlags).toContain("destructive_change");
    expect(result.riskFlags).toContain("approval_required");
    expect(result.approvalRequired).toBe(true);
  });

  it("keeps ambiguous short prompts on the clarification route", () => {
    fc.assert(
      fc.property(fc.constantFrom("it", "the thing", "stuff", "help", "do it", "can you do the thing"), (prompt) => {
        const result = triageUserMessage(prompt);
        expect(result.route).toBe(TRIAGE_ROUTES.NEEDS_CLARIFICATION);
        expect(result.riskFlags).toContain("ambiguous_request");
      }),
      { numRuns: 100 }
    );
  });

  it("falls back before provider invocation when live triage budget is denied", async () => {
    await fc.assert(
      fc.asyncProperty(arbSubThresholdBudget(), async (budget) => {
        const provider = new SpyLLMProvider({ estimate: DEFAULT_SPY_USAGE });
        const run = makeExternalRun(budget);

        const result = await runLiveTriage("Fix src/api/server.ts and update tests.", { provider, run });

        expect(result.status).toBe("fallback");
        expect(result.blocker?.code).toBe("BUDGET_DENIED");
        expect(result.triage.source).toBe("fallback");
        expect(result.fallbackReason).toContain("budget");
        expect(provider.invokeCount).toBe(0);
        expect(result.attempts).toBe(0);
      }),
      { numRuns: 100 }
    );
  });
});
