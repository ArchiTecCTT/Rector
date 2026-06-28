#!/usr/bin/env tsx
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FACT_EVAL_METRIC_IDS, FactEvalReportSchema } from "../../src/facts";
import { runFactEvals } from "./run-fact-evals";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export async function validatePhase2(): Promise<string[]> {
  const failures: string[] = [];
  const output = await runFactEvals({ write: true });
  const report = FactEvalReportSchema.parse(output.report);
  if (report.caseCount < 10) failures.push(`fact eval case count ${report.caseCount} < 10`);
  if (report.failedCount !== 0) failures.push(`${report.failedCount} fact eval case(s) failed`);
  for (const metricId of FACT_EVAL_METRIC_IDS) {
    if (!report.metrics.some((metric) => metric.id === metricId)) failures.push(`missing metric ${metricId}`);
  }
  for (const metric of report.metrics) {
    if (!metric.passed) failures.push(`metric ${metric.id} did not meet ${metric.direction} ${metric.threshold}: ${metric.value}`);
  }
  if (!output.jsonPath || !output.markdownPath) failures.push("fact eval reports were not written");
  for (const caseReport of report.cases) {
    if (caseReport.acceptedFactCount > 0 && caseReport.factRefs.length === 0) failures.push(`case ${caseReport.id} accepted facts but has no report fact refs`);
    for (const factRef of caseReport.factRefs) {
      if (factRef.sourceRefs.length === 0) failures.push(`fact ${factRef.factId} in case ${caseReport.id} has no source refs`);
    }
  }
  return failures;
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return fileURLToPath(import.meta.url) === path.resolve(entry);
}

if (isMain()) {
  validatePhase2().then((failures) => {
    if (failures.length > 0) {
      process.stderr.write(`[verify:phase2] FAIL: ${failures.join("; ")}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write("[verify:phase2] fact eval validation PASS\n");
    process.stdout.write("[verify:phase2] wrote .omo/evidence/fact-report.json and .omo/evidence/fact-report.md\n");
  }).catch((error: unknown) => {
    process.stderr.write(`[verify:phase2] FAILED: ${String(error)}\n`);
    process.stderr.write(`repo: ${REPO_ROOT}\n`);
    process.exitCode = 1;
  });
}
