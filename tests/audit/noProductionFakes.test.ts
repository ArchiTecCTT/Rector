import { execFileSync, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditNoProductionFakes, formatAuditReport } from "../../scripts/audit/no-production-fakes";

const tempRoots: string[] = [];

describe("no-production-fakes audit", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  it("reports every configured fake pattern without failing the audit result", async () => {
    // Given: a fixture source tree containing one occurrence for each report-only fake detector.
    const rootDir = await makeFixtureRoot({
      "src/providers.ts": "export const provider = new FakeLLMProvider();\n",
      "src/planner.ts": "import { createFakePlan } from './planner-fixture';\nconst plan = fallbackPlan;\n",
      "src/tools.ts": "registerTool({ name: 'workspace.validate', handler: () => ({ validation: { passed: true } }) });\nregisterTool({ name: 'simulator.echo' });\n",
      "src/chat.ts": "import { runFakeChatRun } from './fake-chat';\n",
      "src/supportLeak.ts": "import { fixture } from '../tests/support/fixture';\n",
      "src/live.ts": "import { executeDag } from './orchestration/executorSimulator';\n",
      "tests/support/fixture.ts": "export const fixture = true;\n",
    });

    // When: the audit scans the fixture root.
    const report = await auditNoProductionFakes({ repoRoot: rootDir });

    // Then: all six detector families are reported and the report remains non-blocking.
    expect(report.exitCode).toBe(0);
    expect(report.findingCount).toBeGreaterThanOrEqual(7);
    expect(countByRule(report.findings)).toEqual({
      executor_simulator_import: 1,
      fake_chat_or_tests_support_import: 2,
      fake_llm_provider: 1,
      fake_planner_output: 2,
      simulator_echo_registration: 1,
      workspace_validate_passed_true: 1,
    });
  });

  it("ignores tests and reports zero findings for clean src fixtures", async () => {
    // Given: a clean source file and a test fixture carrying fake-only names outside src.
    const rootDir = await makeFixtureRoot({
      "src/index.ts": "export const configured = true;\n",
      "tests/support/fakeNames.ts": "export const name = 'FakeLLMProvider simulator.echo';\n",
    });

    // When: the audit scans the fixture root.
    const report = await auditNoProductionFakes({ repoRoot: rootDir });

    // Then: only src is considered and no findings are reported.
    expect(report).toMatchObject({ exitCode: 0, findingCount: 0, scannedFileCount: 1 });
    expect(report.findings).toEqual([]);
  });

  it("formats the current repo findings as report-only output", async () => {
    // Given: the current Rector source tree still contains known fake-system seams.
    const report = await auditNoProductionFakes({ repoRoot: process.cwd() });

    // When: the report is formatted for CLI output.
    const output = formatAuditReport(report);

    // Then: the known seams are visible and the output states the non-blocking policy.
    expect(report.exitCode).toBe(0);
    expect(report.findings.length).toBeGreaterThan(0);
    expect(output).toContain("Rector no-production-fakes audit (report-only)");
    expect(output).toContain("nonzero exits are reserved for internal audit errors");
    expect(output).toContain("fake_llm_provider");
    expect(output).toContain("workspace_validate_passed_true");
  });

  it("CLI exits zero even when report-only fake findings are present", () => {
    // Given: the audit script is executed through the local tsx CLI against current src.
    const tsxCli = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");

    // When: the script runs as a subprocess.
    const output = execFileSync(process.execPath, [tsxCli, "scripts/audit/no-production-fakes.ts"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Then: output includes findings and the subprocess did not throw from a nonzero exit.
    expect(output).toContain("Rector no-production-fakes audit (report-only)");
    expect(output).toContain("Findings:");
  });

  it("throws for a nonexistent scan root through the programmatic API", async () => {
    // Given: a scan root path that does not exist on disk.
    const missingRoot = await makeMissingRoot();

    // When: the audit is pointed directly at the missing scan root.
    const result = auditNoProductionFakes({ scanRoot: missingRoot });

    // Then: internal I/O errors reject instead of being converted into a report-only pass.
    await expect(result).rejects.toThrow(/ENOENT|no such file or directory/);
  });

  it("CLI exits nonzero for a nonexistent scan root argument", async () => {
    // Given: the audit script is executed through tsx with an explicit missing scan root.
    const tsxCli = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    const missingRoot = await makeMissingRoot();

    // When: the subprocess runs with the missing scan-root argument.
    const result = spawnSync(process.execPath, [tsxCli, "scripts/audit/no-production-fakes.ts", missingRoot], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Then: the CLI reports an internal audit failure and exits nonzero.
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Rector no-production-fakes audit failed:");
  });
});

type FixtureFiles = Readonly<Record<string, string>>;

async function makeFixtureRoot(files: FixtureFiles): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "rector-no-fakes-audit-"));
  tempRoots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, ...relativePath.split("/"));
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");
  }
  return root;
}

async function makeMissingRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "rector-no-fakes-missing-"));
  await fs.rm(root, { recursive: true, force: true });
  return path.join(root, "src");
}

function countByRule(findings: readonly { readonly ruleId: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const finding of findings) {
    counts[finding.ruleId] = (counts[finding.ruleId] ?? 0) + 1;
  }
  return counts;
}
