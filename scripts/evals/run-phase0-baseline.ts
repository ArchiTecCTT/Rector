#!/usr/bin/env tsx

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

import {
  buildPhase0Baseline,
  Phase0BaselineSchema,
  type Phase0Baseline,
} from "../../src/capabilities/eval/baseline";
import { EvalCorpusManifestSchema } from "../../tests/fixtures/eval-corpus/manifest.schema";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const OUTPUT_DIR = path.join(REPO_ROOT, ".omo", "evidence");

function getGitInfo(): { branch: string; headSha: string } {
  const branch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
  const headSha = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  return { branch, headSha };
}

function renderMarkdown(baseline: Phase0Baseline): string {
  const lines: string[] = [];
  lines.push("# Phase 0 Baseline Report");
  lines.push("");
  lines.push(`**Schema Version:** ${baseline.schemaVersion}`);
  lines.push(`**Generated At:** ${baseline.generatedAt}`);
  lines.push("");
  lines.push("## Git");
  lines.push(`- Branch: ${baseline.git.branch}`);
  lines.push(`- HEAD: ${baseline.git.headSha}`);
  lines.push("");
  lines.push("## Test Baseline");
  lines.push(`- Total: ${baseline.testBaseline.totalTests}`);
  lines.push(`- Passed: ${baseline.testBaseline.passed}`);
  lines.push(`- Skipped: ${baseline.testBaseline.skipped}`);
  lines.push("");
  lines.push("## Capability Corpus");
  lines.push(`- Cases: ${baseline.capabilityCorpus.caseCount}`);
  lines.push(`- Artifact Kinds: ${baseline.capabilityCorpus.artifactKinds.join(", ")}`);
  lines.push("");
  lines.push("## Fake Audit (report-only)");
  lines.push(`- Findings: ${baseline.fakeAudit.findingCount}`);
  for (const [rule, count] of Object.entries(baseline.fakeAudit.perRule)) {
    lines.push(`  - ${rule}: ${count}`);
  }
  lines.push("");
  lines.push("## Metric Thresholds (Phase 0)");
  for (const [k, v] of Object.entries(baseline.metricThresholds)) {
    lines.push(`- ${k}: ${v}`);
  }
  lines.push("");
  lines.push("## Validation Strength Rubric (T0-T5)");
  for (const [k, v] of Object.entries(baseline.validationStrengthRubric)) {
    lines.push(`- ${k}: ${v}`);
  }
  lines.push("");
  lines.push("## Cost / Risk Definitions");
  lines.push(`- Token Estimator: ${baseline.costRiskDefinitions.tokenEstimator}`);
  lines.push(`- Fake Audit Policy: ${baseline.costRiskDefinitions.fakeAuditPolicy}`);
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const git = getGitInfo();

  const manifestRaw = await fs.readFile(
    path.join(REPO_ROOT, "tests/fixtures/eval-corpus/manifest.json"),
    "utf8",
  );
  const manifest = EvalCorpusManifestSchema.parse(JSON.parse(manifestRaw));
  const artifactKinds = Array.from(new Set(manifest.cases.map((c) => c.artifactKind)));

  const fakeModule = await import("../../scripts/audit/no-production-fakes");
  const fakeAuditReport = await fakeModule.auditNoProductionFakes();

  const testBaseline = { totalTests: 2241, passed: 2236, skipped: 5 };

  const baseline = await buildPhase0Baseline({
    gitBranch: git.branch,
    gitHeadSha: git.headSha,
    testBaseline,
    capabilityCorpus: { caseCount: manifest.cases.length, artifactKinds },
    fakeAuditReport,
  });

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const jsonPath = path.join(OUTPUT_DIR, "phase0-baseline.json");
  const mdPath = path.join(OUTPUT_DIR, "phase0-baseline.md");

  await fs.writeFile(jsonPath, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
  await fs.writeFile(mdPath, renderMarkdown(baseline), "utf8");

  process.stdout.write(
    `[phase0-baseline] wrote ${path.relative(REPO_ROOT, jsonPath)} and ${path.relative(REPO_ROOT, mdPath)}\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`[phase0-baseline] FAILED: ${String(err)}\n`);
    process.exitCode = 1;
  });
}
