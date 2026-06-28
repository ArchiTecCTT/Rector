import { z } from "zod";

import { RectorFactSchema } from "../schemas";
import { safeReportText } from "./safety";
import type { FactValidationError, RectorFact } from "../types";

export const FACT_EVAL_REPORT_SCHEMA_VERSION = "rector.fact-eval-report.v1";

export const FACT_EVAL_METRIC_IDS = [
  "schema_valid_rate",
  "provenance_complete_rate",
  "grounding_success_rate",
  "insufficient_evidence_correctness",
  "hallucinated_reference_count",
  "secret_leak_count",
  "replay_success_rate",
  "fact_diff_accuracy",
  "raw_artifact_ref_coverage",
  "trust_transition_violation_count",
] as const;

export type FactEvalMetricId = (typeof FACT_EVAL_METRIC_IDS)[number];

const FactEvalMetricIdSchema = z.enum(FACT_EVAL_METRIC_IDS);

export const FactEvalCaseSourceRefSchema = z
  .object({
    refType: z.enum(["artifact", "graph", "validation", "insufficient_evidence", "source_span", "run_event", "global_scenario", "system"]),
    ref: z.string().min(1),
  })
  .strict();

export const FactEvalFactRefSchema = z
  .object({
    factId: z.string().min(1),
    kind: z.string().min(1),
    trustLevel: z.string().min(1),
    sourceRefs: z.array(FactEvalCaseSourceRefSchema),
  })
  .strict();

export const FactValidationErrorReportSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    path: z.array(z.union([z.string(), z.number()])).default([]),
    severity: z.enum(["info", "warning", "error"]).default("error"),
  })
  .strict();

export const FactEvalMetricReportSchema = z
  .object({
    id: FactEvalMetricIdSchema,
    value: z.number().finite(),
    threshold: z.number().finite(),
    direction: z.enum(["min", "max"]),
    passed: z.boolean(),
  })
  .strict();

export const FactEvalCaseReportSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    passed: z.boolean(),
    acceptedFactCount: z.number().int().nonnegative(),
    rejectedInputCount: z.number().int().nonnegative(),
    failureReasons: z.array(z.string().min(1)),
    metrics: z.record(FactEvalMetricIdSchema, z.number().finite()),
    factRefs: z.array(FactEvalFactRefSchema),
    validationErrors: z.array(FactValidationErrorReportSchema),
  })
  .strict();

export const FactEvalReportSchema = z
  .object({
    schemaVersion: z.literal(FACT_EVAL_REPORT_SCHEMA_VERSION),
    generatedAt: z.string().datetime(),
    caseCount: z.number().int().nonnegative(),
    passedCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(),
    metrics: z.array(FactEvalMetricReportSchema),
    cases: z.array(FactEvalCaseReportSchema),
    notes: z.array(z.string().min(1)),
  })
  .strict();

export type FactEvalCaseSourceRef = Readonly<z.infer<typeof FactEvalCaseSourceRefSchema>>;
export type FactEvalFactRef = Readonly<z.infer<typeof FactEvalFactRefSchema>>;
export type FactEvalMetricReport = Readonly<z.infer<typeof FactEvalMetricReportSchema>>;
export type FactEvalCaseReport = Readonly<z.infer<typeof FactEvalCaseReportSchema>>;
export type FactEvalReport = Readonly<z.infer<typeof FactEvalReportSchema>>;

export const FACT_EVAL_METRIC_THRESHOLDS: Readonly<Record<FactEvalMetricId, { threshold: number; direction: "min" | "max" }>> = {
  schema_valid_rate: { threshold: 1, direction: "min" },
  provenance_complete_rate: { threshold: 1, direction: "min" },
  grounding_success_rate: { threshold: 1, direction: "min" },
  insufficient_evidence_correctness: { threshold: 1, direction: "min" },
  hallucinated_reference_count: { threshold: 0, direction: "max" },
  secret_leak_count: { threshold: 0, direction: "max" },
  replay_success_rate: { threshold: 1, direction: "min" },
  fact_diff_accuracy: { threshold: 1, direction: "min" },
  raw_artifact_ref_coverage: { threshold: 1, direction: "min" },
  trust_transition_violation_count: { threshold: 0, direction: "max" },
};

const REPORT_NOTES = [
  "Phase 2E fact evals are deterministic offline fixtures; they do not prove live provider reliability.",
  "Reports link fact ids to artifact, graph, validation, run-event, or scenario refs and intentionally omit raw tool logs and secret payloads.",
  "Negative cases pass only when malformed, fake-provenance, or secret-like inputs are rejected or represented as insufficient evidence.",
] as const;

function sanitizeCaseForReport(caseReport: FactEvalCaseReport): FactEvalCaseReport {
  return {
    ...caseReport,
    failureReasons: caseReport.failureReasons.map((reason) => safeReportText(reason)),
    validationErrors: caseReport.validationErrors.map((entry) => ({
      ...entry,
      message: safeReportText(entry.message),
    })),
  };
}

export function buildFactEvalReport(input: {
  readonly generatedAt: string;
  readonly cases: readonly FactEvalCaseReport[];
}): FactEvalReport {
  const caseReports = input.cases.map((caseReport) => FactEvalCaseReportSchema.parse(sanitizeCaseForReport(caseReport)));
  const metrics = FACT_EVAL_METRIC_IDS.map((id) => {
    const values: number[] = caseReports.map((caseReport) => Number(caseReport.metrics[id] ?? 0));
    const value = values.length === 0 ? 0 : values.reduce((sum, metric) => sum + metric, 0) / values.length;
    const threshold = FACT_EVAL_METRIC_THRESHOLDS[id] ?? { threshold: 0, direction: "min" as const };
    return FactEvalMetricReportSchema.parse({
      id,
      value,
      threshold: threshold.threshold,
      direction: threshold.direction,
      passed: threshold.direction === "min" ? value >= threshold.threshold : value <= threshold.threshold,
    });
  });
  const passedCount = caseReports.filter((caseReport) => caseReport.passed).length;
  return FactEvalReportSchema.parse({
    schemaVersion: FACT_EVAL_REPORT_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    caseCount: caseReports.length,
    passedCount,
    failedCount: caseReports.length - passedCount,
    metrics,
    cases: caseReports,
    notes: [...REPORT_NOTES],
  });
}

export function factRefsForReport(facts: readonly RectorFact[]): FactEvalFactRef[] {
  return facts.map((fact) => {
    const parsed = RectorFactSchema.parse(fact);
    return FactEvalFactRefSchema.parse({
      factId: parsed.factId,
      kind: parsed.kind,
      trustLevel: parsed.trust.level,
      sourceRefs: sourceRefsForFact(parsed),
    });
  });
}

export function validationErrorsForReport(errors: readonly FactValidationError[]): FactEvalCaseReport["validationErrors"] {
  return errors.map((error) => ({
    code: error.code,
    message: error.message,
    path: [...error.path],
    severity: error.severity,
  }));
}

export function sourceRefsForFact(fact: RectorFact): FactEvalCaseSourceRef[] {
  const refs: FactEvalCaseSourceRef[] = [];
  for (const provenance of fact.provenance) {
    if (provenance.sourceType === "artifact") refs.push({ refType: "artifact", ref: provenance.artifact.uri });
    if (provenance.sourceType === "graph") refs.push({ refType: "graph", ref: formatGraphRef(provenance.graph) });
    if (provenance.sourceType === "validation") refs.push({ refType: "validation", ref: provenance.validation.validationId });
    if (provenance.sourceType === "run_event") refs.push({ refType: "run_event", ref: provenance.eventId });
    if (provenance.sourceType === "global_harness") refs.push({ refType: "global_scenario", ref: provenance.scenarioId });
    if (provenance.sourceType === "system") refs.push({ refType: "system", ref: provenance.systemId });
    if (provenance.sourceType === "tool_call" && provenance.artifact) refs.push({ refType: "artifact", ref: provenance.artifact.uri });
    if (provenance.sourceType === "capability_eval" && provenance.artifact) refs.push({ refType: "artifact", ref: provenance.artifact.uri });
    if (provenance.sourceType === "llm_shadow" && provenance.artifact) refs.push({ refType: "artifact", ref: provenance.artifact.uri });
  }
  collectEvidenceRefs(fact, refs);
  return dedupeSourceRefs(refs);
}

function collectEvidenceRefs(value: unknown, refs: FactEvalCaseSourceRef[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectEvidenceRefs(item, refs);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (record.refType === "artifact" && typeof record.uri === "string") refs.push({ refType: "artifact", ref: record.uri });
  if (record.refType === "graph" && typeof record.snapshotId === "string") refs.push({ refType: "graph", ref: formatGraphRef(record) });
  if (record.refType === "validation" && typeof record.validationId === "string") refs.push({ refType: "validation", ref: record.validationId });
  if (record.refType === "insufficient_evidence" && typeof record.reason === "string") refs.push({ refType: "insufficient_evidence", ref: record.reason });
  if (record.refType === "source_span" && typeof record.path === "string") refs.push({ refType: "source_span", ref: `${record.path}:${String(record.startLine ?? "?")}-${String(record.endLine ?? "?")}` });
  for (const nested of Object.values(record)) collectEvidenceRefs(nested, refs);
}

function formatGraphRef(graph: { readonly snapshotId?: unknown; readonly nodeId?: unknown; readonly edgeId?: unknown; readonly queryStatus?: unknown }): string {
  const objectId = typeof graph.nodeId === "string" ? graph.nodeId : typeof graph.edgeId === "string" ? graph.edgeId : "snapshot";
  const status = typeof graph.queryStatus === "string" ? `:${graph.queryStatus}` : "";
  return `${String(graph.snapshotId)}:${objectId}${status}`;
}

function dedupeSourceRefs(refs: readonly FactEvalCaseSourceRef[]): FactEvalCaseSourceRef[] {
  const seen = new Set<string>();
  const deduped: FactEvalCaseSourceRef[] = [];
  for (const ref of refs) {
    const key = `${ref.refType}:${ref.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(FactEvalCaseSourceRefSchema.parse(ref));
  }
  return deduped;
}
