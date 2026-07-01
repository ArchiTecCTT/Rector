import { execFileSync, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findImportModuleMatches, parseSourceFile } from "../../scripts/audit/no-production-fakes-ast";
import {
  auditNoProductionFakes,
  formatAuditReport,
  NO_PRODUCTION_FAKE_ALLOWLIST,
  validateNoProductionFakeAllowlist,
} from "../../scripts/audit/no-production-fakes";

const tempRoots: string[] = [];

describe("no-production-fakes audit", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  it("reports every configured fake pattern without failing the audit result", async () => {
    const rootDir = await makeFixtureRoot({
      "src/providers.ts": "export const provider = new FakeLLMProvider();\n",
      "src/planner.ts": "import { createFakePlan } from './planner-fixture';\nconst plan = fallbackPlan;\n",
      "src/tools.ts": "registerTool({ name: 'workspace.validate', handler: () => ({ validation: { passed: true } }) });\nregisterTool({ name: 'simulator.echo' });\n",
      "src/chat.ts": "import { runFakeChatRun } from './fake-chat';\n",
      "src/supportLeak.ts": "import { fixture } from '../tests/support/fixture';\n",
      "src/live.ts": "import { executeDag } from './orchestration/executorSimulator';\n",
      "tests/support/fixture.ts": "export const fixture = true;\n",
    });

    const report = await auditNoProductionFakes({ repoRoot: rootDir });

    expect(report.exitCode).toBe(0);
    expect(report.failOnUnallowed).toBe(false);
    expect(report.findingCount).toBeGreaterThanOrEqual(7);
    expect(report.unallowedFindingCount).toBe(report.findingCount);
    expect(countByRule(report.findings)).toEqual({
      executor_simulator_import: 1,
      fake_chat_or_tests_support_import: 2,
      fake_llm_provider: 1,
      fake_planner_output: 2,
      simulator_echo_registration: 1,
      workspace_validate_passed_true: 1,
    });
  });

  it("exits nonzero in strict mode when unallowed fixtures are present", async () => {
    const rootDir = await makeFixtureRoot({
      "src/evil.ts": "export const provider = new FakeLLMProvider();\n",
    });

    const report = await auditNoProductionFakes({ repoRoot: rootDir, failOnUnallowed: true });

    expect(report.failOnUnallowed).toBe(true);
    expect(report.unallowedFindingCount).toBeGreaterThan(0);
    expect(report.exitCode).toBe(1);
  });

  it("ignores tests and reports zero findings for clean src fixtures", async () => {
    const rootDir = await makeFixtureRoot({
      "src/index.ts": "export const configured = true;\n",
      "tests/support/fakeNames.ts": "export const name = 'FakeLLMProvider simulator.echo';\n",
    });

    const report = await auditNoProductionFakes({ repoRoot: rootDir });

    expect(report).toMatchObject({ exitCode: 0, findingCount: 0, unallowedFindingCount: 0, scannedFileCount: 1 });
    expect(report.findings).toEqual([]);
  });

  it("formats the current repo findings with zero unallowed fake seams", async () => {
    const report = await auditNoProductionFakes({ repoRoot: process.cwd() });

    const output = formatAuditReport(report);

    expect(report.exitCode).toBe(0);
    expect(report.findings.length).toBeGreaterThan(0);
    expect(report.unallowedFindingCount).toBe(0);
    expect(output).toContain("Rector no-production-fakes audit (report-only)");
    expect(output).toContain("Unallowed findings: 0");
    expect(output).toContain("fake_llm_provider");
    expect(output).toContain("workspace_validate_passed_true");
    expect(output).toMatch(/allowed fake_llm_provider/);
  });

  it("passes strict mode for the current repo", async () => {
    const report = await auditNoProductionFakes({ repoRoot: process.cwd(), failOnUnallowed: true });

    expect(report.unallowedFindingCount).toBe(0);
    expect(report.exitCode).toBe(0);
    expect(formatAuditReport(report)).toContain("Rector no-production-fakes audit (strict)");
  });

  it("allowlist suppresses only the exact ruleId and path pair", async () => {
    const rootDir = await makeFixtureRoot({
      "src/providers/llm.ts": "export const provider = FakeLLMProvider;\n",
      "src/other.ts": "export const provider = FakeLLMProvider;\n",
    });

    const report = await auditNoProductionFakes({ repoRoot: rootDir });
    const allowlisted = report.findings.filter((finding) => finding.path === "src/providers/llm.ts");
    const unallowlisted = report.findings.filter((finding) => finding.path === "src/other.ts");

    expect(allowlisted.length).toBeGreaterThan(0);
    expect(allowlisted.every((finding) => finding.allowed)).toBe(true);
    expect(unallowlisted.length).toBeGreaterThan(0);
    expect(unallowlisted.every((finding) => !finding.allowed)).toBe(true);
  });

  it("rejects broad or invalid allowlist entries", () => {
    expect(validateNoProductionFakeAllowlist(NO_PRODUCTION_FAKE_ALLOWLIST)).toEqual([]);
    expect(
      validateNoProductionFakeAllowlist([
        { ruleId: "fake_llm_provider", path: "src/**", reason: "too broad" },
        { ruleId: "fake_llm_provider", path: "src/providers/llm.ts", reason: "dup" },
        { ruleId: "fake_llm_provider", path: "src/providers/llm.ts", reason: "dup" },
      ]),
    ).toEqual([
      "allowlist entry must be an exact file path, not a directory or glob: src/**",
      "duplicate allowlist entry for fake_llm_provider::src/providers/llm.ts",
    ]);
  });

  it("uses AST import detection for executorSimulator specifiers", () => {
    const sourceFile = parseSourceFile(
      "import { executeDag } from './orchestration/executorSimulator';\n",
      "src/live.ts",
    );
    const matches = findImportModuleMatches(sourceFile, ["executorSimulator"]);

    expect(matches).toHaveLength(1);
    expect(matches[0]?.evidence).toContain("executorSimulator");
  });

  it("CLI exits zero even when report-only fake findings are present", () => {
    const tsxCli = resolveTsxCli();

    const output = execFileSync(process.execPath, [tsxCli, "scripts/audit/no-production-fakes.ts"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    });

    expect(output).toContain("Rector no-production-fakes audit (report-only)");
    expect(output).toContain("Findings:");
    expect(output).toContain("Unallowed findings: 0");
  });

  it("CLI strict mode exits nonzero for unallowed fixture trees", async () => {
    const tsxCli = resolveTsxCli();
    const rootDir = await makeFixtureRoot({
      "src/evil.ts": "export const provider = new FakeLLMProvider();\n",
    });

    const result = spawnSync(
      process.execPath,
      [tsxCli, "scripts/audit/no-production-fakes.ts", "--fail-on-unallowed", rootDir],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30000,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Rector no-production-fakes audit (strict)");
    expect(result.stdout).toContain("Unallowed findings:");
  });

  it("CLI strict mode exits zero for the current repo", () => {
    const tsxCli = resolveTsxCli();

    const result = spawnSync(process.execPath, [tsxCli, "scripts/audit/no-production-fakes.ts", "--fail-on-unallowed"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Unallowed findings: 0");
  });

  it("throws for a nonexistent scan root through the programmatic API", async () => {
    const missingRoot = await makeMissingRoot();
    const result = auditNoProductionFakes({ scanRoot: missingRoot });

    await expect(result).rejects.toThrow(/ENOENT|no such file or directory/);
  });

  it("CLI exits nonzero for a nonexistent scan root argument", async () => {
    const tsxCli = resolveTsxCli();
    const missingRoot = await makeMissingRoot();

    const result = spawnSync(process.execPath, [tsxCli, "scripts/audit/no-production-fakes.ts", missingRoot], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    });

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

function resolveTsxCli(): string {
  const requireFromTest = createRequire(import.meta.url);
  return path.join(path.dirname(requireFromTest.resolve("tsx/package.json")), "dist/cli.mjs");
}

function countByRule(findings: readonly { readonly ruleId: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const finding of findings) {
    counts[finding.ruleId] = (counts[finding.ruleId] ?? 0) + 1;
  }
  return counts;
}