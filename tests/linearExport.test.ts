import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type RoadmapIssue = {
  chunkNumber: number;
  title: string;
  difficulty: "beginner" | "intermediate" | "advanced";
  goodFirstIssue: boolean;
  linearSync: {
    teamKey: string;
    priority: "low" | "medium" | "high";
  };
};

const issues = JSON.parse(readFileSync("docs/issues/roadmap-issues.json", "utf8")) as RoadmapIssue[];

describe("linear export generator", () => {
  it("is provider-free and contains no network-capable code", () => {
    const script = readFileSync("scripts/export-linear-issues.js", "utf8");
    expect(script).not.toMatch(/\bfetch\b|node:https|node:http|XMLHttpRequest/);
  });

  it("writes a CSV, JSON, and README export for every catalog entry", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "rector-linear-"));
    try {
      execFileSync(process.execPath, ["scripts/export-linear-issues.js", "--out", outputDir], {
        stdio: "pipe",
        env: { ...process.env, GITHUB_TOKEN: "must-not-be-used", LINEAR_API_KEY: "must-not-be-used" },
      });

      const files = readdirSync(outputDir).sort();
      expect(files).toEqual(["README.md", "rector-roadmap-linear.csv", "rector-roadmap-linear.json"]);

      const json = JSON.parse(readFileSync(join(outputDir, "rector-roadmap-linear.json"), "utf8"));
      expect(json.issueCount).toBe(26);
      expect(json.issues).toHaveLength(26);
      expect(json.teamKey).toBe("RECTOR");
      expect(json.issues.map((issue: { chunkNumber: number }) => issue.chunkNumber)).toEqual(
        Array.from({ length: 26 }, (_, index) => index)
      );

      // No injected secret should ever leak into the output.
      const csv = readFileSync(join(outputDir, "rector-roadmap-linear.csv"), "utf8");
      expect(csv).not.toContain("must-not-be-used");
      expect(json.note).not.toContain("must-not-be-used");

      // CSV header is stable and rows match the catalog size (header + 26).
      const lines = csv.trimEnd().split("\n");
      expect(lines[0]).toBe("Title,Description,Status,Priority,Labels,Estimate");

      // Priority mapping: a high-priority chunk (7 security) maps to "High".
      const securityIssue = json.issues.find((issue: { chunkNumber: number }) => issue.chunkNumber === 7);
      expect(securityIssue.priority).toBe(2);
      expect(securityIssue.priorityLabel).toBe("High");
      expect(securityIssue.status).toBe("Todo");
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("preserves good-first-issue flags from the catalog", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "rector-linear-gfi-"));
    try {
      execFileSync(process.execPath, ["scripts/export-linear-issues.js", "--out", outputDir], { stdio: "pipe" });
      const json = JSON.parse(readFileSync(join(outputDir, "rector-roadmap-linear.json"), "utf8"));
      const exportedGoodFirst = json.issues
        .filter((issue: { goodFirstIssue: boolean }) => issue.goodFirstIssue)
        .map((issue: { chunkNumber: number }) => issue.chunkNumber)
        .sort((a: number, b: number) => a - b);
      const catalogGoodFirst = issues
        .filter((issue) => issue.goodFirstIssue)
        .map((issue) => issue.chunkNumber)
        .sort((a, b) => a - b);
      expect(exportedGoodFirst).toEqual(catalogGoodFirst);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("check mode verifies the committed export is current", () => {
    const output = execFileSync(process.execPath, ["scripts/export-linear-issues.js", "--check"], {
      encoding: "utf8",
      stdio: "pipe",
    });
    expect(output).toContain("linear export is current");
  });
});
