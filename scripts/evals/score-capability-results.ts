import { z } from "zod";

import {
  CAPABILITY_EVAL_METRIC_IDS,
  type CapabilityEvalMetricId,
  type CapabilityEvalMetricScore,
  type MetricSummary,
} from "../../src/capabilities/eval/metrics";
import { CapabilityEvalResultSchema, type CapabilityEvalResult } from "../../src/capabilities/eval/schemas";
import type { RawArtifactRecord } from "../../src/capabilities/eval/artifactStore";

export const CAPABILITY_EVAL_REPORT_SCHEMA_VERSION = "rector.capability-eval-report.v1";

/**
 * Honesty note rendered verbatim into eval-report.md.
 *
 * Phase 0 proves the eval HARNESS is wired and computes real comparisons. The offline corpus is
 * intentionally tiny (a few committed command artifacts), so the efficiency thresholds that target
 * large, noisy live tool outputs are NOT met by these fixtures by design. We keep the aggregate
 * truthfully `false` rather than fabricate metric values to force a green report.
 */
export const OFFLINE_REPORT_NOTES: readonly string[] = [
  "Offline Phase-0 corpus is intentionally tiny: it ships a few committed real command artifacts (rg, tsc, git).",
  "The compression (>=10x) and raw_token_reduction (>=0.80) thresholds target large, noisy LIVE tool outputs and are NOT met by these fixtures by design.",
  "Harness wiring and the evidence metrics (schema_valid, recall, omission, secret_leak, line_ref_accuracy, root_cause_accuracy) reflect REAL artifact-vs-oracle comparisons.",
  "compression here is the offline structural concentration of the committed artifact, NOT model summarization; it is honestly low on tiny fixtures.",
  "A per-case oracle failure is RECORDED here as a failure, never silently passed. Live threshold attainment is Phase 2.5.",
] as const;

const MetricScoreReportSchema = z
  .object({
    id: z.enum(CAPABILITY_EVAL_METRIC_IDS),
    value: z.number().finite().optional(),
    threshold: z.number(),
    direction: z.enum(["min", "max", "equals"]),
    status: z.enum(["pass", "fail", "insufficient_data"]),
    passed: z.boolean(),
  })
  .strict();

const MetricSummaryReportSchema = z
  .object({
    resultCount: z.number().int().nonnegative(),
    passedResultCount: z.number().int().nonnegative(),
    insufficientData: z.boolean(),
    passed: z.boolean(),
    metrics: z.record(MetricScoreReportSchema),
  })
  .strict();

const RawArtifactRecordSummarySchema = z
  .object({
    uri: z.string().min(1),
    sha256: z.string().min(1),
    redactionState: z.enum(["no_secrets_detected", "redacted"]),
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict();

export const CapabilityEvalRunReportSchema = z
  .object({
    schemaVersion: z.literal(CAPABILITY_EVAL_REPORT_SCHEMA_VERSION),
    generatedAt: z.string().datetime(),
    corpus: z
      .object({
        schemaVersion: z.string().min(1),
        description: z.string().min(1),
        caseCount: z.number().int().nonnegative(),
      })
      .strict(),
    results: z.array(CapabilityEvalResultSchema),
    summary: MetricSummaryReportSchema,
    rawArtifactRecords: z.array(RawArtifactRecordSummarySchema),
    notes: z.array(z.string().min(1)).min(1),
  })
  .strict();

export type CapabilityEvalRunReport = Readonly<z.infer<typeof CapabilityEvalRunReportSchema>>;

export function buildCapabilityEvalRunReport(input: {
  readonly generatedAt: string;
  readonly corpus: { readonly schemaVersion: string; readonly description: string; readonly caseCount: number };
  readonly results: readonly CapabilityEvalResult[];
  readonly summary: MetricSummary;
  readonly rawArtifactRecords?: readonly Pick<RawArtifactRecord, "uri" | "sha256" | "redactionState" | "sizeBytes">[];
}): CapabilityEvalRunReport {
  const report = {
    schemaVersion: CAPABILITY_EVAL_REPORT_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    corpus: input.corpus,
    results: input.results.map((result) => CapabilityEvalResultSchema.parse(result)),
    summary: input.summary,
    rawArtifactRecords: (input.rawArtifactRecords ?? []).map((r) =>
      RawArtifactRecordSummarySchema.parse({
        uri: r.uri,
        sha256: r.sha256,
        redactionState: r.redactionState,
        sizeBytes: r.sizeBytes,
      }),
    ),
    notes: [...OFFLINE_REPORT_NOTES],
  };
  return CapabilityEvalRunReportSchema.parse(report);
}

function formatNumber(value: number | undefined): string {
  if (value === undefined) return "n/a";
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(4);
}

function metricRow(score: CapabilityEvalMetricScore): string {
  return `| ${score.id} | ${formatNumber(score.value)} | ${score.direction} ${formatNumber(score.threshold)} | ${score.status} |`;
}

function caseScore(result: CapabilityEvalResult, id: CapabilityEvalMetricId): string {
  return formatNumber(result.metricScores[id]);
}

/**
 * Renders the deterministic offline capability-eval report as Markdown. Every one of the eight
 * capability metric ids is emitted in the aggregate table so downstream readers can confirm the
 * full metric surface was scored, even when a metric honestly fails its threshold.
 */
export function renderCapabilityEvalMarkdown(report: CapabilityEvalRunReport): string {
  const { summary } = report;
  const lines: string[] = [];
  lines.push("# Capability Eval Report (offline Phase-0)");
  lines.push("");
  lines.push(`- Schema: \`${report.schemaVersion}\``);
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Corpus: \`${report.corpus.schemaVersion}\` (${report.corpus.caseCount} cases)`);
  lines.push(`- Aggregate passed: **${summary.passed ? "true" : "false"}**`);
  lines.push(`- Cases passed: ${summary.passedResultCount}/${summary.resultCount}`);
  lines.push("");
  lines.push("## Honesty Note");
  lines.push("");
  for (const note of report.notes) {
    lines.push(`> ${note}`);
  }
  lines.push("");
  lines.push("## Aggregate Metrics");
  lines.push("");
  lines.push("| metric | value | threshold | status |");
  lines.push("| --- | --- | --- | --- |");
  for (const id of CAPABILITY_EVAL_METRIC_IDS) {
    lines.push(metricRow(summary.metrics[id]));
  }
  lines.push("");
  lines.push("## Per-case Results");
  lines.push("");
  lines.push("| case | capability | passed | recall | omission | secret_leak | compression | raw_token_reduction |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const result of report.results) {
    lines.push(
      `| ${result.caseId} | ${result.capabilityId} | ${result.passed ? "true" : "false"} | ` +
        `${caseScore(result, "recall")} | ${caseScore(result, "omission")} | ${caseScore(result, "secret_leak")} | ` +
        `${caseScore(result, "compression")} | ${caseScore(result, "raw_token_reduction")} |`,
    );
  }
  lines.push("");
  lines.push("## Recorded Failures");
  lines.push("");
  const failures = report.results.filter((result) => !result.passed);
  if (failures.length === 0) {
    lines.push("No per-case oracle failures recorded.");
  } else {
    for (const failure of failures) {
      const reason = failure.failureReason ?? "oracle check failed";
      lines.push(`- \`${failure.caseId}\`: ${reason}`);
      for (const omission of failure.omissions) {
        lines.push(`  - omitted: ${omission}`);
      }
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}
