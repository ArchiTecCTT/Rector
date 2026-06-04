# Tracking Rector Progress in Linear

This page documents how Rector's roadmap is mirrored into a Linear board for progress
tracking, and how to keep the two in sync. It complements — but does not replace — the
in-repo source of truth.

## Source of truth vs. tracking board

- **Source of truth (authoritative):** the in-repo roadmap and issue catalog.
  - [`plans/rector-master-roadmap.md`](../plans/rector-master-roadmap.md) — roadmap and chunk order.
  - [`issues/roadmap-issues.json`](../issues/roadmap-issues.json) — the canonical issue catalog (26 chunks, 0–25).
  - [`issues/generated/`](../issues/generated/) — per-chunk Markdown drafts generated from the catalog.
- **Tracking board (mirror):** the **Ornyx** team in Linear (team key `ORN`). The board is a
  convenience view for status and "what to work on next." If the board and the catalog ever
  disagree, the catalog wins.

The catalog is deterministic and CI-guarded: `node scripts/generate-roadmap-issues.js --check`
and `node scripts/export-linear-issues.js --check` both run in CI, so the committed drafts and
the Linear export cannot silently drift from the catalog.

## The pipeline

```text
docs/issues/roadmap-issues.json        (canonical catalog — edit here)
        │
        ├─ scripts/generate-roadmap-issues.js  → docs/issues/generated/*.md   (GitHub-style drafts)
        │
        └─ scripts/export-linear-issues.js     → docs/issues/linear/          (import-ready CSV + JSON)
                                                        │
                                                        └─ (local importer) → Linear team "Ornyx"
```

Both generator scripts are provider-free: they make **no network calls** and require **no
credentials**. Only the final import step talks to Linear, and that step is intentionally a
**local, gitignored** script (see below), not part of the committed codebase.

## The committed export (`docs/issues/linear/`)

`scripts/export-linear-issues.js` turns the catalog into import-ready files:

- `rector-roadmap-linear.csv` — for Linear's built-in CSV importer (no API key needed).
- `rector-roadmap-linear.json` — structured data for an API-based importer.
- `README.md` — import instructions.

Mappings applied by the export:

| Catalog field | Linear field |
| --- | --- |
| `linearSync.priority` high / medium / low | priority High (2) / Medium (3) / Low (4) |
| `projectBoard.status` `Ready` | workflow state `Todo` (unstarted) |
| `difficulty` beginner / intermediate / advanced | estimate 2 / 3 / 5 |
| `labels` | Linear labels (created on demand) |

Regenerate after editing the catalog:

```bash
node scripts/export-linear-issues.js          # write docs/issues/linear/
node scripts/export-linear-issues.js --check  # verify it is current (also runs in CI)
```

## Current board state

All 26 roadmap chunks were imported into the Ornyx team once each. The chunk → issue mapping
from the initial import:

```text
chunk 00 → ORN-5    chunk 09 → ORN-17   chunk 18 → ORN-25
chunk 01 → ORN-6    chunk 10 → ORN-18   chunk 19 → ORN-26
chunk 02 → ORN-7    chunk 11 → ORN-19   chunk 20 → ORN-10
chunk 03 → ORN-8    chunk 12 → ORN-20   chunk 21 → ORN-27
chunk 04 → ORN-12   chunk 13 → ORN-21   chunk 22 → ORN-28
chunk 05 → ORN-13   chunk 14 → ORN-9    chunk 23 → ORN-29
chunk 06 → ORN-14   chunk 15 → ORN-22   chunk 24 → ORN-30
chunk 07 → ORN-15   chunk 16 → ORN-23   chunk 25 → ORN-11
chunk 08 → ORN-16   chunk 17 → ORN-24
```

These identifiers reflect creation order, not chunk order (the import ran in two passes). The
mapping is informational; Linear is the live source for current status.

## Importing / re-importing

There are two paths.

### Option A — manual CSV import (no credentials)

1. In Linear, open the **Ornyx** team → import issues → CSV.
2. Upload `docs/issues/linear/rector-roadmap-linear.csv`.
3. Map columns: Title, Description, Status, Priority, Labels, Estimate.
4. Remap the `Todo` status if the team uses a different workflow state name.

This is the recommended path for a fresh team because it has no credential exposure.

### Option B — API import (local, gitignored)

An API-based importer was used for the initial load. It lives under `scripts/local/`, which is
**gitignored on purpose** — it makes live network calls and uses a credential, so it is not part
of the committed provider-free codebase. It reads credentials from the gitignored `.env`:

```ini
LINEAR_API_KEY=lin_api_...        # personal API key (Settings → API → Personal API keys)
LINEAR_TEAM_ID=<team uuid>        # the Ornyx team id
```

The importer defaults to a **dry run** (no writes). Key safety properties:

- Dry run unless `--apply` is passed.
- The API key is never printed (only a masked preview).
- No dedupe: re-running with `--apply` creates duplicates. Use `--skip-chunks <list>` to avoid
  re-creating issues from a previous run, and `--limit 1` to smoke-test a single issue first.

> ⚠️ **Credential hygiene.** Never paste a Linear API key into chat, commits, or shared logs.
> Keep it only in the gitignored `.env`. If a key is exposed, rotate it immediately in
> Linear → Settings → API → Personal API keys. Re-creating the importer scripts is fine; they
> are deliberately excluded from version control.

## Keeping the board in sync

When the roadmap changes:

1. Edit `docs/issues/roadmap-issues.json` (the catalog).
2. Run `node scripts/generate-roadmap-issues.js` and `node scripts/export-linear-issues.js`.
3. Commit the regenerated drafts and export (CI `--check` steps enforce this).
4. Reflect the change on the Linear board manually, or re-run the local importer for **new**
   chunks only (use `--skip-chunks` for ones that already exist).

Automatic two-way sync is intentionally **not** implemented. There is no webhook, no scheduled
job, and no committed code that calls Linear. Syncing is a deliberate, maintainer-gated action.

## Optional: Linear MCP server in Kiro

For ongoing project management, the Linear MCP server can be added to Kiro so the agent can
read and update issues directly (instead of one-off local scripts). If you enable it:

- Configure it at **user level** (`~/.kiro/settings/mcp.json`), not in the repo, so the API key
  never lives near version control.
- Use a **freshly rotated** key scoped to what you need.

This is optional and unrelated to the provider-free runtime; it only affects the local
development/agent environment.
