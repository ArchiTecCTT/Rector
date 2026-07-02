import path from "node:path";

import { getRegoloLiveRunEvidenceDir } from "../../src/evidence";
import { runRegoloHarnessSmoke } from "../../src/live/regoloHarnessReport";

runRegoloHarnessSmoke()
  .then((report) => {
    console.log(JSON.stringify({
      status: report.status,
      liveEvidenceStatus: report.liveEvidenceStatus,
      skippedReason: report.skippedReason,
      failedCount: report.failedCount,
      reportPath: path.join(getRegoloLiveRunEvidenceDir(report.runId), "harness-report.json"),
    }));
    if (report.status !== "passed" || report.liveEvidenceStatus !== "live_provider") process.exitCode = 1;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
