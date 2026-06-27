import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { CapabilityGraphRecordSchema as SrcCapabilityGraphRecordSchema } from "../../src/cartographer/capabilityGraphRecords";
import { loadCapabilityGraphRecords } from "../../src/cartographer/capabilityGraphRecordsLoader";
import { CapabilityGraphRecordSchema as FixtureCapabilityGraphRecordSchema } from "../fixtures/eval-corpus/capability-graph-records.schema";

const corpusFixturePath = path.join(
  process.cwd(),
  "tests",
  "fixtures",
  "eval-corpus",
  "capability-graph-records.json",
);

const tempPaths: string[] = [];

async function makeTempFile(name: string, contents: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "rector-capability-graph-records-"));
  const filePath = path.join(dir, name);
  tempPaths.push(dir);
  await fs.writeFile(filePath, contents, "utf8");
  return filePath;
}

afterEach(async () => {
  await Promise.all(
    tempPaths.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("capabilityGraphRecordsLoader", () => {
  it("keeps eval-corpus capability schema re-exported from src", () => {
    expect(FixtureCapabilityGraphRecordSchema).toBe(SrcCapabilityGraphRecordSchema);
  });

  it("loads the committed fixture from the default path", async () => {
    const records = await loadCapabilityGraphRecords();
    expect(records.length).toBe(1);
    expect(records[0].id).toBe("cartographer.grounding");
    expect(records[0].productionAdmission).toBe("production");
    expect(records[0].source).toBe("phase0_eval");
    expect(records[0].evalCaseIds.length).toBeGreaterThan(0);
  });

  it("loads the committed fixture from an explicit file path deterministically", async () => {
    const records = await loadCapabilityGraphRecords(corpusFixturePath);
    expect(records.length).toBe(1);
    expect(records[0].id).toBe("cartographer.grounding");

    const records2 = await loadCapabilityGraphRecords(corpusFixturePath);
    expect(records2).toEqual(records);
  });

  it("rejects a missing file path", async () => {
    const missingPath = path.join(tmpdir(), "rector-capability-graph-records-missing.json");
    await expect(loadCapabilityGraphRecords(missingPath)).rejects.toThrow();
  });

  it("rejects records missing explicit risk", async () => {
    const missingRiskPath = await makeTempFile(
      "missing-risk.json",
      JSON.stringify([
        {
          id: "no.risk",
          label: "No risk field",
          toolNames: ["workspace.read_file"],
          evalCaseIds: [],
          productionAdmission: "production",
          source: "phase0_eval",
          warnings: [],
        },
      ]),
    );

    await expect(loadCapabilityGraphRecords(missingRiskPath)).rejects.toThrow();
  });

  it("rejects schema-invalid JSON records", async () => {
    const invalidPath = await makeTempFile(
      "invalid-records.json",
      JSON.stringify([
        {
          id: "bad.record",
          label: "Bad",
          toolNames: ["workspace.read_file"],
          evalCaseIds: [],
          productionAdmission: "invalid_admission",
          source: "phase0_eval",
          // invalid enum value forces schema rejection
        },
      ]),
    );

    await expect(loadCapabilityGraphRecords(invalidPath)).rejects.toThrow();
  });
});
