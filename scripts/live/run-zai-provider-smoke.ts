import path from "node:path";

import { getZaiLiveEvidenceDir } from "../../src/evidence";
import { runZaiProviderSmoke } from "../../src/live/zaiProviderSmokeReport";

runZaiProviderSmoke()
  .then((report) => {
    console.log(JSON.stringify({
      status: report.status,
      liveEvidenceStatus: report.liveEvidenceStatus,
      skippedReason: report.skippedReason,
      errorKind: report.error?.kind,
      reportPath: path.join(getZaiLiveEvidenceDir(), "provider-smoke.json"),
    }));
    if (report.status !== "passed" || report.liveEvidenceStatus !== "live_provider") process.exitCode = 1;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
