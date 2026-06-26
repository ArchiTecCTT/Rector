import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import {
  GLOBAL_SCORECARD_DIMENSION_IDS,
  GLOBAL_SCORECARD_SCHEMA_VERSION,
  ScorecardSchema,
  renderScorecardJson,
  renderScorecardMarkdown,
  type Scorecard,
} from "../../src/evals/scorecards";

function fullScorecard(): Scorecard {
  return {
    schemaVersion: GLOBAL_SCORECARD_SCHEMA_VERSION,
    scenarioId: "coding-memory-patch-001",
    dimensions: {
      reliability: { score: 1 },
      accuracy: { score: 0.95, notes: "one minor omission" },
      safety: { score: 1 },
      cost_efficiency: { score: 0.8 },
      memory_correctness: { score: 0.9 },
      delegation_quality: { score: 0.85 },
      evidence_quality: { score: 0.92 },
      simplicity: { score: 0.7 },
    },
    fakePathStatus: "clean",
    fakeFindingCount: 0,
    passed: true,
  };
}

describe("global scorecards", () => {
  it("validates and parses a full eight-dimension scorecard", () => {
    // Given: a scorecard covering all eight global dimensions plus the fake-path status.
    const scorecard = fullScorecard();

    // When: it is validated at the schema boundary.
    const parsed = ScorecardSchema.parse(scorecard);

    // Then: every required dimension is present and the fake-path status is preserved.
    for (const id of GLOBAL_SCORECARD_DIMENSION_IDS) {
      expect(parsed.dimensions[id].score).toBeGreaterThanOrEqual(0);
      expect(parsed.dimensions[id].score).toBeLessThanOrEqual(1);
    }
    expect(parsed.fakePathStatus).toBe("clean");
    expect(parsed.fakeFindingCount).toBe(0);
    expect(parsed.passed).toBe(true);
  });

  it("defaults the schemaVersion when omitted from otherwise-valid input", () => {
    // Given: a scorecard object without the optional schemaVersion literal.
    const { schemaVersion: _omit, ...rest } = fullScorecard();

    // When: it is validated.
    const parsed = ScorecardSchema.parse(rest);

    // Then: the canonical scorecard version is applied.
    expect(parsed.schemaVersion).toBe(GLOBAL_SCORECARD_SCHEMA_VERSION);
  });

  it("renders byte-identical Markdown for identical input (determinism lock)", () => {
    // Given: one fixed scorecard.
    const scorecard = fullScorecard();

    // When: the Markdown renderer runs twice.
    const first = renderScorecardMarkdown(scorecard);
    const second = renderScorecardMarkdown(scorecard);

    // Then: the two renders are byte-identical and contain every dimension and the fake-path row.
    expect(first).toBe(second);
    for (const id of GLOBAL_SCORECARD_DIMENSION_IDS) {
      expect(first).toContain(id);
    }
    expect(first).toContain("Fake-path Audit");
    expect(first).toContain("clean");
  });

  it("renders byte-identical, stable-key-order JSON for identical input", () => {
    // Given: one fixed scorecard.
    const scorecard = fullScorecard();

    // When: the JSON renderer runs twice.
    const first = renderScorecardJson(scorecard);
    const second = renderScorecardJson(scorecard);

    // Then: output is byte-identical and dimension keys follow the fixed dimension order.
    expect(first).toBe(second);
    const dimensionOrder = GLOBAL_SCORECARD_DIMENSION_IDS.map((id) => `"${id}"`);
    const indices = dimensionOrder.map((key) => first.indexOf(key));
    const sortedIndices = [...indices].sort((left, right) => left - right);
    expect(indices).toEqual(sortedIndices);
  });

  it("rejects a scorecard missing the fakePathStatus dimension", () => {
    // Given: an otherwise-valid scorecard with fakePathStatus removed.
    const { fakePathStatus: _omit, ...rest } = fullScorecard();

    // When: the incomplete object is validated.
    const result = ScorecardSchema.safeParse(rest);

    // Then: the schema rejects it and names the missing fakePathStatus field.
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join(".") === "fakePathStatus")).toBe(true);
    }
  });

  it("rejects an out-of-range dimension score above 1", () => {
    // Given: a scorecard whose reliability score exceeds the 0-1 range.
    const scorecard = fullScorecard();
    const invalid = {
      ...scorecard,
      dimensions: { ...scorecard.dimensions, reliability: { score: 1.4 } },
    };

    // When: it is validated.
    const act = () => ScorecardSchema.parse(invalid);

    // Then: a ZodError flags the offending nested dimension score.
    expect(act).toThrow(ZodError);
    try {
      act();
    } catch (error) {
      const zodError = error as ZodError;
      expect(zodError.issues.some((issue) => issue.path.join(".") === "dimensions.reliability.score")).toBe(true);
    }
  });
});
