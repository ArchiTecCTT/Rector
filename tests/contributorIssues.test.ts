import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type RoadmapIssue = {
  chunkNumber: number;
  title: string;
  summary: string;
  labels: string[];
  difficulty: "beginner" | "intermediate" | "advanced";
  goodFirstIssue: boolean;
  acceptanceCriteria: string[];
  testCommands: string[];
  projectBoard: {
    status: string;
    milestone: string;
  };
  linearSync: {
    enabled: boolean;
    teamKey: string;
    labels: string[];
    priority: "low" | "medium" | "high";
  };
};

const issues = JSON.parse(readFileSync("docs/issues/roadmap-issues.json", "utf8")) as RoadmapIssue[];

describe("contributor roadmap issue catalog", () => {
  it("covers every roadmap chunk exactly once with issue-ready metadata", () => {
    expect(issues).toHaveLength(26);
    expect(issues.map((issue) => issue.chunkNumber)).toEqual(Array.from({ length: 26 }, (_, index) => index));

    const seenTitles = new Set<string>();
    for (const issue of issues) {
      const padded = String(issue.chunkNumber).padStart(3, "0");
      expect(seenTitles.has(issue.title)).toBe(false);
      seenTitles.add(issue.title);
      expect(issue.title).toContain(`Chunk ${issue.chunkNumber}`);
      expect(issue.summary.trim().length).toBeGreaterThan(20);
      expect(issue.labels).toContain("roadmap");
      expect(issue.labels).toContain(`chunk:${padded}`);
      expect(issue.labels).toContain(`difficulty:${issue.difficulty}`);
      expect(issue.acceptanceCriteria.length).toBeGreaterThanOrEqual(3);
      expect(issue.testCommands).toContain("npm test");
      expect(issue.testCommands).toContain("npm run build");
      expect(issue.projectBoard.status).toBe("Ready");
      expect(issue.projectBoard.milestone).toBe("v0.1.0-alpha");
      expect(issue.linearSync.enabled).toBe(false);
      expect(issue.linearSync.teamKey).toBe("RECTOR");
      expect(issue.linearSync.labels).toEqual(expect.arrayContaining(issue.labels));
      expect(["low", "medium", "high"]).toContain(issue.linearSync.priority);
      if (issue.goodFirstIssue) {
        expect(issue.labels).toContain("good first issue");
        expect(issue.difficulty).toBe("beginner");
      }
    }
  });

  it("marks safe contributor entry points as good first issue candidates", () => {
    const goodFirstIssues = issues.filter((issue) => issue.goodFirstIssue);

    expect(goodFirstIssues.length).toBeGreaterThanOrEqual(4);
    expect(goodFirstIssues.map((issue) => issue.chunkNumber)).toEqual(expect.arrayContaining([0, 1, 2, 20, 25]));
    for (const issue of goodFirstIssues) {
      expect(issue.labels).toEqual(expect.arrayContaining(["good first issue", "contributor-experience"]));
    }
  });

  it("includes actionable Chunk 25 issue generation and sync guidance criteria", () => {
    const chunk25 = issues.find((issue) => issue.chunkNumber === 25);

    expect(chunk25).toBeDefined();
    expect(chunk25?.labels).toEqual(expect.arrayContaining(["docs", "contributor-experience", "automation"]));
    expect(chunk25?.acceptanceCriteria.join("\n")).toMatch(/GitHub issue/i);
    expect(chunk25?.acceptanceCriteria.join("\n")).toMatch(/project board/i);
    expect(chunk25?.acceptanceCriteria.join("\n")).toMatch(/Linear/i);
    expect(chunk25?.testCommands).toContain("node scripts/generate-roadmap-issues.js --check");
  });
});

describe("roadmap issue generator", () => {
  it("renders one Markdown issue per catalog entry plus an index without network-capable code", () => {
    const script = readFileSync("scripts/generate-roadmap-issues.js", "utf8");
    expect(script).not.toMatch(/\bfetch\b|node:https|node:http|XMLHttpRequest/);

    const outputDir = mkdtempSync(join(tmpdir(), "rector-issues-"));
    try {
      execFileSync(process.execPath, ["scripts/generate-roadmap-issues.js", "--out", outputDir], {
        stdio: "pipe",
        env: { ...process.env, GITHUB_TOKEN: "must-not-be-used", LINEAR_API_KEY: "must-not-be-used" },
      });

      const files = readdirSync(outputDir).sort();
      const issueFiles = files.filter((file) => /^chunk-\d{3}-.*\.md$/.test(file));
      expect(issueFiles).toHaveLength(26);
      expect(files).toContain("README.md");

      const chunk25Markdown = readFileSync(join(outputDir, "chunk-025-contributor-issue-breakdown.md"), "utf8");
      expect(chunk25Markdown).toContain("labels:");
      expect(chunk25Markdown).toContain("acceptance criteria");
      expect(chunk25Markdown).toContain("test commands");
      expect(chunk25Markdown).toContain("difficulty: beginner");
      expect(chunk25Markdown).toContain("good first issue: true");
      expect(chunk25Markdown).toContain("Project board / Linear sync");
      expect(chunk25Markdown).not.toContain("must-not-be-used");

      const indexMarkdown = readFileSync(join(outputDir, "README.md"), "utf8");
      expect(indexMarkdown).toContain("26 generated roadmap issue drafts");
      expect(indexMarkdown).toContain("No GitHub or Linear API calls");
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("check mode verifies committed generated docs are current", () => {
    const output = execFileSync(process.execPath, ["scripts/generate-roadmap-issues.js", "--check"], {
      encoding: "utf8",
      stdio: "pipe",
    });

    expect(output).toContain("roadmap issue docs are current");
  });
});
