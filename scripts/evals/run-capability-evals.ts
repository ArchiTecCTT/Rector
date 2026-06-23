import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { redactString } from "../../src/security/redaction";
import {
  CAPABILITY_EVAL_METRIC_IDS,
  scoreEvalResults,
  type CapabilityEvalMetricId,
  type MetricSummary,
} from "../../src/capabilities/eval/metrics";
import { CapabilityEvalResultSchema, type CapabilityEvalResult } from "../../src/capabilities/eval/schemas";
import {
  EvalCorpusManifestSchema,
  EvalCorpusOracleSchema,
  type EvalCorpusCase,
  type EvalCorpusManifest,
  type EvalCorpusOracle,
} from "../../tests/fixtures/eval-corpus/manifest.schema";
import {
  buildCapabilityEvalRunReport,
  renderCapabilityEvalMarkdown,
  type CapabilityEvalRunReport,
} from "./score-capability-results";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DEFAULT_CORPUS_ROOT = path.join(REPO_ROOT, "tests", "fixtures", "eval-corpus");
const DEFAULT_OUTPUT_DIR = path.join(REPO_ROOT, ".omo", "evidence");
const CAPABILITY_ID = "cartographer.grounding";

export type OracleOverride = (caseId: string, oracle: EvalCorpusOracle) => EvalCorpusOracle;

export interface RunCapabilityEvalsOptions {
  readonly corpusRoot?: string;
  readonly outputDir?: string;
  readonly write?: boolean;
  readonly now?: () => Date;
  /**
   * Test-only hook to substitute a deliberately-wrong oracle so the runner can prove it RECORDS a
   * real per-case failure (regression guard). This is a real artifact-vs-oracle comparison against a
   * modified oracle, never a mocked success.
   */
  readonly oracleOverride?: OracleOverride;
}

export interface RunCapabilityEvalsOutput {
  readonly report: CapabilityEvalRunReport;
  readonly markdown: string;
  readonly summary: MetricSummary;
  readonly results: readonly CapabilityEvalResult[];
  readonly jsonPath?: string;
  readonly markdownPath?: string;
}

function countArtifactLines(text: string): number {
  return text.trimEnd().split("\n").length;
}

async function readCorpusText(corpusRoot: string, relativePath: string): Promise<string> {
  return fs.readFile(path.join(corpusRoot, relativePath), "utf8");
}

async function readCorpusJson(corpusRoot: string, relativePath: string): Promise<unknown> {
  return JSON.parse(await readCorpusText(corpusRoot, relativePath));
}

async function loadManifest(corpusRoot: string): Promise<EvalCorpusManifest> {
  return EvalCorpusManifestSchema.parse(await readCorpusJson(corpusRoot, "manifest.json"));
}

type RecallOmission = {
  readonly foundExpected: readonly string[];
  readonly missingExpected: readonly string[];
  readonly recall: number;
  readonly omission: number;
};

type LineAccuracy = {
  readonly actualLineCount: number;
  readonly lineCountMatches: boolean;
  readonly lineRefAccuracy: number;
};

type CompressionMetrics = {
  readonly compression: number;
  readonly rawTokenReduction: number;
};

function computeRecallOmission(oracle: EvalCorpusOracle, artifact: string): RecallOmission {
  const foundExpected = oracle.mustContain.filter((expected) => artifact.includes(expected));
  const missingExpected = oracle.mustContain.filter((expected) => !artifact.includes(expected));
  const total = oracle.mustContain.length;
  return {
    foundExpected,
    missingExpected,
    recall: total === 0 ? 1 : foundExpected.length / total,
    omission: total === 0 ? 0 : missingExpected.length / total,
  };
}

function computeSecretLeak(oracle: EvalCorpusOracle, artifact: string): number {
  const forbiddenPresent = oracle.mustNotContain.filter((forbidden) => artifact.includes(forbidden));
  const redactionLeak = redactString(artifact) !== artifact ? 1 : 0;
  return forbiddenPresent.length + redactionLeak;
}

function computeLineAccuracy(artifact: string, oracle: EvalCorpusOracle): LineAccuracy {
  const actualLineCount = countArtifactLines(artifact);
  const lineCountMatches = actualLineCount === oracle.expectedLineCount;
  return { actualLineCount, lineCountMatches, lineRefAccuracy: lineCountMatches ? 1 : 0 };
}

