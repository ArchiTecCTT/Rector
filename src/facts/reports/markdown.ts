import { FACT_EVAL_METRIC_IDS, type FactEvalCaseReport, type FactEvalMetricReport, type FactEvalReport } from "./factReport";
import { safeReportText } from "./safety";

const MAX_CELL_LENGTH = 180;
const MAX_REASON_LENGTH = 280;
const MAX_REFS_PER_CASE = 12;

export function renderFactEvalMarkdown(report: FactEvalReport): string {
  const lines: string[] = [];
  lines.push("# Fact Eval Report (Phase 2E offline)");
  lines.push("");
  lines.push(`- Schema: \`${report.schemaVersion}\``);
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Cases passed: ${report.passedCount}/${report.caseCount}`);
  lines.push(`- Failed cases: ${report.failedCount}`);
  lines.push("");
  lines.push("## Safety Notes");
  lines.push("");
  for (const note of report.notes) lines.push(`> ${safeInline(note, MAX_REASON_LENGTH)}`);
  lines.push("");
  lines.push("## Metrics");
  lines.push("");
  lines.push("| metric | value | threshold | direction | passed |");
  lines.push("| --- | ---: | ---: | --- | --- |");
  for (const metric of report.metrics) lines.push(metricRow(metric));
  lines.push("");
  lines.push("## Cases");
  lines.push("");
  lines.push("| case | passed | accepted facts | rejected inputs | source refs |");
  lines.push("| --- | --- | ---: | ---: | --- |");
  for (const caseReport of report.cases) lines.push(caseRow(caseReport));
  lines.push("");
  lines.push("## Per-case Metrics");
  lines.push("");
  lines.push(`| case | ${FACT_EVAL_METRIC_IDS.join(" | ")} |`);
  lines.push(`| --- | ${FACT_EVAL_METRIC_IDS.map(() => "---:").join(" | ")} |`);
  for (const caseReport of report.cases) {
    lines.push(`| \`${safeInline(caseReport.id)}\` | ${FACT_EVAL_METRIC_IDS.map((id) => formatNumber(caseReport.metrics[id] ?? 0)).join(" | ")} |`);
  }
  lines.push("");
  lines.push("## Fact IDs and Source Refs");
  lines.push("");
  lines.push("| case | fact id | kind | trust | source refs |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const caseReport of report.cases) {
    for (const factRef of caseReport.factRefs) {
      lines.push(`| \`${safeInline(caseReport.id)}\` | \`${safeInline(factRef.factId)}\` | \`${safeInline(factRef.kind)}\` | \`${safeInline(factRef.trustLevel)}\` | ${safeInline(formatSourceRefs(factRef.sourceRefs), MAX_CELL_LENGTH)} |`);
    }
  }
  lines.push("");
  lines.push("## Recorded Failures");
  lines.push("");
  const failures = report.cases.filter((caseReport) => !caseReport.passed);
  if (failures.length === 0) {
    lines.push("No failed fact eval cases recorded.");
  } else {
    for (const failure of failures) {
      lines.push(`- \`${safeInline(failure.id)}\``);
      for (const reason of failure.failureReasons) lines.push(`  - ${safeInline(reason, MAX_REASON_LENGTH)}`);
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function metricRow(metric: FactEvalMetricReport): string {
  return `| ${metric.id} | ${formatNumber(metric.value)} | ${formatNumber(metric.threshold)} | ${metric.direction} | ${metric.passed ? "true" : "false"} |`;
}

function caseRow(caseReport: FactEvalCaseReport): string {
  return `| \`${safeInline(caseReport.id)}\` | ${caseReport.passed ? "true" : "false"} | ${caseReport.acceptedFactCount} | ${caseReport.rejectedInputCount} | ${safeInline(formatCaseSourceRefs(caseReport), MAX_CELL_LENGTH)} |`;
}

function formatCaseSourceRefs(caseReport: FactEvalCaseReport): string {
  const refs = caseReport.factRefs.flatMap((factRef) => factRef.sourceRefs.map((ref) => `${ref.refType}:${ref.ref}`));
  const deduped = [...new Set(refs)].slice(0, MAX_REFS_PER_CASE);
  const suffix = refs.length > deduped.length ? ` (+${refs.length - deduped.length} more)` : "";
  return `${deduped.join(", ")}${suffix}` || "n/a";
}

function formatSourceRefs(refs: FactEvalCaseReport["factRefs"][number]["sourceRefs"]): string {
  if (refs.length === 0) return "n/a";
  const shown = refs.slice(0, MAX_REFS_PER_CASE).map((ref) => `${ref.refType}:${ref.ref}`);
  const suffix = refs.length > shown.length ? ` (+${refs.length - shown.length} more)` : "";
  return `${shown.join(", ")}${suffix}`;
}

function safeInline(value: string, maxLength = MAX_CELL_LENGTH): string {
  return safeReportText(value, maxLength);
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(4);
}
