# TiDB Cloud Smoke Test (manual, opt-in)

This is the **manual** smoke test for the optional hosted **TiDB Cloud** persistence
path. It performs a write-then-read-back cycle and **passes only when the read-back
record matches the written record field-for-field**. It exists so the hosted alpha
persistence path stays credible while **SQLite remains the local default**.

> SQLite (local file) is the default product persistence driver and the in-memory
> store is the provider-free test baseline. **TiDB is never auto-selected** — it is
> used only when you explicitly configure it, and this smoke test forces it on so it
> can never silently pass against a local store.

## Why this is manual and never runs in CI

The verification gates (`npm test`, `npm run build`, `npm run check`, the two
`--check` scripts) are **provider-free**: they require no credentials and make no
network calls. This smoke test does the opposite — it opens a real network
connection to TiDB Cloud and therefore needs real credentials. It is intentionally:

- **not** part of `npm test` / `npm run build` / `npm run check`,
- **not** invoked by `.github/workflows/ci.yml`,

so the gates continue to run to completion without TiDB credentials. Run it yourself,
locally, when you want to validate the hosted path.

## Required environment variables

Set these (e.g. in your `.env` file) before running the smoke test:

| Variable        | Required | Description                                             |
| --------------- | -------- | ------------------------------------------------------- |
| `TIDB_HOST`     | yes      | TiDB Cloud host endpoint (e.g. `gateway01.<region>.prod.aws.tidbcloud.com`) |
| `TIDB_PORT`     | yes      | TiDB Cloud port (typically `4000`)                      |
| `TIDB_USER`     | yes      | Database user                                           |
| `TIDB_PASSWORD` | yes      | Database password (held only inside the client; never logged) |
| `TIDB_DATABASE` | yes      | Target database / schema name                           |
| `TIDB_TLS`      | no       | Defaults to enabled; TiDB Cloud requires TLS. Set to `false` only to opt out. |

If any required field is missing or incomplete, the store factory raises a
`StoreConfigError` **before any network connection is attempted**, naming the missing
fields and exposing **no credential values**.

> The optional `sync-mysql` client backs the TiDB driver and is **not** a default
> dependency. If it is not installed, the smoke test fails with a clear message
> telling you to `npm install sync-mysql`. Local SQLite and the in-memory baseline
> need no extra dependency.

## Running the smoke test

```bash
# Convenience wrapper (loads .env automatically):
npm run smoke:tidb

# Or invoke directly:
tsx --env-file=.env scripts/tidb-smoke-test.ts
```

### What it does

1. Parses the environment with the canonical deployment parser, then **forces** the
   `tidb` driver so the test never runs against the in-memory or SQLite store.
2. Constructs the store through the existing
   `createRectorStore` / `assertCompleteTiDBConfig` / `StoreConfigError` path.
3. Writes a uniquely-named throwaway conversation record.
4. Reads it back and compares it to the written record **field-for-field**.
5. Deletes the throwaway record (best effort) so repeated runs do not accumulate rows.

### Interpreting the result

- **PASS** (`exit code 0`): the read-back record matched the written record
  field-for-field.
- **FAIL** (`exit code 1`): the configuration was incomplete, the write or read
  failed, the record could not be read back, or any field did not match. The output
  names the mismatched fields (or the missing config fields) with credential values
  redacted.

## Relationship to the verification gates

Because this script is excluded from every gate and from CI, the gates run to
completion without TiDB credentials. When no driver is explicitly configured, the
store factory uses the local default (the in-memory baseline for tests and SQLite for
the local file-backed product path) — TiDB is only ever exercised by running this
script with a complete TiDB connection block.