function computeRootCauseAccuracy(recall: number, exitCodeMatches: boolean, lineCountMatches: boolean): number {
  return recall === 1 && exitCodeMatches && lineCountMatches ? 1 : 0;
}

function computeCompressionMetrics(foundExpected: readonly string[], artifact: string): CompressionMetrics {
  const artifactChars = artifact.length;
  const evidenceChars = foundExpected.reduce((total, evidence) => total + evidence.length, 0);
  return {
    compression: evidenceChars === 0 ? 0 : artifactChars / evidenceChars,
    rawTokenReduction: artifactChars === 0 || evidenceChars >= artifactChars ? 0 : 1 - evidenceChars / artifactChars,
  };
}

function evaluatePassed(recall: number, secretLeak: number, exitCodeMatches: boolean, lineCountMatches: boolean): boolean {
  return recall === 1 && secretLeak === 0 && exitCodeMatches && lineCountMatches;
}

function assembleFailureReason(
  oracle: EvalCorpusOracle,
  fixtureCase: EvalCorpusCase,
  recallOmission: RecallOmission,
  secretLeak: number,
  exitCodeMatches: boolean,
  lineAccuracy: LineAccuracy,
): string {
  const failureParts: string[] = [];
  if (recallOmission.recall !== 1) failureParts.push(`${recallOmission.missingExpected.length}/${oracle.mustContain.length} expected strings missing`);
  if (secretLeak !== 0) failureParts.push(`${secretLeak} forbidden/leak hit(s)`);
  if (!exitCodeMatches) failureParts.push(`exit code ${oracle.expectedExitCode} != recorded ${fixtureCase.generatedFrom.exitCode}`);
  if (!lineAccuracy.lineCountMatches) failureParts.push(`line count ${lineAccuracy.actualLineCount} != expected ${oracle.expectedLineCount}`);
  return `Oracle check failed: ${failureParts.join("; ")}`;
}

/**
 * Deterministically scores a single committed corpus case against its oracle with NO model.
 *
 * Every score is a real string/number comparison of the recorded artifact against the oracle:
 *   - recall/omission     -> fraction of oracle.mustContain strings present/absent in the artifact
 *   - secret_leak         -> count of oracle.mustNotContain forbidden strings present, plus a
 *                            belt-and-suspenders redaction sweep over the artifact
 *   - line_ref_accuracy   -> artifact line count matches oracle.expectedLineCount
 *   - root_cause_accuracy -> full recall AND exit code AND line count all agree
 *   - compression         -> raw artifact chars / extracted-evidence chars (honestly low on tiny
 *                            fixtures; the >=10x threshold targets large live outputs)
 *   - raw_token_reduction -> 1 - evidenceChars/artifactChars (honestly low on tiny fixtures)
 *   - schema_valid        -> 1 (oracle + case + emitted result all parse at the boundary)
 */
function scoreCase(input: {
  readonly fixtureCase: EvalCorpusCase;
  readonly oracle: EvalCorpusOracle;
  readonly artifact: string;
}): CapabilityEvalResult {
  const { fixtureCase, oracle, artifact } = input;

  const recallOmission = computeRecallOmission(oracle, artifact);
  const secretLeak = computeSecretLeak(oracle, artifact);
  const lineAccuracy = computeLineAccuracy(artifact, oracle);
  const exitCodeMatches = oracle.expectedExitCode === fixtureCase.generatedFrom.exitCode;
  const rootCauseAccuracy = computeRootCauseAccuracy(recallOmission.recall, exitCodeMatches, lineAccuracy.lineCountMatches);
  const compressionMetrics = computeCompressionMetrics(recallOmission.foundExpected, artifact);

  const metricScores: Record<CapabilityEvalMetricId, number> = {
    schema_valid: 1,
    recall: recallOmission.recall,
    omission: recallOmission.omission,
    secret_leak: secretLeak,
    compression: compressionMetrics.compression,
    raw_token_reduction: compressionMetrics.rawTokenReduction,
    line_ref_accuracy: lineAccuracy.lineRefAccuracy,
    root_cause_accuracy: rootCauseAccuracy,
  };

  const passed = evaluatePassed(recallOmission.recall, secretLeak, exitCodeMatches, lineAccuracy.lineCountMatches);
  const omissions = recallOmission.missingExpected.map((missing) => `Expected evidence not found in artifact: ${missing}`);
  const failureReason = passed ? undefined : assembleFailureReason(oracle, fixtureCase, recallOmission, secretLeak, exitCodeMatches, lineAccuracy);

  const result = {
    schemaVersion: "rector.capability-eval.v1" as const,
    caseId: fixtureCase.id,
    capabilityId: CAPABILITY_ID,
    passed,
    metricScores,
    omissions,
    rawArtifactRefs: [`artifact://offline/${fixtureCase.id}/${path.basename(fixtureCase.artifactPath)}`],
    ...(failureReason === undefined ? {} : { failureReason }),
  };
  return CapabilityEvalResultSchema.parse(result);
}

