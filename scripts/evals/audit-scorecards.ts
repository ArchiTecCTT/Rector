#!/usr/bin/env tsx
/**
 * audit:scorecards — summarizes the 8 scorecard dimensions across the latest global run.
 * Always exits 0 (report-only). Writes .rector/evidence/global/scorecard-audit.md
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { getEvidenceTrackDir, getLegacyEvidenceRoot } from "../../src/evidence";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const EVIDENCE_DIR = getEvidenceTrackDir("global", REPO_ROOT);
const LEGACY_EVIDENCE_DIR = getLegacyEvidenceRoot(REPO_ROOT);
const REPORT_PATH = path.join(EVIDENCE_DIR, "global-report.json");
const LEGACY_REPORT_PATH = path.join(LEGACY_EVIDENCE_DIR, "global-report.json");
const OUT_MD = path.join(EVIDENCE_DIR, "scorecard-audit.md");

const DIMENSIONS = [
  "reliability",
  "accuracy",
  "safety",
  "cost_efficiency",
  "memory_correctness",
  "delegation_quality",
  "evidence_quality",
  "simplicity",
] as const;

async function main() {
  const raw = await fs.readFile(await existingReportPath(), "utf8");
  const report = JSON.parse(raw);
  const cards = report.outcomes.map((o: any) => o.scorecard);

  const lines: string[] = ["# Scorecard Dimension Audit", ""];
  for (const dim of DIMENSIONS) {
    const scores = cards.map((c: any) => c.dimensions[dim]?.score ?? 0);
    const avg = scores.reduce((a: number, b: number) => a + b, 0) / scores.length;
    lines.push(`- ${dim}: avg=${avg.toFixed(3)} min=${Math.min(...scores).toFixed(3)} max=${Math.max(...scores).toFixed(3)}`);
  }
  lines.push("");
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  await fs.writeFile(OUT_MD, lines.join("\n"), "utf8");
  process.stdout.write(`[audit:scorecards] wrote ${path.relative(REPO_ROOT, OUT_MD)}\n`);
}

async function existingReportPath(): Promise<string> {
  if (await fs.stat(REPORT_PATH).then((info) => info.isFile()).catch(() => false)) return REPORT_PATH;
  return LEGACY_REPORT_PATH;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(String(e) + "\n");
    process.exit(0); // report-only never fails
  });
}
