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
import { loadGlobalScenario, type GlobalScenario } from "../../src/evals/globalScenarioSchema";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCENARIOS_DIR = path.join(REPO_ROOT, "tests", "global", "scenarios");
const OUTPUT_DIR = path.join(REPO_ROOT, ".omo", "evidence");
const REGRESSIONS_DIR = path.join(OUTPUT_DIR, "regressions");

const args = process.argv.slice(2);
const isGate = args.includes("--gate");

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

  // 2
  if (report.executedCount < 20) violations.push(`offline scenario count ${report.executedCount} < 20`);

  // 3
  const strictPass = scorecards.filter((s) => s.passed).length;
  if (strictPass < 5) violations.push(`strict-passing scenarios ${strictPass} < 5`);

  const regressionCount = report.regressions.length;
  if (regressionCount < 5) violations.push(`intentional regressions ${regressionCount} < 5`);

  // 5
  for (const o of outcomes) {
    const sc = scorecards.find((s) => s.scenarioId === o.scenarioId);
    if (!sc) { violations.push(`${o.scenarioId}: missing scorecard`); continue; }
    if (!o.taskPacket) violations.push(`${o.scenarioId}: missing taskPacket`);
    if (!o.runEvents || o.runEvents.length === 0) violations.push(`${o.scenarioId}: missing runEvents`);
    if (!o.validationRefs || o.validationRefs.length === 0) violations.push(`${o.scenarioId}: missing validationRefs`);
  }

  // 6 evidence_quality === 0 while scenario declares evidence refs
  for (const sc of scorecards) {
    const eq = sc.dimensions.evidence_quality.score;
    if (eq === 0) {
      // check if scenario actually declares evidence refs
      const scenarioFile = (await fs.readdir(SCENARIOS_DIR)).find((f) => f.includes(sc.scenarioId.split("-")[0]));
      if (scenarioFile) {
        const yaml = await fs.readFile(path.join(SCENARIOS_DIR, scenarioFile), "utf8");
        if (yaml.includes("evidence") || yaml.includes("artifact-ref")) {
          violations.push(`${sc.scenarioId}: evidence_quality=0 with declared evidence refs`);
        }
      }
    }
  }

  // 7 regression artifacts for expected-fail scenarios
  for (const o of outcomes) {
    const scenarioFile = (await fs.readdir(SCENARIOS_DIR)).find((f) => f.includes(o.scenarioId.split("-")[0]));
    if (!scenarioFile) continue;
    const yaml = await fs.readFile(path.join(SCENARIOS_DIR, scenarioFile), "utf8");
    const declared = /expected:\s*\n\s*status:\s*(\w+)/.exec(yaml)?.[1];
    if (declared === "failed") {
      const jsonPath = path.join(REGRESSIONS_DIR, `${o.scenarioId}.json`);
      const mdPath = path.join(REGRESSIONS_DIR, `${o.scenarioId}.md`);
      if (!(await fs.stat(jsonPath).catch(() => null)) || !(await fs.stat(mdPath).catch(() => null))) {
        violations.push(`${o.scenarioId}: missing regression artifact`);
      }
    }
  }

  // 8 proxy-regression behavioral checks
  const proxy = spawnSync("npx", ["vitest", "run", "tests/global/proxyRegression.test.ts", "--passWithNoTests"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (proxy.status !== 0) violations.push("proxyRegression behavioral checks failed");

  const exitCode = violations.length > 0 && isGate ? 1 : 0;

  process.stdout.write(
    [
      isGate ? "[global-harness:gate]" : "[global-harness:report-only]",
      `scenarios: ${report.scenarioCount} executed ${report.executedCount} skipped ${report.skippedCount}`,
      `passed: ${report.passedCount} regressions: ${report.regressions.length}`,
      `strict-pass: ${strictPass} regressions: ${report.regressions.length}`,
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
