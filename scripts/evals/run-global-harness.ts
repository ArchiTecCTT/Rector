import path from "node:path";
import { fileURLToPath } from "node:url";

import { auditNoProductionFakes } from "../audit/no-production-fakes";
import { runGlobalHarness } from "../../src/evals/globalRunner";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

async function main(): Promise<void> {
  const result = await runGlobalHarness({
    fakePathAuditor: async () => {
      const audit = await auditNoProductionFakes({ repoRoot: REPO_ROOT });
      return { findingCount: audit.findingCount };
    },
  });
  const { report } = result;
  process.stdout.write(
    [
      "[global-harness] offline run complete (no model).",
      `  scenarios: ${report.scenarioCount} (executed ${report.executedCount}, skipped ${report.skippedCount})`,
      `  passed: ${report.passedCount}/${report.executedCount}`,
      `  fake-path: ${report.fakePathStatus} (${report.fakeFindingCount} findings, report-only)`,
      result.jsonPath ? `  json: ${path.relative(REPO_ROOT, result.jsonPath)}` : "",
      result.markdownPath ? `  md:   ${path.relative(REPO_ROOT, result.markdownPath)}` : "",
    ]
      .filter((line) => line.length > 0)
      .join("\n") + "\n",
  );
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return fileURLToPath(import.meta.url) === path.resolve(entry);
}

if (isMain()) {
  main().catch((error: unknown) => {
    process.stderr.write(`[global-harness] FAILED to produce report: ${String(error)}\n`);
    process.exitCode = 1;
  });
}
