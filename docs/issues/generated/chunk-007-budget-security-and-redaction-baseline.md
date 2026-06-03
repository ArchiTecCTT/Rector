# Chunk 7 — Budget, Security, and Redaction Baseline

Add local budget controls, redaction utilities, setup-checklist secret safety, CORS config, dev auth bypass, and budget denial flow.

## Metadata

- chunk: 007
- labels: roadmap, chunk:007, security, budget, redaction, difficulty:intermediate
- difficulty: intermediate
- good first issue: false
- milestone: v0.1.0-alpha
- project board status: Ready

## Acceptance criteria

- [ ] Budget limits can deny work before provider calls are attempted.
- [ ] Redaction utilities remove secrets from logs, telemetry, docs examples, and setup output.
- [ ] Security tests cover CORS, dev-only auth bypass, rate limiting, and secret safety.

## Test commands

- `npm test -- tests/security.test.ts`
- `npm test`
- `npm run build`

## Project board / Linear sync

- Add to the GitHub project board manually in **Ready** for milestone **v0.1.0-alpha**.
- Linear sync is disabled by default for open-source contributors.
- If maintainers sync manually, use team **RECTOR**, priority **high**, and labels: roadmap, chunk:007, security, budget, redaction, difficulty:intermediate.
- Do not paste credentials, API keys, or private board URLs into this issue.
