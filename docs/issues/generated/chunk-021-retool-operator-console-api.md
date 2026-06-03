# Chunk 21 — Retool Operator Console API

Expose local operator endpoints for run inspection, failures, approvals, costs, retries, aborts, artifacts, and stub Linear issue creation.

## Metadata

- chunk: 021
- labels: roadmap, chunk:021, operator-api, retool, integrations, difficulty:advanced
- difficulty: advanced
- good first issue: false
- milestone: v0.1.0-alpha
- project board status: Ready

## Acceptance criteria

- [ ] Operator endpoints expose run, event, cost, artifact, retry, abort, and approval metadata for local inspection.
- [ ] Endpoints are clearly marked local-only and do not require Retool for tests.
- [ ] Linear issue creation remains a non-network stub unless future approval and credentials are added.

## Test commands

- `npm test -- tests/operatorApi.test.ts`
- `npm test`
- `npm run build`

## Project board / Linear sync

- Add to the GitHub project board manually in **Ready** for milestone **v0.1.0-alpha**.
- Linear sync is disabled by default for open-source contributors.
- If maintainers sync manually, use team **RECTOR**, priority **medium**, and labels: roadmap, chunk:021, operator-api, retool, integrations, difficulty:advanced.
- Do not paste credentials, API keys, or private board URLs into this issue.
