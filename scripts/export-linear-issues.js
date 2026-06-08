#!/usr/bin/env node
// ============================================================
// Export the canonical roadmap issue catalog into Linear-ready
// import artifacts. Deterministic and provider-free: this script
// reads docs/issues/roadmap-issues.json and writes a CSV (for
// Linear's manual CSV importer) and a JSON file (for an API-based
// importer). It makes NO network calls and requires NO credentials.
//
// Usage:
//   node scripts/export-linear-issues.js            # write exports
//   node scripts/export-linear-issues.js --check    # verify exports are current
//   node scripts/export-linear-issues.js --out DIR  # custom output dir
// ============================================================

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const catalogPath = join(repoRoot, "docs", "issues", "roadmap-issues.json");
const defaultOutputDir = join(repoRoot, "docs", "issues", "linear");

// Map the catalog's documented priority to Linear's priority model.
// Linear priority: 0 None, 1 Urgent, 2 High, 3 Medium, 4 Low.
const PRIORITY_MAP = {
  high: { value: 2, label: "High" },
  medium: { value: 3, label: "Medium" },
  low: { value: 4, label: "Low" },
};

// The catalog's project-board status maps to a Linear workflow state.
// "Ready" issues are ready to be picked up -> Todo. Adjust during import
// if the target team uses different workflow state names.
const STATUS_MAP = {
  Ready: "Todo",
};

// Difficulty -> rough estimate points (optional convenience column).
const ESTIMATE_MAP = {
  beginner: 2,
  intermediate: 3,
  advanced: 5,
};

const CSV_COLUMNS = ["Title", "Description", "Status", "Priority", "Labels", "Estimate"];

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

function priorityFor(issue) {
  const key = issue.linearSync?.priority ?? "low";
  return PRIORITY_MAP[key] ?? PRIORITY_MAP.low;
}

function statusFor(issue) {
  const boardStatus = issue.projectBoard?.status ?? "Ready";
  return STATUS_MAP[boardStatus] ?? "Todo";
}

function sourceDocFor(issue) {
  const padded = String(issue.chunkNumber).padStart(3, "0");
  const titleWithoutPrefix = issue.title.replace(/^Chunk \d+ — /, "");
  return `docs/issues/generated/chunk-${padded}-${slugify(titleWithoutPrefix)}.md`;
}

function buildDescription(issue) {
  const padded = String(issue.chunkNumber).padStart(3, "0");
  const acceptance = issue.acceptanceCriteria.map((criterion) => `- [ ] ${criterion}`).join("\n");
  const tests = issue.testCommands.map((command) => `- \`${command}\``).join("\n");
  return [
    issue.summary,
    "",
    "## Acceptance criteria",
    "",
    acceptance,
    "",
    "## Test commands",
    "",
    tests,
    "",
    "## Roadmap metadata",
    "",
    `- Chunk: ${padded}`,
    `- Difficulty: ${issue.difficulty}`,
    `- Good first issue: ${issue.goodFirstIssue}`,
    `- Milestone: ${issue.projectBoard.milestone}`,
    `- Source of truth: ${sourceDocFor(issue)}`,
    "",
    "_Tracking note: the in-repo roadmap catalog (docs/issues/roadmap-issues.json) is the source of truth._",
    "_Do not paste credentials, API keys, or private board URLs into this issue._",
  ].join("\n");
}

function toLinearIssue(issue) {
  const priority = priorityFor(issue);
  return {
    chunkNumber: issue.chunkNumber,
    title: issue.title,
    description: buildDescription(issue),
    teamKey: issue.linearSync?.teamKey ?? "RECTOR",
    status: statusFor(issue),
    priority: priority.value,
    priorityLabel: priority.label,
    labels: issue.linearSync?.labels ?? issue.labels,
    estimate: ESTIMATE_MAP[issue.difficulty] ?? null,
    difficulty: issue.difficulty,
    goodFirstIssue: issue.goodFirstIssue,
    milestone: issue.projectBoard?.milestone ?? null,
    sourceDoc: sourceDocFor(issue),
  };
}

