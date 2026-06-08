#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const catalogPath = join(repoRoot, "docs", "issues", "roadmap-issues.json");
const defaultOutputDir = join(repoRoot, "docs", "issues", "generated");

function parseArgs(argv) {
  const args = { check: false, out: defaultOutputDir };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") {
      args.check = true;
    } else if (arg === "--out") {
      const value = argv[index + 1];
      if (!value) throw new Error("--out requires a directory");
      args.out = resolve(process.cwd(), value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function loadCatalog() {
  return JSON.parse(readFileSync(catalogPath, "utf8"));
}

function validateCatalog(issues) {
  const errors = [];
  const allowedDifficulty = new Set(["beginner", "intermediate", "advanced"]);
  const expectedNumbers = Array.from({ length: 26 }, (_, index) => index);
  const actualNumbers = issues.map((issue) => issue.chunkNumber);
  if (JSON.stringify(actualNumbers) !== JSON.stringify(expectedNumbers)) {
    errors.push("Catalog must contain chunks 0 through 25 in order.");
  }

  for (const issue of issues) {
    const prefix = `Chunk ${issue.chunkNumber}`;
    const padded = String(issue.chunkNumber).padStart(3, "0");
    if (!issue.title?.includes(prefix)) errors.push(`${prefix}: title must include chunk number.`);
    if (!issue.summary || issue.summary.length < 20) errors.push(`${prefix}: summary is too short.`);
    if (!Array.isArray(issue.labels) || issue.labels.length < 3) errors.push(`${prefix}: labels missing.`);
    if (!issue.labels?.includes("roadmap")) errors.push(`${prefix}: missing roadmap label.`);
    if (!issue.labels?.includes(`chunk:${padded}`)) errors.push(`${prefix}: missing chunk label.`);
    if (!allowedDifficulty.has(issue.difficulty)) errors.push(`${prefix}: invalid difficulty.`);
    if (!issue.labels?.includes(`difficulty:${issue.difficulty}`)) errors.push(`${prefix}: missing difficulty label.`);
    if (issue.goodFirstIssue && (!issue.labels?.includes("good first issue") || issue.difficulty !== "beginner")) {
      errors.push(`${prefix}: good first issue requires beginner difficulty and label.`);
    }
    if (!Array.isArray(issue.acceptanceCriteria) || issue.acceptanceCriteria.length < 3) {
      errors.push(`${prefix}: acceptance criteria must include at least three items.`);
    }
    if (!issue.testCommands?.includes("npm test") || !issue.testCommands?.includes("npm run build")) {
      errors.push(`${prefix}: test commands must include npm test and npm run build.`);
    }
    if (issue.projectBoard?.status !== "Ready" || issue.projectBoard?.milestone !== "v0.1.0-alpha") {
      errors.push(`${prefix}: project board metadata is incomplete.`);
    }
    if (issue.linearSync?.enabled !== false || issue.linearSync?.teamKey !== "RECTOR") {
      errors.push(`${prefix}: Linear sync must be documented as manual/disabled by default.`);
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
}

function renderIssue(issue) {
  const padded = String(issue.chunkNumber).padStart(3, "0");
  return `# ${issue.title}

${issue.summary}

## Metadata

- chunk: ${padded}
- labels: ${issue.labels.join(", ")}
- difficulty: ${issue.difficulty}
- good first issue: ${issue.goodFirstIssue}
- milestone: ${issue.projectBoard.milestone}
- project board status: ${issue.projectBoard.status}

## Acceptance criteria

${issue.acceptanceCriteria.map((criterion) => `- [ ] ${criterion}`).join("\n")}

## Test commands

${issue.testCommands.map((command) => `- \`${command}\``).join("\n")}

## Project board / Linear sync

- Add to the GitHub project board manually in **${issue.projectBoard.status}** for milestone **${issue.projectBoard.milestone}**.
- Linear sync is disabled by default for open-source contributors.
- If maintainers sync manually, use team **${issue.linearSync.teamKey}**, priority **${issue.linearSync.priority}**, and labels: ${issue.linearSync.labels.join(", ")}.
- Do not paste credentials, API keys, or private board URLs into this issue.
`;
}

function renderReadme(issues) {
  const rows = issues
    .map((issue) => {
      const padded = String(issue.chunkNumber).padStart(3, "0");
      const file = `chunk-${padded}-${slugify(issue.title.replace(/^Chunk \d+ — /, ""))}.md`;
      return `- [${issue.title}](./${file}) — ${issue.difficulty}${issue.goodFirstIssue ? "; good first issue" : ""}`;
    })
    .join("\n");

  return `# Generated Roadmap Issue Drafts

This directory contains ${issues.length} generated roadmap issue drafts for Rector v0.1.0-alpha.

No GitHub or Linear API calls are made by the generator. Maintainers can copy these drafts into GitHub Issues and optionally mirror them into Linear using the metadata in each file.

## Drafts

${rows}
`;
}

function buildFiles(issues) {
  const files = new Map();
  files.set("README.md", renderReadme(issues));
  for (const issue of issues) {
    const padded = String(issue.chunkNumber).padStart(3, "0");
    const titleWithoutPrefix = issue.title.replace(/^Chunk \d+ — /, "");
    files.set(`chunk-${padded}-${slugify(titleWithoutPrefix)}.md`, renderIssue(issue));
  }
  return files;
}

function writeFiles(outputDir, files) {
  if (existsSync(outputDir)) rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  for (const [file, content] of files) {
    writeFileSync(join(outputDir, file), content, "utf8");
  }
}

function checkFiles(outputDir, files) {
  const missing = [];
  const changed = [];
  for (const [file, content] of files) {
    const path = join(outputDir, file);
    if (!existsSync(path)) {
      missing.push(file);
    } else {
      const existing = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
      const generated = content.replace(/\r\n/g, "\n");
      if (existing !== generated) {
        changed.push(file);
      }
    }
  }
  const extra = existsSync(outputDir)
    ? readdirSync(outputDir).filter((file) => !files.has(file))
    : [];
  if (missing.length || changed.length || extra.length) {
    throw new Error(`Generated issue docs are stale. Missing: ${missing.join(", ") || "none"}. Changed: ${changed.join(", ") || "none"}. Extra: ${extra.join(", ") || "none"}.`);
  }
}

const args = parseArgs(process.argv.slice(2));
const issues = loadCatalog();
validateCatalog(issues);
const files = buildFiles(issues);

if (args.check) {
  checkFiles(args.out, files);
  console.log(`roadmap issue docs are current (${issues.length} issues)`);
} else {
  writeFiles(args.out, files);
  console.log(`wrote ${issues.length} roadmap issue drafts to ${args.out}`);
}
