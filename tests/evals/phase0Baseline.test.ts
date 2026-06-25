import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Phase0BaselineSchema } from "../../src/capabilities/eval/baseline";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = path.resolve(__dirname, "../../.omo/evidence");
const JSON_PATH = path.join(EVIDENCE_DIR, "phase0-baseline.json");

describe("Phase 0 Baseline", () => {
  it("parses produced JSON against schema and asserts required keys", () => {
    const raw = readFileSync(JSON_PATH, "utf8");
    const json = JSON.parse(raw);
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

  it("fails schema parse when a required threshold key is missing", () => {
    const raw = readFileSync(JSON_PATH, "utf8");
    const json = JSON.parse(raw);
    const broken = { ...json };
    delete broken.metricThresholds.schema_valid;

    expect(() => Phase0BaselineSchema.parse(broken)).toThrow();
  });

  it("fakeAudit.findingCount matches real scanner result", async () => {
    const raw = readFileSync(JSON_PATH, "utf8");
    const json = JSON.parse(raw);
    const parsed = Phase0BaselineSchema.parse(json);

    const realReport = await import("../../scripts/audit/no-production-fakes").then((m) =>
      m.auditNoProductionFakes(),
    );
    expect(parsed.fakeAudit.findingCount).toBe(realReport.findingCount);
  });
});
