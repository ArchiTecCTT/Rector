import { describe, expect, it } from "vitest";

import {
  CAPABILITY_EVAL_THRESHOLDS,
  PHASE_0_THRESHOLDS,
  scoreEvalResults,
  type CapabilityEvalMetricId,
} from "../../src/capabilities/eval/metrics";
import type { CapabilityEvalResult } from "../../src/capabilities/eval/schemas";

const passingScores = {
  schema_valid: 1,
  recall: 0.97,
  omission: 0,
  secret_leak: 0,
  compression: 12,
  raw_token_reduction: 0.82,
  line_ref_accuracy: 0.92,
  root_cause_accuracy: 0.87,
} satisfies Record<CapabilityEvalMetricId, number>;

const failingScores = {
  schema_valid: 0.98,
  recall: 0.94,
  omission: 0.03,
  secret_leak: 0.01,
  compression: 9,
  raw_token_reduction: 0.79,
  line_ref_accuracy: 0.89,
  root_cause_accuracy: 0.84,
} satisfies Record<CapabilityEvalMetricId, number>;

function resultFixture(input: {
  readonly id: string;
  readonly passed: boolean;
  readonly metricScores: Record<CapabilityEvalMetricId, number>;
}): CapabilityEvalResult {
  return {
    schemaVersion: "rector.capability-eval.v1",
    caseId: input.id,
    capabilityId: "cartographer.grounding",
    passed: input.passed,
    metricScores: input.metricScores,
    omissions: input.passed ? [] : ["Expected grounding evidence was omitted."],
    rawArtifactRefs: [`artifact://phase0/${input.id}/raw.json`],
    failureReason: input.passed ? undefined : "Metric threshold failed.",
  };
}

describe("Capability eval metrics", () => {
  it("computes averages and flags omission above the maximum threshold", () => {
    // Given: ten deterministic results with one critical omission encoded as a score of 1.
    const cleanResults = Array.from({ length: 9 }, (_value, index) =>
      resultFixture({ id: `clean-${index}`, passed: true, metricScores: passingScores }),
    );
    const omittedResult = resultFixture({
      id: "omitted-0",
      passed: false,
      metricScores: { ...passingScores, omission: 1 },
    });

    // When: the results are scored against the phase-0 thresholds.
    const summary = scoreEvalResults([...cleanResults, omittedResult]);

    // Then: omission averages to 0.10 and fails the 0.02 maximum while other metrics remain usable.
    expect(summary.resultCount).toBe(10);
    expect(summary.passedResultCount).toBe(9);
    expect(summary.metrics.omission.value).toBe(0.1);
    expect(summary.metrics.omission.threshold).toBe(PHASE_0_THRESHOLDS.omission);
    expect(summary.metrics.omission.status).toBe("fail");
    expect(summary.metrics.recall.status).toBe("pass");
    expect(summary.passed).toBe(false);
  });

  it("marks every configured metric as passing or failing at its threshold", () => {
    // Given: one fully passing result and one result below every configured threshold.
    const passingResult = resultFixture({ id: "passing", passed: true, metricScores: passingScores });
    const failingResult = resultFixture({ id: "failing", passed: false, metricScores: failingScores });

    // When: each single-result set is scored independently.
    const passingSummary = scoreEvalResults([passingResult]);
    const failingSummary = scoreEvalResults([failingResult]);

    // Then: all eight metrics expose deterministic pass/fail threshold states.
    expect(Object.values(passingSummary.metrics).map((metric) => metric.status)).toEqual([
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
    ]);
    expect(Object.values(failingSummary.metrics).map((metric) => metric.status)).toEqual([
      "fail",
      "fail",
      "fail",
      "fail",
      "fail",
      "fail",
      "fail",
      "fail",
    ]);
    expect(passingSummary.passed).toBe(true);
    expect(failingSummary.passed).toBe(false);
  });

  it("uses inclusive boundaries and total secret leak count", () => {
    // Given: boundary scores equal to every configured threshold and two leaked-secret results.
    const boundaryScores = {
      schema_valid: PHASE_0_THRESHOLDS.schema_valid,
      recall: PHASE_0_THRESHOLDS.recall,
      omission: PHASE_0_THRESHOLDS.omission,
      secret_leak: 0,
      compression: PHASE_0_THRESHOLDS.compression,
      raw_token_reduction: PHASE_0_THRESHOLDS.raw_token_reduction,
      line_ref_accuracy: PHASE_0_THRESHOLDS.line_ref_accuracy,
      root_cause_accuracy: PHASE_0_THRESHOLDS.root_cause_accuracy,
    } satisfies Record<CapabilityEvalMetricId, number>;
    const leakScores = { ...passingScores, secret_leak: 1 } satisfies Record<CapabilityEvalMetricId, number>;

    // When: boundary and leak cases are scored.
    const boundarySummary = scoreEvalResults([resultFixture({ id: "boundary", passed: true, metricScores: boundaryScores })]);
    const leakSummary = scoreEvalResults([
      resultFixture({ id: "leak-a", passed: false, metricScores: leakScores }),
      resultFixture({ id: "leak-b", passed: false, metricScores: leakScores }),
    ]);

    // Then: exact thresholds pass inclusively, while secret_leak aggregates as a total count.
    expect(boundarySummary.passed).toBe(true);
    expect(leakSummary.metrics.secret_leak.value).toBe(2);
    expect(leakSummary.metrics.secret_leak.status).toBe("fail");
    expect(CAPABILITY_EVAL_THRESHOLDS.secret_leak.direction).toBe("max");
  });

  it("treats missing metric keys as fail-closed worst-case values", () => {
    // Given: a non-empty result omitting recall and omission scores from its metric record.
    const incompleteScores: Record<string, number> = {
      schema_valid: 1,
      secret_leak: 0,
      compression: 12,
      raw_token_reduction: 0.82,
      line_ref_accuracy: 0.92,
      root_cause_accuracy: 0.87,
    };
    const incompleteResult: CapabilityEvalResult = {
      schemaVersion: "rector.capability-eval.v1",
      caseId: "incomplete",
      capabilityId: "cartographer.grounding",
      passed: false,
      metricScores: incompleteScores,
      omissions: ["Metric keys were missing."],
      rawArtifactRefs: ["artifact://phase0/incomplete/raw.json"],
    };

    // When: the incomplete result is scored.
    const summary = scoreEvalResults([incompleteResult]);

    // Then: missing recall becomes worst-case 0 and missing omission becomes fail-closed 1.
    expect(summary.insufficientData).toBe(false);
    expect(summary.metrics.recall.value).toBe(0);
    expect(summary.metrics.omission.value).toBe(1);
    expect(summary.metrics.recall.status).toBe("fail");
    expect(summary.metrics.omission.status).toBe("fail");
  });

  it("returns insufficient data instead of NaN for an empty result set", () => {
    // Given: no eval results have been collected yet.
    const results: readonly CapabilityEvalResult[] = [];

    // When: the scorer aggregates the empty input.
    const summary = scoreEvalResults(results);

    // Then: each metric has no numeric value and the summary is explicitly insufficient.
    expect(summary.resultCount).toBe(0);
    expect(summary.passedResultCount).toBe(0);
    expect(summary.insufficientData).toBe(true);
    expect(summary.passed).toBe(false);
    for (const metric of Object.values(summary.metrics)) {
      expect(metric.value).toBeUndefined();
      expect(metric.status).toBe("insufficient_data");
    }
  });
});
