# Implementation Plan: CI Release Workflow

## Overview

This plan delivers a single GitHub Actions CI workflow at `.github/workflows/ci.yml`
that reproduces Rector's local verification gates (`npm test`, `npm run build`,
`npm run check`, plus the deterministic drift check) across a Node 22 / Node 24 matrix,
installs deterministically with `npm ci`, surfaces a non-blocking `npm audit`, and runs
provider-free with no secrets. It then validates that file locally (structured review,
optional well-formedness check), confirms the green baseline with the local-equivalent
command suite, and documents the gates in the README (with an optional CONTRIBUTING note).

This is infrastructure / configuration work: the deliverable is a YAML workflow file plus
a small documentation update. There is no application source module to unit test, and
property-based testing is **not applicable** (the design documents this and omits the
Correctness Properties section). Validation is therefore done through local-equivalent
command runs, structured YAML review, and real CI execution — not new unit or property
tests. The workflow builds the single `ci.yml` file incrementally so each step leaves the
file in a valid, integrated state.

## Tasks

- [x] 1. Author the CI workflow file (`.github/workflows/ci.yml`)
  - [x] 1.1 Create the `.github/workflows/` directory and the workflow header
    - Create `.github/workflows/ci.yml` (the `workflows/` directory does not yet exist).
    - Set `name: CI` to identify it as continuous integration.
    - Declare explicit triggers: `on.push.branches: [main, rector-0.1.0]` and
      `on.pull_request.branches: [main, rector-0.1.0]`.
    - Set workflow-level `permissions: contents: read` (least privilege) — this
      structurally prevents publishing, tagging, or pushing and keeps the file
      structured so a separate `release.yml` can be added later without touching the
      verify job.
    - Reference no `secrets.*` and inject no credential `env:` block.
    - _Requirements: 1.1, 1.4, 2.1, 2.2, 2.3, 8.1, 8.4, 12.1, 12.2, 12.3, 12.4_

  - [x] 1.2 Define the `verify` job, Node matrix, and dependency-setup steps
    - Add a single named job `verify` with `name: Verify / Node ${{ matrix.node-version }}`
      and `runs-on: ubuntu-latest`.
    - Configure `strategy.fail-fast: false` and `strategy.matrix.node-version: [22, 24]`
      so both Node versions report results independently.
    - Add the first ordered steps: `actions/checkout@v4`, then `actions/setup-node@v4`
      with `node-version: ${{ matrix.node-version }}` and `cache: npm` (npm cache keyed on
      the committed `package-lock.json`, restored/reused on a hit).
    - _Requirements: 1.3, 6.1, 6.2, 6.3, 6.4, 9.1, 9.2, 9.3_

  - [x] 1.3 Add the deterministic install, verification baseline, and drift-check steps
    - Add `run: npm ci` as the deterministic install, ordered before any baseline command
      or the drift check (a non-zero exit fails the job and stops later steps).
    - Add the ordered baseline steps `run: npm test`, `run: npm run build`,
      `run: npm run check` (any non-zero exit fails the job).
    - Add `run: node scripts/generate-roadmap-issues.js --check` as the drift check
      (pure local filesystem I/O; non-zero exit on stale/missing/extra docs fails the job;
      no network beyond the registry already used by install).
    - Keep the run provider-free with no provider flags or API keys.
    - _Requirements: 3.1, 3.2, 3.3, 4.1, 4.2, 4.3, 4.4, 5.1, 5.2, 5.3, 8.2, 8.3_

  - [x] 1.4 Add the non-blocking audit step to complete the workflow
    - Add `run: npm audit` as the final step with `continue-on-error: true` so an audit
      failure (deferred dev-tooling advisories) does not fail the job while the report stays
      visible in the run logs.
    - Confirm the completed file wires all steps in contractual order (checkout →
      setup-node → install → test → build → check → drift → audit) with no orphaned config.
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

- [x] 2. Validate the workflow file locally (no new dependency)
  - [x] 2.1 Structured review of `ci.yml` against the design
    - Confirm the file contains: `name: CI`; explicit `push` and `pull_request` triggers on
      `[main, rector-0.1.0]`; `permissions: contents: read`; the `verify` job with
      `runs-on: ubuntu-latest`, `fail-fast: false`, `matrix.node-version: [22, 24]`; and the
      eight ordered steps with the exact commands from the design's Data Models table.
    - Confirm no `secrets.*` references and no publish/tag/push steps exist.
    - _Requirements: 1.2, 2.3, 3.2, 6.3, 7.2, 8.1, 12.1, 12.2, 12.3_

  - [x]* 2.2 Optional ad-hoc YAML well-formedness check
    - Parse `.github/workflows/ci.yml` using already-available tooling without adding a YAML
      dependency to `package.json` — e.g. a transient parser via `npx`, or
      `python -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml'))"` if a
      local interpreter is available.
    - _Requirements: 1.2_

- [x] 3. Confirm the green local-equivalent baseline
  - [x] 3.1 Run the local-equivalent verification gates and confirm they pass
    - Run `npm ci`, then `npm test`, `npm run build`, `npm run check`, and
      `node scripts/generate-roadmap-issues.js --check`, confirming each completes
      successfully.
    - Confirm `npm test` reports at least 29 test files and 280 passing tests
      (expected baseline ~29 files / 280 tests).
    - If any command fails, correct the workflow file (Task 1) before treating the CI gates
      as authoritative; `npm audit` may be run locally for awareness only (its non-zero exit
      is expected and gates nothing).
    - _Requirements: 11.1, 11.2, 11.3_

- [x] 4. Document the CI gates
  - [x] 4.1 Update `README.md` with a CI / Verification Gates section
    - Expand the existing "Running Tests" section into a "CI / Verification Gates" section
      describing the gates enforced by the workflow: `npm test`, `npm run build`,
      `npm run check`, and the drift check `node scripts/generate-roadmap-issues.js --check`.
    - State that CI runs on Node 22 and Node 24, that the `npm audit` step is non-blocking
      (surfaces deferred dev-tooling advisories without failing the build), and reference the
      workflow file location `.github/workflows/ci.yml`. Keep docs churn minimal.
    - _Requirements: 10.1, 10.2, 10.3, 10.4_

  - [x]* 4.2 Add a supporting CONTRIBUTING.md reference
    - Add a short "Before you open a PR" note in `CONTRIBUTING.md` pointing to the same gates
      and the workflow file, keeping the contributor flow and CI aligned.
    - _Requirements: 10.1, 10.4_

- [x] 5. Final checkpoint
  - Ensure all local-equivalent gates pass and the workflow file matches the design, ask the
    user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster path; core tasks must
  be implemented.
- The workflow file is built incrementally (1.1 → 1.4); each sub-task leaves `ci.yml` in a
  valid, integrated state, ending with the full step wiring in 1.4.
- This feature is CI configuration plus docs, so there is no application module to unit test
  and property-based testing is not applicable (per the design). Validation is via
  local-equivalent command runs (Task 3), structured YAML review (Task 2), and real CI
  execution once the file is pushed.
- Each task references specific requirement clauses for traceability.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "3.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["1.3"] },
    { "id": 3, "tasks": ["1.4"] },
    { "id": 4, "tasks": ["2.1", "2.2", "4.1", "4.2"] }
  ]
}
```
