import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CAPABILITY_EVAL_METRIC_IDS } from "../../src/capabilities/eval/metrics";
import { CapabilityEvalResultSchema } from "../../src/capabilities/eval/schemas";
import { LocalFsRawArtifactStore } from "../../src/capabilities/eval/artifactStore";
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
    // honestly false rather than fabricated to green. Compression now passes (large cases lift mean)
    // but raw_token_reduction still fails, keeping summary.passed === false.
    expect(output.summary.metrics.raw_token_reduction.status).toBe("fail");
    expect(output.summary.passed).toBe(false);
  });

  it("locks the exact deterministic per-case and aggregate metric values as a regression guard", async () => {
    // Given: the committed corpus scored model-free against its real oracles.
    const output = await runCapabilityEvals({ write: false, now: FIXED_NOW });

    // When: the deterministic computed scores are read back per case.
    const byCase = new Map(output.results.map((result) => [result.caseId, result.metricScores] as const));

    // Then: every committed case yields its exact recorded score (drift in scoring math fails here).
    const expectedPerCase = {
      "rg-orchestration-search": { compression: 0.12987012987012986, raw_token_reduction: 0 },
      "tsc-runtime-mode-error": { compression: 0.10697674418604651, raw_token_reduction: 0 },
      "git-readiness-diff": { compression: 0.2096069868995633, raw_token_reduction: 0 },
      "rg-noisy-imports": { compression: 925.3589743589744, raw_token_reduction: 0.9989193383025299 },
      "tsc-downstream-error": { compression: 0.16055045871559634, raw_token_reduction: 0 },
      "vitest-failing-log": { compression: 0.3817427385892116, raw_token_reduction: 0 },
      "git-risky-multi-file": { compression: 0.2277992277992278, raw_token_reduction: 0 },
      "npm-audit-package": { compression: 0.03488372093023256, raw_token_reduction: 0 },
      "audit-no-fakes-report": { compression: 2.8434504792332267, raw_token_reduction: 0.648314606741573 },
      "cartographer-inventory-scan": { compression: 273.3142857142857, raw_token_reduction: 0.9963412084465817 },
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

    // And: the aggregate values are the exact deterministic means over the ten cases.
    expect(output.summary.metrics.compression.value).toBe(120.27681405594834);
    expect(output.summary.metrics.raw_token_reduction.value).toBe(0.26435751534906843);
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

  it("fails the runner path when expected evidence has a bad raw artifact ref", async () => {
    const corpusRoot = await mkdtemp(path.join(tmpdir(), "rector-eval-corpus-bad-ref-"));
    tempRoots.push(corpusRoot);
    await cp(path.join(process.cwd(), "tests", "fixtures", "eval-corpus"), corpusRoot, { recursive: true });
    const evidencePath = path.join(corpusRoot, "cases", "rg-orchestration-search", "expected-evidence.json");
    const packet = JSON.parse(await readFile(evidencePath, "utf8"));
    packet.evidence[0].rawArtifactRef = "artifact://fabricated/missing.txt";
    packet.rawArtifactRefs = ["artifact://fabricated/missing.txt"];
    await writeFile(evidencePath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");

    const output = await runCapabilityEvals({ corpusRoot, write: false, now: FIXED_NOW });
    const result = output.results.find((entry) => entry.caseId === "rg-orchestration-search");
    expect(result?.passed).toBe(false);
    expect(result?.failureReason).toContain("Evidence coverage failed");
    expect(result?.failureReason).toContain("unresolved artifacts");
  });

  it("fails the runner path when expected evidence has an out-of-bounds line ref", async () => {
    const corpusRoot = await mkdtemp(path.join(tmpdir(), "rector-eval-corpus-bad-line-"));
    tempRoots.push(corpusRoot);
    await cp(path.join(process.cwd(), "tests", "fixtures", "eval-corpus"), corpusRoot, { recursive: true });
    const evidencePath = path.join(corpusRoot, "cases", "rg-orchestration-search", "expected-evidence.json");
    const packet = JSON.parse(await readFile(evidencePath, "utf8"));
    packet.evidence[0].lineEnd = 999999;
    await writeFile(evidencePath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");

    const output = await runCapabilityEvals({ corpusRoot, write: false, now: FIXED_NOW });
    const result = output.results.find((entry) => entry.caseId === "rg-orchestration-search");
    expect(result?.passed).toBe(false);
    expect(result?.failureReason).toContain("Evidence coverage failed");
    expect(result?.failureReason).toContain("out-of-bounds lines");
  });

  it("persists artifacts via LocalFsRawArtifactStore and round-trips with integrity", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rector-artifact-store-"));
    tempRoots.push(root);
    const store = new LocalFsRawArtifactStore({ rootDir: root });
    const content = "hello world\n";
    const record = await store.writeRawArtifact({
      callId: "roundtrip",
      artifactName: "sample.txt",
      content,
      contentType: "text/plain",
      metadata: {},
    });
    const reread = await store.readRawArtifact(record.uri);
    expect(reread.content).toBe(content);
    expect(reread.record.sha256).toBe(record.sha256);
  });

  it("redacts AKIA-style secret before persistence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rector-artifact-redact-"));
    tempRoots.push(root);
    const store = new LocalFsRawArtifactStore({ rootDir: root });
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const record = await store.writeRawArtifact({
      callId: "redact",
      artifactName: "leak.txt",
      content: `token=${secret}`,
      contentType: "text/plain",
      metadata: {},
    });
    expect(record.redactionState).toBe("redacted");
    const reread = await store.readRawArtifact(record.uri);
    expect(reread.content).not.toContain(secret);
  });
});
