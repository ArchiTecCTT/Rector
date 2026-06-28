import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildFactEvalReport, renderFactEvalMarkdown, type FactEvalCaseReport } from "../../src/facts";
import { runFactEvals } from "../../scripts/facts/run-fact-evals";

const RAW_SECRET = "sk_test_1234567890abcdef1234567890abcdef";

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "rector-fact-evals-"));
}

describe("Phase 2E fact eval runner", () => {
  it("writes deterministic JSON and markdown reports with all required cases and metrics", async () => {
    const outputDir = await tempDir();
    try {
      const output = await runFactEvals({ outputDir, write: true, now: () => new Date("2026-06-28T00:00:00.000Z") });

      expect(output.report.failedCount).toBe(0);
      expect(output.report.caseCount).toBeGreaterThanOrEqual(10);
      expect(output.report.cases.map((caseReport) => caseReport.id)).toEqual(expect.arrayContaining([
        "cartographer_snapshot_to_facts",
        "cartographer_not_found_to_negative_fact",
        "tool_registry_definition_to_fact",
        "tool_failure_to_failure_fact",
        "capability_eval_result_to_evidence_facts",
        "global_scenario_to_oracle_facts",
        "run_event_trace_to_facts",
        "malformed_fact_rejected",
        "fake_provenance_rejected",
        "secret_payload_redacted_or_blocked",
      ]));
      expect(output.report.metrics.map((metric) => metric.id)).toEqual([
        "schema_valid_rate",
        "provenance_complete_rate",
        "grounding_success_rate",
        "insufficient_evidence_correctness",
        "hallucinated_reference_count",
        "secret_leak_count",
        "replay_success_rate",
        "fact_diff_accuracy",
        "raw_artifact_ref_coverage",
        "trust_transition_violation_count",
      ]);
      expect(output.jsonPath).toBe(path.join(outputDir, "fact-report.json"));
      expect(output.markdownPath).toBe(path.join(outputDir, "fact-report.md"));
      const json = JSON.parse(await readFile(output.jsonPath!, "utf8"));
      const markdown = await readFile(output.markdownPath!, "utf8");
      expect(json.schemaVersion).toBe("rector.fact-eval-report.v1");
      expect(markdown).toContain("## Metrics");
      expect(markdown).toContain("## Fact IDs and Source Refs");
      expect(markdown).not.toContain(RAW_SECRET);
      expect(markdown.length).toBeLessThan(30_000);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("preserves failed case reasons in reports without dumping raw payloads", () => {
    const failedCase: FactEvalCaseReport = {
      id: "intentional_failed_case",
      title: "Intentional failed case",
      passed: false,
      acceptedFactCount: 0,
      rejectedInputCount: 1,
      failureReasons: [`oracle failed with secret ${RAW_SECRET}`],
      metrics: {
        schema_valid_rate: 0,
        provenance_complete_rate: 0,
        grounding_success_rate: 0,
        insufficient_evidence_correctness: 0,
        hallucinated_reference_count: 1,
        secret_leak_count: 1,
        replay_success_rate: 0,
        fact_diff_accuracy: 0,
        raw_artifact_ref_coverage: 0,
        trust_transition_violation_count: 1,
      },
      factRefs: [],
      validationErrors: [{ code: "raw_secret_value", message: "secret blocked", path: ["output"], severity: "error" }],
    };

    const report = buildFactEvalReport({ generatedAt: "2026-06-28T00:00:00.000Z", cases: [failedCase] });
    const markdown = renderFactEvalMarkdown(report);

    expect(report.failedCount).toBe(1);
    expect(report.cases[0]?.failureReasons).toHaveLength(1);
    expect(report.cases[0]?.failureReasons[0]).toContain("oracle failed with secret");
    expect(report.cases[0]?.failureReasons[0]).not.toContain(RAW_SECRET);
    expect(markdown).toContain("intentional_failed_case");
    expect(markdown).toContain("oracle failed with secret");
    expect(markdown).not.toContain(RAW_SECRET);
  });
});
