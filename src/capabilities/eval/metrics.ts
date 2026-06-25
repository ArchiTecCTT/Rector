import type { CapabilityEvalResult } from "./schemas";

export const CAPABILITY_EVAL_METRIC_IDS = [
  "schema_valid",
  "recall",
  "omission",
  "secret_leak",
  "compression",
  "raw_token_reduction",
  "line_ref_accuracy",
  "root_cause_accuracy",
] as const;

export type CapabilityEvalMetricId = (typeof CAPABILITY_EVAL_METRIC_IDS)[number];
export type CapabilityEvalThresholdDirection = "min" | "max" | "equals";
export type CapabilityEvalMetricStatus = "pass" | "fail" | "insufficient_data";

export type CapabilityEvalThresholdRule = {
  readonly direction: CapabilityEvalThresholdDirection;
  readonly threshold: number;
};

export type CapabilityEvalMetricScore = {
  readonly id: CapabilityEvalMetricId;
  readonly value?: number;
  readonly threshold: number;
  readonly direction: CapabilityEvalThresholdDirection;
  readonly status: CapabilityEvalMetricStatus;
  readonly passed: boolean;
};

export type MetricSummary = {
  readonly resultCount: number;
  readonly passedResultCount: number;
  readonly insufficientData: boolean;
  readonly passed: boolean;
  readonly metrics: Readonly<Record<CapabilityEvalMetricId, CapabilityEvalMetricScore>>;
};

export const SCHEMA_VALID_MIN = 0.99;
export const CRITICAL_EVIDENCE_RECALL_MIN = 0.95;
export const CRITICAL_OMISSION_MAX = 0.02;
export const SECRET_LEAK_MAX = 0;
export const COMPRESSION_MIN = 10;
export const RAW_TOKEN_REDUCTION_MIN = 0.8;
export const LINE_REF_ACCURACY_MIN = 0.9;
export const ROOT_CAUSE_ACCURACY_MIN = 0.85;

export const PHASE_0_THRESHOLDS = {
  schema_valid: SCHEMA_VALID_MIN,
  recall: CRITICAL_EVIDENCE_RECALL_MIN,
  omission: CRITICAL_OMISSION_MAX,
  secret_leak: SECRET_LEAK_MAX,
  compression: COMPRESSION_MIN,
  raw_token_reduction: RAW_TOKEN_REDUCTION_MIN,
  line_ref_accuracy: LINE_REF_ACCURACY_MIN,
  root_cause_accuracy: ROOT_CAUSE_ACCURACY_MIN,
} as const satisfies Record<CapabilityEvalMetricId, number>;

export const CAPABILITY_EVAL_THRESHOLDS = {
  schema_valid: { direction: "min", threshold: SCHEMA_VALID_MIN },
  recall: { direction: "min", threshold: CRITICAL_EVIDENCE_RECALL_MIN },
  omission: { direction: "max", threshold: CRITICAL_OMISSION_MAX },
  secret_leak: { direction: "max", threshold: SECRET_LEAK_MAX },
  compression: { direction: "min", threshold: COMPRESSION_MIN },
  raw_token_reduction: { direction: "min", threshold: RAW_TOKEN_REDUCTION_MIN },
  line_ref_accuracy: { direction: "min", threshold: LINE_REF_ACCURACY_MIN },
  root_cause_accuracy: { direction: "min", threshold: ROOT_CAUSE_ACCURACY_MIN },
} as const satisfies Record<CapabilityEvalMetricId, CapabilityEvalThresholdRule>;

export function scoreEvalResults(results: readonly CapabilityEvalResult[]): MetricSummary {
  const schemaValid = scoreMetric("schema_valid", results);
  const recall = scoreMetric("recall", results);
  const omission = scoreMetric("omission", results);
  const secretLeak = scoreMetric("secret_leak", results);
  const compression = scoreMetric("compression", results);
  const rawTokenReduction = scoreMetric("raw_token_reduction", results);
  const lineRefAccuracy = scoreMetric("line_ref_accuracy", results);
  const rootCauseAccuracy = scoreMetric("root_cause_accuracy", results);
  const metrics = {
    schema_valid: schemaValid,
    recall,
    omission,
    secret_leak: secretLeak,
    compression,
    raw_token_reduction: rawTokenReduction,
    line_ref_accuracy: lineRefAccuracy,
    root_cause_accuracy: rootCauseAccuracy,
  } satisfies Record<CapabilityEvalMetricId, CapabilityEvalMetricScore>;
  const metricValues = Object.values(metrics);
  const insufficientData = metricValues.some((metric) => metric.status === "insufficient_data");
  return {
    resultCount: results.length,
    passedResultCount: results.filter((result) => result.passed).length,
    insufficientData,
    passed: !insufficientData && metricValues.every((metric) => metric.passed),
    metrics,
  };
}

function scoreMetric(id: CapabilityEvalMetricId, results: readonly CapabilityEvalResult[]): CapabilityEvalMetricScore {
  const rule = CAPABILITY_EVAL_THRESHOLDS[id];
  const value = aggregateMetric(id, results);
  if (value === undefined) {
    return {
      id,
      threshold: rule.threshold,
      direction: rule.direction,
      status: "insufficient_data",
      passed: false,
    };
  }
  const passed = passesThreshold(value, rule);
  return {
    id,
    value,
    threshold: rule.threshold,
    direction: rule.direction,
    status: passed ? "pass" : "fail",
    passed,
  };
}

function aggregateMetric(id: CapabilityEvalMetricId, results: readonly CapabilityEvalResult[]): number | undefined {
  if (results.length === 0) return undefined;
  let total = 0;
  for (const result of results) {
    total += scoreOrWorstCase(id, result);
  }
  if (id === "secret_leak") return total;
  return total / results.length;
}

// Missing ratio metrics use 0 as the documented worst-case score; missing lower-is-better
// safety metrics fail closed with 1 so absent omission/leak fields cannot accidentally pass.
function scoreOrWorstCase(id: CapabilityEvalMetricId, result: CapabilityEvalResult): number {
  const score = result.metricScores[id];
  if (score !== undefined && Number.isFinite(score)) return score;
  switch (id) {
    case "schema_valid":
    case "recall":
    case "compression":
    case "raw_token_reduction":
    case "line_ref_accuracy":
    case "root_cause_accuracy":
      return 0;
    case "omission":
    case "secret_leak":
      return 1;
    default:
      return id;
  }
}

function passesThreshold(value: number, rule: CapabilityEvalThresholdRule): boolean {
  switch (rule.direction) {
    case "min":
      return value >= rule.threshold;
    case "max":
      return value <= rule.threshold;
    case "equals":
      return value === rule.threshold;
    default:
      return rule.direction;
  }
}
