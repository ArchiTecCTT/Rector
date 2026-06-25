import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";

import { runCapabilityEvals, type RunCapabilityEvalsOptions } from "../../scripts/evals/run-capability-evals";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempOutputDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "rector-eval-gate-"));
  tempRoots.push(root);
  return root;
}

describe("capability eval gate command", () => {
  it("exits non-zero when a case fails its oracle (broken fixture via oracleOverride)", async () => {
    const outputDir = await tempOutputDir();
    const opts: RunCapabilityEvalsOptions = {
      outputDir,
      write: true,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      oracleOverride: (_caseId, oracle) => ({ ...oracle, mustContain: ["NONEXISTENT_TOKEN_XYZ"] }),
    };
    const output = await runCapabilityEvals(opts);
    const anyFailed = output.results.some((r) => !r.passed);
    expect(anyFailed).toBe(true);
  });

  it("real corpus gate exits 0 via designated-case efficiency", () => {
    const r = execSync("npm run eval:capabilities:gate", { encoding: "utf8" });
    expect(r).toContain("PASS");
  });
});
