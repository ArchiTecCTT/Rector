import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { enforceMaxPerRunBudget } from "../src/security/budget";
import type { Budget, Run } from "../src/store/schemas";

/**
 * Property test for max-per-run budget enforcement (task 10.4).
 *
 * Property 6: A run exceeding its max per-run budget is denied before the next
 * provider call.
 *
 * `enforceMaxPerRunBudget(run, accumulated, nextEstimate)` is the PRE-FLIGHT gate
 * that runs BEFORE a provider is invoked. It projects `accumulated + nextEstimate`
 * and returns a non-`allowed` decision EXACTLY WHEN the projected total would breach
 * either per-run ceiling (strict `>`):
 *
 *     breach  <=>  projectedUsd > budget.maxUsd  OR  projectedModelCalls > budget.maxModelCalls
 *
 * and `allowed` otherwise (projected totals `<=` BOTH ceilings).
 *
 * The "denied before the next provider call" guarantee is modelled with a local spy
 * provider: the preflight gate invokes the provider only when the decision is
 * `allowed`. We then assert the spy's `invoke` is called ZERO times on a denial and
 * exactly once on an allow — the provider is never reached when the budget is breached.
 *
 * No API key, no network: the "provider" is a local counter spy, never a real call.
 *
 * Validates: Requirements 3.4
 */

// Build a minimal Run that satisfies the shape consumed by enforceMaxPerRunBudget.
// The run's own costEstimate/tokenEstimate are irrelevant to the decision here because
// the projected totals are supplied explicitly via `accumulated` + `nextEstimate`.
function makeRun(budget: Budget): Run {
  return {
    id: "run-1",
    conversationId: "conv-1",
    userMessageId: "msg-1",
    status: "running",
    phase: "TRIAGE",
    route: "local",
    complexity: "simple",
    budget,
    costEstimate: { usd: 0 },
    tokenEstimate: { input: 0, output: 0 },
    traceId: "trace-1",
    attempts: 0,
    healingAttempts: 0,
    validationAttempts: 0,
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
  };
}

// A budget whose non-ceiling limits are set high so only maxUsd / maxModelCalls can
// drive the decision. approvalRequiredAboveUsd is disabled (0) per the spec note: the
// status is driven solely by the usd/modelCalls projected ceilings.
function makeBudget(maxUsd: number, maxModelCalls: number): Budget {
  return {
    maxUsd,
    maxModelCalls,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 1_000_000,
    maxRuntimeMs: 60_000_000,
    maxHealingAttempts: 1_000,
    allowedProviders: [],
    approvalRequiredAboveUsd: 0,
  };
}

// Local spy provider — a pure counter, never a network call.
function makeSpyProvider() {
  let calls = 0;
  return {
    invoke: () => {
      calls += 1;
      return "ok";
    },
    get calls() {
      return calls;
    },
  };
}

describe("enforceMaxPerRunBudget — Property 6 (task 10.4)", () => {
  it(
    "denies (and never invokes the provider) exactly when the projected total breaches a ceiling",
    () => {
      fc.assert(
        fc.property(
          // Integer dollars/calls keep comparisons exact (no float-boundary flakiness)
          // while still exercising the allow boundary (== ceiling) and breach (> ceiling).
          fc.integer({ min: 0, max: 100 }), // budget.maxUsd
          fc.integer({ min: 0, max: 50 }), //  budget.maxModelCalls
          fc.integer({ min: 0, max: 100 }), // accumulated.estimatedUsd
          fc.integer({ min: 0, max: 50 }), //  accumulated.modelCalls
          fc.integer({ min: 0, max: 100 }), // nextEstimate.estimatedUsd
          fc.integer({ min: 0, max: 50 }), //  nextEstimate.modelCalls
          (maxUsd, maxModelCalls, accUsd, accCalls, nextUsd, nextCalls) => {
            const run = makeRun(makeBudget(maxUsd, maxModelCalls));
            const accumulated = { estimatedUsd: accUsd, modelCalls: accCalls };
            const nextEstimate = { estimatedUsd: nextUsd, modelCalls: nextCalls };

            const projectedUsd = accUsd + nextUsd;
            const projectedModelCalls = accCalls + nextCalls;
            // Breach predicate under test (strict `>` on either projected ceiling).
            const breaches = projectedUsd > maxUsd || projectedModelCalls > maxModelCalls;

            const provider = makeSpyProvider();

            // Model the preflight gate: only invoke the provider when allowed.
            const decision = enforceMaxPerRunBudget(run, accumulated, nextEstimate);
            if (decision.status === "allowed") {
              provider.invoke();
            }

            if (breaches) {
              // Non-`allowed` decision AND the provider was never reached.
              expect(decision.status).not.toBe("allowed");
              expect(decision.status).toBe("denied");
              expect(provider.calls).toBe(0);
            } else {
              // Allowed AND the provider was invoked exactly once.
              expect(decision.status).toBe("allowed");
              expect(provider.calls).toBe(1);
            }
          },
        ),
        { numRuns: 500 },
      );
    },
  );

  // Deterministic boundary examples complementing the property.
  it("allows when projected totals exactly equal both ceilings (<= boundary)", () => {
    const run = makeRun(makeBudget(10, 4));
    const provider = makeSpyProvider();
    const decision = enforceMaxPerRunBudget(run, { estimatedUsd: 6, modelCalls: 1 }, { estimatedUsd: 4, modelCalls: 3 });
    if (decision.status === "allowed") provider.invoke();

    expect(decision.status).toBe("allowed");
    expect(provider.calls).toBe(1);
  });

  it("denies and skips the provider when the projected usd ceiling is breached by one", () => {
    const run = makeRun(makeBudget(10, 4));
    const provider = makeSpyProvider();
    const decision = enforceMaxPerRunBudget(run, { estimatedUsd: 6, modelCalls: 1 }, { estimatedUsd: 5, modelCalls: 3 });
    if (decision.status === "allowed") provider.invoke();

    expect(decision.status).toBe("denied");
    expect(provider.calls).toBe(0);
  });

  it("denies and skips the provider when the projected model-call ceiling is breached by one", () => {
    const run = makeRun(makeBudget(10, 4));
    const provider = makeSpyProvider();
    const decision = enforceMaxPerRunBudget(run, { estimatedUsd: 6, modelCalls: 2 }, { estimatedUsd: 4, modelCalls: 3 });
    if (decision.status === "allowed") provider.invoke();

    expect(decision.status).toBe("denied");
    expect(provider.calls).toBe(0);
  });
});
