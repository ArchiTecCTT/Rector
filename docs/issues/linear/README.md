# Linear Import Export

Import-ready export of the Rector v0.1.0-alpha roadmap (26 issues, 5 good-first-issue candidates).

These files are generated from the canonical catalog `docs/issues/roadmap-issues.json` by
`scripts/export-linear-issues.js`. They make **no network calls** and contain **no credentials**.
Regenerate after editing the catalog:

```bash
node scripts/export-linear-issues.js
node scripts/export-linear-issues.js --check   # verify they are current
```

## Files

- `rector-roadmap-linear.csv` — for Linear's built-in CSV importer.
- `rector-roadmap-linear.json` — structured data for an API-based importer.

## Option A — Manual CSV import (no API key)

1. In Linear, open the target team, then **Settings → Import/Export → Import → CSV** (or the
   team's **+ → Import issues** flow).
2. Upload `rector-roadmap-linear.csv`.
3. Map the columns when prompted:
   - **Title → Title**, **Description → Description**, **Status → Status**,
     **Priority → Priority**, **Labels → Labels**, **Estimate → Estimate** (optional).
4. The `Status` column uses `Todo` (mapped from the catalog's `Ready`). If your team uses a
   different workflow state name, remap it during import.
5. Labels are comma-separated inside the Labels cell. Linear creates any labels that do not
   exist yet.

## Option B — API import (requires credentials, run later)

Use the JSON file with Linear's GraphQL API (`issueCreate`). You will need:

- `LINEAR_API_KEY` — a personal API key from Linear (Settings → API → Personal API keys).
- The target **team id** (UUID). You can resolve it from the team key `RECTOR` via the API,
  or set `LINEAR_TEAM_ID` directly.

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
`docs/issues/roadmap-issues.json` and regenerate. Never commit API keys or private board URLs.
