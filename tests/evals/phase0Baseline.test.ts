import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Phase0BaselineSchema, buildPhase0Baseline } from "../../src/capabilities/eval/baseline";
import { getEvidenceTrackDir, getLegacyEvidenceRoot } from "../../src/evidence";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const JSON_PATHS = [
  path.join(getEvidenceTrackDir("phase0", REPO_ROOT), "phase0-baseline.json"),
  path.join(getLegacyEvidenceRoot(REPO_ROOT), "phase0-baseline.json"),
];

async function baselineJson(): Promise<unknown> {
  for (const candidate of JSON_PATHS) {
    if (existsSync(candidate)) {
      return JSON.parse(readFileSync(candidate, "utf8"));
    }
  }
  return buildPhase0Baseline({
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    gitBranch: "test",
    gitHeadSha: "deadbeef",
    testBaseline: { totalTests: 1, passed: 1, skipped: 0 },
    capabilityCorpus: { caseCount: 0, artifactKinds: [] },
  });
}

describe("Phase 0 Baseline", () => {
  it("parses produced JSON against schema and asserts required keys", async () => {
    const json = await baselineJson();
    const parsed = Phase0BaselineSchema.parse(json);

    expect(parsed.schemaVersion).toBe("rector.phase0-baseline.v1");
    expect(parsed.git).toHaveProperty("branch");
    expect(parsed.git).toHaveProperty("headSha");
    expect(parsed.testBaseline).toHaveProperty("totalTests");
    expect(parsed.capabilityCorpus).toHaveProperty("caseCount");
    expect(parsed.fakeAudit).toHaveProperty("findingCount");
    expect(parsed.metricThresholds).toHaveProperty("schema_valid");
    expect(parsed.metricThresholds).toHaveProperty("recall");
    expect(parsed.metricThresholds).toHaveProperty("omission");
    expect(parsed.metricThresholds).toHaveProperty("secret_leak");
    expect(parsed.metricThresholds).toHaveProperty("compression");
    expect(parsed.metricThresholds).toHaveProperty("raw_token_reduction");
    expect(parsed.metricThresholds).toHaveProperty("line_ref_accuracy");
    expect(parsed.metricThresholds).toHaveProperty("root_cause_accuracy");
    expect(parsed.validationStrengthRubric).toHaveProperty("T0");
    expect(parsed.validationStrengthRubric).toHaveProperty("T1");
    expect(parsed.validationStrengthRubric).toHaveProperty("T2");
    expect(parsed.validationStrengthRubric).toHaveProperty("T3");
    expect(parsed.validationStrengthRubric).toHaveProperty("T4");
    expect(parsed.validationStrengthRubric).toHaveProperty("T5");
    expect(parsed.costRiskDefinitions).toHaveProperty("tokenEstimator");
    expect(parsed.costRiskDefinitions).toHaveProperty("fakeAuditPolicy");
  });

  it("fails schema parse when a required threshold key is missing", async () => {
    const json = await baselineJson();
    const broken = { ...json };
    delete broken.metricThresholds.schema_valid;

    expect(() => Phase0BaselineSchema.parse(broken)).toThrow();
  });

  it("buildPhase0Baseline wires live fakeAuditReport counts exactly (historical baseline is separate snapshot)", async () => {
    const realReport = await import("../../scripts/audit/no-production-fakes").then((m) =>
      m.auditNoProductionFakes(),
    );

    const baseline = await buildPhase0Baseline({
      fakeAuditReport: realReport,
      gitBranch: "test",
      gitHeadSha: "deadbeef",
      testBaseline: { totalTests: 1, passed: 1, skipped: 0 },
      capabilityCorpus: { caseCount: 0, artifactKinds: [] },
    });

    expect(baseline.fakeAudit.findingCount).toBe(realReport.findingCount);

    const perRuleSum = Object.values(baseline.fakeAudit.perRule).reduce((a, b) => a + b, 0);
    expect(perRuleSum).toBe(realReport.findingCount);

    expect(typeof realReport.findingCount).toBe("number");
    expect(realReport.findingCount).toBeGreaterThanOrEqual(0);
  });
});
