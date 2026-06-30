import { describe, expect, it } from "vitest";

import { aggregateCampaignBudget, DEFAULT_ZAI_CAMPAIGN_TOKEN_LIMIT } from "../../src/evidence";

const NOW = new Date("2026-06-30T00:00:00.000Z");

describe("campaign budget aggregation", () => {
  it("aggregates calls, tokens, and cost across Z.ai campaign surfaces", () => {
    const rollup = aggregateCampaignBudget(
      [
        { source: "provider_smoke", modelCalls: 1, inputTokens: 100, outputTokens: 25, estimatedCostUsd: 0.01 },
        { source: "phase2f_shadow", modelCalls: 5, inputTokens: 1_000, outputTokens: 500, estimatedCostUsd: 0.1 },
        { source: "harness_smoke", modelCalls: 3, totalTokens: 2_750, estimatedCostUsd: 0.2 },
      ],
      { now: () => NOW },
    );

    expect(rollup.generatedAt).toBe(NOW.toISOString());
    expect(rollup.limits.maxTotalTokens).toBe(DEFAULT_ZAI_CAMPAIGN_TOKEN_LIMIT);
    expect(rollup.sources.provider_smoke).toMatchObject({ modelCalls: 1, inputTokens: 100, outputTokens: 25, totalTokens: 125 });
    expect(rollup.sources.phase2f_shadow).toMatchObject({ modelCalls: 5, inputTokens: 1_000, outputTokens: 500, totalTokens: 1_500 });
    expect(rollup.sources.harness_smoke).toMatchObject({ modelCalls: 3, inputTokens: 0, outputTokens: 0, totalTokens: 2_750 });
    expect(rollup.total).toMatchObject({ modelCalls: 9, inputTokens: 1_100, outputTokens: 525, totalTokens: 4_375 });
    expect(rollup.total.estimatedCostUsd).toBeCloseTo(0.31);
    expect(rollup.withinTokenBudget).toBe(true);
    expect(rollup.overTokenBudgetBy).toBe(0);
    expect(rollup.withinModelCallBudget).toBe(true);
    expect(rollup.overModelCallBudgetBy).toBe(0);
    expect(rollup.withinEstimatedUsdBudget).toBe(true);
    expect(rollup.overEstimatedUsdBudgetBy).toBe(0);
    expect(rollup.status).toBe("within_budget");
  });

  it("sums multiple usage rows for the same campaign source", () => {
    const rollup = aggregateCampaignBudget(
      [
        { source: "provider_smoke", modelCalls: 1, totalTokens: 100 },
        { source: "provider_smoke", modelCalls: 2, totalTokens: 50 },
      ],
      { now: () => NOW },
    );

    expect(rollup.sources.provider_smoke).toMatchObject({ modelCalls: 3, totalTokens: 150 });
    expect(rollup.total.modelCalls).toBe(3);
    expect(rollup.total.totalTokens).toBe(150);
  });

  it("marks over budget when model calls or estimated USD exceed configured limits", () => {
    const byCalls = aggregateCampaignBudget([{ source: "provider_smoke", modelCalls: 5, totalTokens: 10 }], {
      now: () => NOW,
      limits: { maxTotalTokens: 100_000, maxModelCalls: 3 },
    });
    expect(byCalls.withinTokenBudget).toBe(true);
    expect(byCalls.withinModelCallBudget).toBe(false);
    expect(byCalls.overModelCallBudgetBy).toBe(2);
    expect(byCalls.status).toBe("over_budget");

    const byCost = aggregateCampaignBudget(
      [{ source: "harness_smoke", modelCalls: 1, totalTokens: 10, estimatedCostUsd: 1.5 }],
      { now: () => NOW, limits: { maxTotalTokens: 100_000, maxEstimatedUsd: 1.25 } },
    );
    expect(byCost.withinEstimatedUsdBudget).toBe(false);
    expect(byCost.overEstimatedUsdBudgetBy).toBeCloseTo(0.25);
    expect(byCost.status).toBe("over_budget");
  });

  it("rejects inconsistent totalTokens when input and output breakdown is reported", () => {
    expect(() =>
      aggregateCampaignBudget(
        [{ source: "provider_smoke", inputTokens: 100, outputTokens: 25, totalTokens: 50 }],
        { now: () => NOW },
      ),
    ).toThrow(/totalTokens must be at least inputTokens \+ outputTokens/i);
  });

  it("allows totalTokens-only usage without input or output breakdown", () => {
    const rollup = aggregateCampaignBudget([{ source: "harness_smoke", totalTokens: 2_750 }], { now: () => NOW });
    expect(rollup.sources.harness_smoke.totalTokens).toBe(2_750);
    expect(rollup.sources.harness_smoke.inputTokens).toBe(0);
    expect(rollup.sources.harness_smoke.outputTokens).toBe(0);
  });

  it("marks the campaign over budget when total tokens exceed the configured limit", () => {
    const rollup = aggregateCampaignBudget(
      [
        { source: "provider_smoke", modelCalls: 1, totalTokens: 500 },
        { source: "phase2f_shadow", modelCalls: 2, totalTokens: 1_000 },
        { source: "harness_smoke", modelCalls: 3, totalTokens: 1_250 },
      ],
      { now: () => NOW, limits: { maxTotalTokens: 2_000 } },
    );

    expect(rollup.total.totalTokens).toBe(2_750);
    expect(rollup.withinTokenBudget).toBe(false);
    expect(rollup.overTokenBudgetBy).toBe(750);
    expect(rollup.status).toBe("over_budget");
  });

  it("rejects negative usage so budget evidence cannot erase spend", () => {
    expect(() => aggregateCampaignBudget([{ source: "provider_smoke", modelCalls: -1 }], { now: () => NOW })).toThrow(
      /non-negative/i,
    );
  });
});