/**
 * Offline, model-free capability eval run. Loads the committed corpus, scores each case against its
 * deterministic oracle, aggregates via the shared {@link scoreEvalResults}, and (by default) writes
 * eval-report.json + eval-report.md. The run SUCCEEDS when it produces a valid report; the report's
 * aggregate `passed` truthfully reflects the metrics (efficiency thresholds are not met by the tiny
 * offline fixtures by design).
 */
export async function runCapabilityEvals(options: RunCapabilityEvalsOptions = {}): Promise<RunCapabilityEvalsOutput> {
  const corpusRoot = options.corpusRoot ?? DEFAULT_CORPUS_ROOT;
  const outputDir = options.outputDir ?? DEFAULT_OUTPUT_DIR;
  const shouldWrite = options.write ?? true;
  const now = options.now ?? (() => new Date());

  const manifest = await loadManifest(corpusRoot);
  const results: CapabilityEvalResult[] = [];
  for (const fixtureCase of manifest.cases) {
    const rawOracle = EvalCorpusOracleSchema.parse(await readCorpusJson(corpusRoot, fixtureCase.oraclePath));
    const oracle = options.oracleOverride ? EvalCorpusOracleSchema.parse(options.oracleOverride(fixtureCase.id, rawOracle)) : rawOracle;
    const artifact = await readCorpusText(corpusRoot, fixtureCase.artifactPath);
    results.push(scoreCase({ fixtureCase, oracle, artifact }));
  }

  const summary = scoreEvalResults(results);
  const report = buildCapabilityEvalRunReport({
    generatedAt: now().toISOString(),
    corpus: {
      schemaVersion: manifest.schemaVersion,
      description: manifest.description,
      caseCount: manifest.cases.length,
    },
    results,
    summary,
  });
  const markdown = renderCapabilityEvalMarkdown(report);

  if (!shouldWrite) {
    return { report, markdown, summary, results };
  }

  await fs.mkdir(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, "eval-report.json");
  const markdownPath = path.join(outputDir, "eval-report.md");
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(markdownPath, markdown, "utf8");
  return { report, markdown, summary, results, jsonPath, markdownPath };
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return fileURLToPath(import.meta.url) === path.resolve(entry);
}

async function main(): Promise<void> {
  const output = await runCapabilityEvals();
  const { summary } = output;
  const metricLine = CAPABILITY_EVAL_METRIC_IDS.map((id) => {
    const score = summary.metrics[id];
    const value = score.value === undefined ? "n/a" : score.value;
    return `${id}=${value}(${score.status})`;
  }).join(" ");
  process.stdout.write(
    [
      "[capability-evals] offline run complete (no model).",
      `  cases: ${summary.passedResultCount}/${summary.resultCount} passed against committed oracles`,
      `  aggregate.passed: ${summary.passed} (efficiency thresholds intentionally unmet by tiny offline fixtures)`,
      `  metrics: ${metricLine}`,
      output.jsonPath ? `  json: ${path.relative(REPO_ROOT, output.jsonPath)}` : "",
      output.markdownPath ? `  md:   ${path.relative(REPO_ROOT, output.markdownPath)}` : "",
    ]
      .filter((line) => line.length > 0)
      .join("\n") + "\n",
  );
  // Exit 0 on successful report PRODUCTION. Aggregate threshold attainment on tiny offline fixtures
  // is reported honestly, not used to fail the offline harness gate.
}

if (isMain()) {
  main().catch((error: unknown) => {
    process.stderr.write(`[capability-evals] FAILED to produce report: ${String(error)}\n`);
    process.exitCode = 1;
  });
}
