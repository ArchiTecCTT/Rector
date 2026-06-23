import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CAPABILITY_EVAL_METRIC_IDS } from "../../src/capabilities/eval/metrics";
import { CapabilityEvalResultSchema } from "../../src/capabilities/eval/schemas";
import { runCapabilityEvals } from "../../scripts/evals/run-capability-evals";
import {
  CapabilityEvalRunReportSchema,
  OFFLINE_REPORT_NOTES,
} from "../../scripts/evals/score-capability-results";

const FIXED_NOW = () => new Date("2026-01-01T00:00:00.000Z");

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempOutputDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "rector-eval-runner-"));
  tempRoots.push(root);
  return root;
}

describe("offline capability eval runner", () => {
  it("scores every committed corpus case against its oracle with no model and writes both reports", async () => {
    // Given: the committed offline corpus and a real temp output directory.
    const outputDir = await tempOutputDir();

    // When: the runner scores each case deterministically and writes the report files.
    const output = await runCapabilityEvals({ outputDir, now: FIXED_NOW });

    // Then: one result is produced per corpus case, each carrying all eight metric scores.
    expect(output.results.length).toBe(output.report.corpus.caseCount);
    expect(output.results.length).toBeGreaterThanOrEqual(3);
    for (const result of output.results) {
      const parsed = CapabilityEvalResultSchema.parse(result);
      for (const metricId of CAPABILITY_EVAL_METRIC_IDS) {
        expect(typeof parsed.metricScores[metricId]).toBe("number");
        expect(Number.isFinite(parsed.metricScores[metricId])).toBe(true);
      }
    }

    // And: the aggregate summary reports the full eight-metric surface.
    expect(Object.keys(output.summary.metrics).sort()).toEqual([...CAPABILITY_EVAL_METRIC_IDS].sort());
    expect(output.summary.resultCount).toBe(output.results.length);

    // And: both report artifacts are written and re-parse at the schema boundary.
    expect(output.jsonPath).toBeDefined();
    expect(output.markdownPath).toBeDefined();
    const jsonText = await readFile(output.jsonPath as string, "utf8");
    const reparsed = CapabilityEvalRunReportSchema.parse(JSON.parse(jsonText));
    expect(reparsed.schemaVersion).toBe("rector.capability-eval-report.v1");
    expect(reparsed.generatedAt).toBe("2026-01-01T00:00:00.000Z");

    const markdownText = await readFile(output.markdownPath as string, "utf8");
    expect(markdownText).toBe(output.markdown);
    for (const metricId of CAPABILITY_EVAL_METRIC_IDS) {
      expect(markdownText).toContain(metricId);
    }
    for (const result of output.results) {
      expect(markdownText).toContain(result.caseId);
    }
    for (const note of OFFLINE_REPORT_NOTES) {
      expect(markdownText).toContain(note);
    }
  });

  it("passes every committed case on its real oracle while honestly failing efficiency thresholds", async () => {
    // Given: the unmodified committed corpus scored against its real oracles.
    const output = await runCapabilityEvals({ write: false, now: FIXED_NOW });

    // Then: each committed case passes its deterministic oracle (recall/exit/line/secret checks).
    expect(output.results.every((result) => result.passed)).toBe(true);
    expect(output.summary.passedResultCount).toBe(output.summary.resultCount);

    // And: the evidence metrics reflect real perfect-match comparisons against the committed oracles.
    expect(output.summary.metrics.recall.status).toBe("pass");
    expect(output.summary.metrics.omission.status).toBe("pass");
    expect(output.summary.metrics.secret_leak.value).toBe(0);
    expect(output.summary.metrics.line_ref_accuracy.status).toBe("pass");
    expect(output.summary.metrics.root_cause_accuracy.status).toBe("pass");

    // And: efficiency thresholds are NOT met by the tiny offline fixtures, so the aggregate is
    // honestly false rather than fabricated to green.
    expect(output.summary.metrics.compression.status).toBe("fail");
    expect(output.summary.passed).toBe(false);
  });

  it("locks the exact deterministic per-case and aggregate metric values as a regression guard", async () => {
    // Given: the committed corpus scored model-free against its real oracles.
    const output = await runCapabilityEvals({ write: false, now: FIXED_NOW });

    // When: the deterministic computed scores are read back per case.
    const byCase = new Map(output.results.map((result) => [result.caseId, result.metricScores] as const));

    // Then: every committed case yields its exact recorded score (drift in scoring math fails here).
    const expectedPerCase = {
      "rg-orchestration-search": { compression: 1.0127388535031847, raw_token_reduction: 0.012578616352201255 },
      "tsc-runtime-mode-error": { compression: 1.0348837209302326, raw_token_reduction: 0.0337078651685393 },
      "git-readiness-diff": { compression: 1.6725663716814159, raw_token_reduction: 0.4021164021164021 },
    } as const;
    for (const [caseId, expected] of Object.entries(expectedPerCase)) {
      const scores = byCase.get(caseId);
      expect(scores).toBeDefined();
      expect(scores?.recall).toBe(1);
      expect(scores?.omission).toBe(0);
      expect(scores?.secret_leak).toBe(0);
      expect(scores?.line_ref_accuracy).toBe(1);
      expect(scores?.root_cause_accuracy).toBe(1);
      expect(scores?.compression).toBe(expected.compression);
      expect(scores?.raw_token_reduction).toBe(expected.raw_token_reduction);
    }

    // And: the aggregate values are the exact deterministic means over the three cases.
    expect(output.summary.metrics.compression.value).toBe(1.2400629820382776);
    expect(output.summary.metrics.raw_token_reduction.value).toBe(0.14946762787904755);
    expect(output.summary.metrics.recall.value).toBe(1);
    expect(output.summary.metrics.omission.value).toBe(0);
    expect(output.summary.metrics.secret_leak.value).toBe(0);
  });

  it("records a real per-case failure when an oracle expects evidence the artifact does not contain", async () => {
    // Given: a deliberately-wrong oracle for the rg case requiring a string absent from the artifact.
    const output = await runCapabilityEvals({
      write: false,
      now: FIXED_NOW,
      oracleOverride: (caseId, oracle) =>
        caseId === "rg-orchestration-search"
          ? { ...oracle, mustContain: [...oracle.mustContain, "evidence-string-that-is-not-present"] }
          : oracle,
    });

    // When: the overridden case is located in the results.
    const overridden = output.results.find((result) => result.caseId === "rg-orchestration-search");

    // Then: the runner RECORDS the case as failed with a concrete reason and omission, never silently passing.
    expect(overridden).toBeDefined();
    expect(overridden?.passed).toBe(false);
    expect(overridden?.failureReason).toContain("Oracle check failed");
    expect(overridden?.omissions.some((entry) => entry.includes("evidence-string-that-is-not-present"))).toBe(true);
    expect(output.summary.passedResultCount).toBeLessThan(output.summary.resultCount);

    // And: the rendered markdown surfaces the recorded failure for auditors.
    expect(output.markdown).toContain("Recorded Failures");
    expect(output.markdown).toContain("rg-orchestration-search");
  });
});
