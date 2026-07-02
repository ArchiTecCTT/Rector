import { describe, expect, it } from "vitest";

import {
  classifyRegoloProbeHttpFailure,
  REGOLO_MODEL_PROBE_REPORT_SCHEMA,
  runRegoloModelProbe,
} from "../../src/live/regoloModelProbe";

describe("regoloModelProbe", () => {
  it("classifies invalid model HTTP responses", () => {
    expect(classifyRegoloProbeHttpFailure(404, "model not found")).toBe("invalid_model_id");
    expect(classifyRegoloProbeHttpFailure(401, "unauthorized")).toBe("auth_failure");
  });

  it("records environment_missing when REGOLO credentials are absent", async () => {
    const report = await runRegoloModelProbe({ env: {}, write: false });
    expect(report.schemaVersion).toBe(REGOLO_MODEL_PROBE_REPORT_SCHEMA);
    expect(report.rows[0]?.classification).toBe("environment_missing");
    expect(report.rows[0]?.message).toMatch(/REGOLO_API_KEY/);
  });
});