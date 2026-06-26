#!/usr/bin/env tsx
/**
 * Global harness gate (strict) + report-only entry point.
 * --gate  : exit 1 on ANY violation. Never requires every scenario to pass.
 * --report-only : always exit 0.
 *
 * Gate conditions (any triggers exit 1):
 * 1. Any scenario ACTUAL status differs from declared expected.status
 * 2. <20 offline scenarios executed
 * 3. <5 strict-passing scenarios (scorecard.passed === true)
 * 4. <5 intentional regressions (expected.status==="failed" AND actually failed)
 * 5. Any executed scenario missing: taskPacket OR runEvents OR validationRefs OR scorecard
 * 6. Any evidence ref unresolvable (evidence_quality dimension === 0 for a scenario that declares evidence refs)
 * 7. No standalone regression artifact for an expected-failing scenario
 * 8. proxyRegression behavioral checks fail (run vitest on proxyRegression.test.ts)
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";

import { runGlobalHarness } from "../../src/evals/globalRunner";
import { auditNoProductionFakes } from "../audit/no-production-fakes";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCENARIOS_DIR = path.join(REPO_ROOT, "tests", "global", "scenarios");
const OUTPUT_DIR = path.join(REPO_ROOT, ".omo", "evidence");
const REGRESSIONS_DIR = path.join(OUTPUT_DIR, "regressions");

const args = process.argv.slice(2);
const isGate = args.includes("--gate");

function checkOfflineCount(executedCount: number, violations: string[]): void {
  if (executedCount < 20) violations.push(`offline scenario count ${executedCount} < 20`);
}

function checkStatusConsistency(
  outcomes: readonly { scenarioId: string; expectedStatus: string; actualStatus: string }[],
  report: { skipped: readonly { scenarioId: string; expectedStatus: string }[]; scenarioCount: number },
  violations: string[],
): number {
  let intentionalRegressionCount = 0;
  const accounted = new Set<string>();
  for (const o of outcomes) {
    accounted.add(o.scenarioId);
    const declared = o.expectedStatus;
    const actual = o.actualStatus;
    if (declared !== actual) violations.push(`${o.scenarioId}: declared ${declared} but actually ${actual}`);
    if (declared === "failed" && actual === "failed") intentionalRegressionCount++;
  }
  for (const s of report.skipped) {
    accounted.add(s.scenarioId);
    if (s.expectedStatus !== "skipped") violations.push(`${s.scenarioId}: declared ${s.expectedStatus} but actually skipped`);
  }
  if (accounted.size !== report.scenarioCount) {
    violations.push(`accounted scenarios ${accounted.size} != scenario count ${report.scenarioCount}`);
  }
  return intentionalRegressionCount;
}

function checkRequiredArtifacts(
  outcomes: readonly { scenarioId: string; taskPacket?: unknown; runEvents?: readonly unknown[]; validationRefs?: readonly unknown[] }[],
  scorecards: readonly { scenarioId: string }[],
  violations: string[],
): void {
  for (const o of outcomes as any[]) {
    const sc = (scorecards as any[]).find((s: any) => s.scenarioId === o.scenarioId);
    if (!sc) { violations.push(`${o.scenarioId}: missing scorecard`); continue; }
    if (!o.taskPacket) violations.push(`${o.scenarioId}: missing taskPacket`);
    if (!o.runEvents || o.runEvents.length === 0) violations.push(`${o.scenarioId}: missing runEvents`);
    if (!o.validationRefs || o.validationRefs.length === 0) violations.push(`${o.scenarioId}: missing validationRefs`);
  }
}

async function checkEvidenceQuality(
  outcomes: readonly { scenarioId: string; scenarioFile: string; expectedStatus: string }[],
  scorecards: readonly { scenarioId: string; dimensions: { evidence_quality: { score: number } } }[],
  violations: string[],
): Promise<void> {
  for (const o of outcomes as any[]) {
    const sc = (scorecards as any[]).find((s: any) => s.scenarioId === o.scenarioId);
    if (!sc) continue;
    const eq = sc.dimensions.evidence_quality.score;
    if (eq === 0 && o.expectedStatus === "passed") {
      const yaml = await fs.readFile(path.join(SCENARIOS_DIR, o.scenarioFile), "utf8");
      if (yaml.includes("evidence") || yaml.includes("artifact-ref")) {
        violations.push(`${o.scenarioId}: evidence_quality=0 with declared evidence refs`);
      }
    }
  }
}

async function checkRegressionArtifacts(
  outcomes: readonly { scenarioId: string; expectedStatus: string }[],
  violations: string[],
): Promise<void> {
  for (const o of outcomes) {
    if (o.expectedStatus === "failed") {
      const jsonPath = path.join(REGRESSIONS_DIR, `${o.scenarioId}.json`);
      const mdPath = path.join(REGRESSIONS_DIR, `${o.scenarioId}.md`);
      if (!(await fs.stat(jsonPath).catch(() => null)) || !(await fs.stat(mdPath).catch(() => null))) {
        violations.push(`${o.scenarioId}: missing regression artifact`);
      }
    }
  }
}

async function checkProxyRegression(repoRoot: string, violations: string[]): Promise<void> {
  const vitestBin = path.join(repoRoot, "node_modules", ".bin", "vitest");
  const vitestCmd = (await fs.stat(vitestBin).catch(() => null)) ? vitestBin : "npx";
  const vitestArgs = (vitestCmd === "npx") ? ["--no-install", "vitest", "run", "tests/global/proxyRegression.test.ts", "--passWithNoTests"] : ["run", "tests/global/proxyRegression.test.ts", "--passWithNoTests"];
  const proxy = spawnSync(vitestCmd, vitestArgs, { cwd: repoRoot, encoding: "utf8", stdio: "pipe" });
  if (proxy.status !== 0) violations.push("proxyRegression behavioral checks failed");
}

async function main(): Promise<void> {
  const result = await runGlobalHarness({
    scenariosDir: SCENARIOS_DIR,
    outputDir: OUTPUT_DIR,
    write: true,
    fakePathAuditor: async () => {
      const audit = await auditNoProductionFakes({ repoRoot: REPO_ROOT });
      return { findingCount: audit.findingCount };
    },
  });

  const { report, scorecards } = result;
  const outcomes = report.outcomes;
  const violations: string[] = [];

  checkOfflineCount(report.executedCount, violations);
  const strictPass = scorecards.filter((s) => s.passed).length;
  if (strictPass < 5) violations.push(`strict-passing scenarios ${strictPass} < 5`);
  const intentionalRegressionCount = checkStatusConsistency(outcomes, report, violations);
  if (intentionalRegressionCount < 5) violations.push(`intentional regressions ${intentionalRegressionCount} < 5`);

  checkRequiredArtifacts(outcomes, scorecards, violations);
  await checkEvidenceQuality(outcomes, scorecards, violations);
  await checkRegressionArtifacts(outcomes, violations);
  await checkProxyRegression(REPO_ROOT, violations);

  const exitCode = violations.length > 0 && isGate ? 1 : 0;

  process.stdout.write(
    [
      isGate ? "[global-harness:gate]" : "[global-harness:report-only]",
      `scenarios: ${report.scenarioCount} executed ${report.executedCount} skipped ${report.skippedCount}`,
      `passed: ${report.passedCount} regressions: ${report.regressions.length}`,
      `strict-pass: ${strictPass} intentional: ${intentionalRegressionCount}`,
      violations.length ? `VIOLATIONS: ${violations.join("; ")}` : "gate passed",
    ].join("\n") + "\n",
  );

  if (exitCode === 1) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(`[global-harness:gate] fatal: ${String(e)}\n`);
    process.exit(1);
  });
}
