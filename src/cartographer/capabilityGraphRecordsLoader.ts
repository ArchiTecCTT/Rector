import { CapabilityGraphRecordsSchema, type CapabilityGraphRecord } from "./capabilityGraphRecords";
import { promises as fs } from "node:fs";
import path from "node:path";

const DEFAULT_PATH = path.join(
  process.cwd(),
  "tests",
  "fixtures",
  "eval-corpus",
  "capability-graph-records.json"
);

export async function loadCapabilityGraphRecords(filePath?: string): Promise<readonly CapabilityGraphRecord[]> {
  const p = filePath ?? DEFAULT_PATH;
  const txt = await fs.readFile(p, "utf8");
  const json = JSON.parse(txt);
  return CapabilityGraphRecordsSchema.parse(json);
}
