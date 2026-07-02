import path from "node:path";

import { getRegoloLiveEvidenceDir } from "../../src/evidence";
import { runRegoloProviderSmoke } from "../../src/live/regoloProviderSmokeReport";

runRegoloProviderSmoke()
  .then((report) => {
    console.log(JSON.stringify({
      status: report.status,
      liveEvidenceStatus: report.liveEvidenceStatus,
      skippedReason: report.skippedReason,
      errorKind: report.error?.kind,
      reportPath: path.join(getRegoloLiveEvidenceDir(), "provider-smoke.json"),
    }));
    if (report.status !== "passed" || report.liveEvidenceStatus !== "live_provider") process.exitCode = 1;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
