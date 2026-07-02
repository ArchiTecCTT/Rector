/**
 * Minimal OpenAI-compatible chat probe per Z.ai matrix model id.
 * Opt-in: requires REGOLO_API_KEY + REGOLO_BASE_URL (or OPENAI_COMPATIBLE_* fallback).
 * Does not print or persist secret values.
 */
import { redactString } from "../../src/security/redaction";
import { runRegoloModelProbe } from "../../src/live/regoloModelProbe";

runRegoloModelProbe()
  .then((report) => {
    const summary = {
      schemaVersion: report.schemaVersion,
      modelsProbed: report.modelsProbed,
      callable: report.callable,
      failed: report.failed,
      estimatedModelCalls: report.estimatedModelCalls,
      jsonCapabilityProbed: report.jsonCapabilityProbed,
      rows: report.rows.map((r) => ({
        modelId: r.modelId,
        correctedModelId: r.correctedModelId,
        classification: r.classification,
        httpStatus: r.httpStatus,
        totalTokens: r.totalTokens,
        jsonCapability: r.jsonCapability,
        jsonCapabilityHttpStatus: r.jsonCapabilityHttpStatus,
      })),
    };
    console.log(JSON.stringify(summary, null, 2));
    if (report.callable < report.modelsProbed) process.exitCode = 1;
  })
  .catch((error) => {
    console.error(redactString(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });