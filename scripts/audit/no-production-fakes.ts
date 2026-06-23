#!/usr/bin/env tsx

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const NO_PRODUCTION_FAKE_RULE_IDS = [
  "fake_chat_or_tests_support_import",
  "executor_simulator_import",
  "fake_llm_provider",
  "simulator_echo_registration",
  "workspace_validate_passed_true",
  "fake_planner_output",
] as const;

export type NoProductionFakeRuleId = (typeof NO_PRODUCTION_FAKE_RULE_IDS)[number];

export type NoProductionFakeFinding = {
  readonly ruleId: NoProductionFakeRuleId;
  readonly severity: "report_only";
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly evidence: string;
  readonly message: string;
};

export type NoProductionFakesAuditReport = {
  readonly scanRoot: string;
  readonly scannedFileCount: number;
  readonly findingCount: number;
  readonly exitCode: 0;
  readonly findings: readonly NoProductionFakeFinding[];
};

export type NoProductionFakesAuditOptions = {
  readonly repoRoot?: string;
  readonly sourceDir?: string;
  readonly scanRoot?: string;
};

type SourceFile = {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly content: string;
};

type RuleMatch = {
  readonly index: number;
  readonly evidence: string;
};

type AuditRule = {
  readonly id: NoProductionFakeRuleId;
  readonly message: string;
  readonly detector: (content: string) => readonly RuleMatch[];
};

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "../..");
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"] as const;

const AUDIT_RULES: readonly AuditRule[] = [
  {
    id: "fake_chat_or_tests_support_import",
    message: "src must not import tests/support fixtures or runFakeChatRun",
    detector: regexDetector(/\b(?:import|export)\b[^\n;]*["'][^"']*tests\/support[^"']*["']|\brunFakeChatRun\b/g),
  },
  {
    id: "executor_simulator_import",
    message: "non-test src must not import executorSimulator outside simulation adapters",
    detector: regexDetector(/\bfrom\s+["'][^"']*executorSimulator["']|\bimport\s*\([^)]*["'][^"']*executorSimulator["'][^)]*\)/g),
  },
  {
    id: "fake_llm_provider",
    message: "product code must not select FakeLLMProvider under configured profile",
    detector: regexDetector(/\bFakeLLMProvider\b/g),
  },
  {
    id: "simulator_echo_registration",
    message: "simulator.echo must not be registered outside test or dev registration",
    detector: regexDetector(/\bsimulator\.echo\b/g),
  },
  {
    id: "workspace_validate_passed_true",
    message: "workspace.validate must not return passed:true without a command or artifact validator",
    detector: workspaceValidatePassedTrueDetector,
  },
  {
    id: "fake_planner_output",
    message: "executable fake planner output must not satisfy product planner contracts",
    detector: regexDetector(/\b(?:createFakePlan|fallbackPlan)\b/g),
  },
] as const;

export async function auditNoProductionFakes(options: NoProductionFakesAuditOptions = {}): Promise<NoProductionFakesAuditReport> {
  const repoRoot = path.resolve(options.repoRoot ?? REPO_ROOT);
  const sourceDir = options.scanRoot !== undefined
    ? path.resolve(options.scanRoot)
    : path.resolve(repoRoot, options.sourceDir ?? "src");
  const files = await readSourceFiles(repoRoot, sourceDir);
  const findings = files.flatMap(scanFile).sort(compareFindings);
  return {
    scanRoot: normalizePath(path.relative(repoRoot, sourceDir) || "."),
    scannedFileCount: files.length,
    findingCount: findings.length,
    exitCode: 0,
    findings,
  };
}

export function formatAuditReport(report: NoProductionFakesAuditReport): string {
  const lines = [
    "Rector no-production-fakes audit (report-only)",
    `Scan root: ${report.scanRoot}`,
    `Scanned files: ${report.scannedFileCount}`,
    `Findings: ${report.findingCount}`,
    "Policy: exits 0 even when fake-system seams are found; nonzero exits are reserved for internal audit errors.",
  ];
  for (const finding of report.findings) {
    lines.push(
      `- ${finding.ruleId} ${finding.path}:${finding.line}:${finding.column} — ${finding.message} — ${finding.evidence}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function regexDetector(pattern: RegExp): (content: string) => readonly RuleMatch[] {
  return (content) => {
    const detectorPattern = new RegExp(pattern.source, pattern.flags);
    return [...content.matchAll(detectorPattern)].map((match) => ({ index: match.index, evidence: match[0] }));
  };
}

function workspaceValidatePassedTrueDetector(content: string): readonly RuleMatch[] {
  if (!content.includes("workspace.validate")) return [];
  return [...content.matchAll(/\bpassed\s*:\s*true\b/g)].map((match) => ({ index: match.index, evidence: match[0] }));
}

async function readSourceFiles(repoRoot: string, sourceDir: string): Promise<readonly SourceFile[]> {
  const absolutePaths = await collectSourceFilePaths(sourceDir);
  const sortedPaths = absolutePaths.sort(compareUtf16);
  return Promise.all(
    sortedPaths.map(async (absolutePath) => ({
      absolutePath,
      relativePath: normalizePath(path.relative(repoRoot, absolutePath)),
      content: await fs.readFile(absolutePath, "utf8"),
    })),
  );
}

async function collectSourceFilePaths(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await collectSourceFilePaths(absolutePath)));
      continue;
    }
    if (entry.isFile() && SOURCE_EXTENSIONS.some((extension) => extension === path.extname(entry.name))) {
      paths.push(absolutePath);
    }
  }
  return paths;
}

function scanFile(file: SourceFile): readonly NoProductionFakeFinding[] {
  return AUDIT_RULES.flatMap((rule) =>
    rule.detector(file.content).map((match) => {
      const location = locationForIndex(file.content, match.index);
      return {
        ruleId: rule.id,
        severity: "report_only",
        path: file.relativePath,
        line: location.line,
        column: location.column,
        evidence: compactEvidence(match.evidence),
        message: rule.message,
      } satisfies NoProductionFakeFinding;
    }),
  );
}

function locationForIndex(content: string, index: number): { readonly line: number; readonly column: number } {
  const beforeMatch = content.slice(0, index);
  const lines = beforeMatch.split("\n");
  const lastLine = lines[lines.length - 1] ?? "";
  return { line: lines.length, column: lastLine.length + 1 };
}

function compactEvidence(evidence: string): string {
  return evidence.replace(/\s+/g, " ").trim();
}

function compareFindings(left: NoProductionFakeFinding, right: NoProductionFakeFinding): number {
  const pathOrder = compareUtf16(left.path, right.path);
  if (pathOrder !== 0) return pathOrder;
  const lineOrder = left.line - right.line;
  if (lineOrder !== 0) return lineOrder;
  const columnOrder = left.column - right.column;
  return columnOrder !== 0 ? columnOrder : compareUtf16(left.ruleId, right.ruleId);
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}

function isDirectRun(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && path.resolve(entrypoint) === SCRIPT_PATH;
}

async function runCli(): Promise<void> {
  const report = await auditNoProductionFakes(optionsFromArgv(process.argv));
  process.stdout.write(formatAuditReport(report));
  process.exitCode = report.exitCode;
}

function optionsFromArgv(argv: readonly string[]): NoProductionFakesAuditOptions {
  const scanRoot = argv[2];
  return scanRoot === undefined ? {} : { scanRoot };
}

if (isDirectRun()) {
  runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Rector no-production-fakes audit failed: ${message}\n`);
    process.exitCode = 1;
  });
}