function csvEscape(value) {
  const str = String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function renderCsv(linearIssues) {
  const header = CSV_COLUMNS.join(",");
  const rows = linearIssues.map((issue) =>
    [
      issue.title,
      issue.description,
      issue.status,
      issue.priorityLabel,
      issue.labels.join(", "),
      issue.estimate ?? "",
    ]
      .map(csvEscape)
      .join(",")
  );
  // Trailing newline keeps the file POSIX-friendly and stable for --check.
  return [header, ...rows].join("\n") + "\n";
}

function renderJson(linearIssues) {
  const payload = {
    generatedFrom: "docs/issues/roadmap-issues.json",
    generator: "scripts/export-linear-issues.js",
    teamKey: "RECTOR",
    project: "Rector v0.1.0-alpha Roadmap",
    milestone: "v0.1.0-alpha",
    note:
      "Provider-free export. No network calls or credentials are used to produce this file. " +
      "An API-based importer must supply LINEAR_API_KEY and the target team id (LINEAR_TEAM_ID) at run time.",
    priorityModel: "Linear priority: 0 None, 1 Urgent, 2 High, 3 Medium, 4 Low.",
    statusMapping: STATUS_MAP,
    issueCount: linearIssues.length,
    issues: linearIssues.map((issue) => ({
      chunkNumber: issue.chunkNumber,
      title: issue.title,
      description: issue.description,
      teamKey: issue.teamKey,
      status: issue.status,
      priority: issue.priority,
      priorityLabel: issue.priorityLabel,
      labels: issue.labels,
      estimate: issue.estimate,
      difficulty: issue.difficulty,
      goodFirstIssue: issue.goodFirstIssue,
      milestone: issue.milestone,
      sourceDoc: issue.sourceDoc,
    })),
  };
  return JSON.stringify(payload, null, 2) + "\n";
}

function renderReadme(linearIssues) {
  const goodFirst = linearIssues.filter((issue) => issue.goodFirstIssue).length;
  return `# Linear Import Export

Import-ready export of the Rector v0.1.0-alpha roadmap (${linearIssues.length} issues, ${goodFirst} good-first-issue candidates).

These files are generated from the canonical catalog \`docs/issues/roadmap-issues.json\` by
\`scripts/export-linear-issues.js\`. They make **no network calls** and contain **no credentials**.
Regenerate after editing the catalog:

\`\`\`bash
node scripts/export-linear-issues.js
node scripts/export-linear-issues.js --check   # verify they are current
\`\`\`

## Files

- \`rector-roadmap-linear.csv\` — for Linear's built-in CSV importer.
- \`rector-roadmap-linear.json\` — structured data for an API-based importer.

## Option A — Manual CSV import (no API key)

1. In Linear, open the target team, then **Settings → Import/Export → Import → CSV** (or the
   team's **+ → Import issues** flow).
2. Upload \`rector-roadmap-linear.csv\`.
3. Map the columns when prompted:
   - **Title → Title**, **Description → Description**, **Status → Status**,
     **Priority → Priority**, **Labels → Labels**, **Estimate → Estimate** (optional).
4. The \`Status\` column uses \`Todo\` (mapped from the catalog's \`Ready\`). If your team uses a
   different workflow state name, remap it during import.
5. Labels are comma-separated inside the Labels cell. Linear creates any labels that do not
   exist yet.

## Option B — API import (requires credentials, run later)

Use the JSON file with Linear's GraphQL API (\`issueCreate\`). You will need:

- \`LINEAR_API_KEY\` — a personal API key from Linear (Settings → API → Personal API keys).
- The target **team id** (UUID). You can resolve it from the team key \`RECTOR\` via the API,
  or set \`LINEAR_TEAM_ID\` directly.

No importer script is committed yet because it would require live credentials and network
access, which are out of scope for the provider-free default. Ask the maintainer to wire one
up when the key and team id are available.

## Priority and status mapping

| Catalog priority | Linear priority |
|---|---|
| high | High (2) |
| medium | Medium (3) |
| low | Low (4) |

| Catalog board status | Linear workflow state |
|---|---|
| Ready | Todo |

## Source of truth

The in-repo roadmap catalog remains authoritative. Do not hand-edit these export files; edit
\`docs/issues/roadmap-issues.json\` and regenerate. Never commit API keys or private board URLs.
`;
}

function buildFiles(catalog) {
  const linearIssues = catalog.map(toLinearIssue);
  const files = new Map();
  files.set("rector-roadmap-linear.csv", renderCsv(linearIssues));
  files.set("rector-roadmap-linear.json", renderJson(linearIssues));
  files.set("README.md", renderReadme(linearIssues));
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
  const extra = existsSync(outputDir) ? readdirSync(outputDir).filter((file) => !files.has(file)) : [];
  if (missing.length || changed.length || extra.length) {
    throw new Error(
      `Linear export is stale. Missing: ${missing.join(", ") || "none"}. Changed: ${changed.join(", ") || "none"}. Extra: ${extra.join(", ") || "none"}.`
    );
  }
}

const args = parseArgs(process.argv.slice(2));
const catalog = loadCatalog();
const files = buildFiles(catalog);

if (args.check) {
  checkFiles(args.out, files);
  console.log(`linear export is current (${catalog.length} issues)`);
} else {
  writeFiles(args.out, files);
  console.log(`wrote linear export for ${catalog.length} issues to ${args.out}`);
}

export { buildFiles, toLinearIssue, renderCsv, renderJson, PRIORITY_MAP, STATUS_MAP };
