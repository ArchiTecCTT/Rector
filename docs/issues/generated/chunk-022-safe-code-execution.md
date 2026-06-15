# Chunk 22 — Safe Code Execution

Add sandbox adapter contracts, hardened local allowlist behavior, patch artifacts, approval metadata, and E2B/Depot integration paths.

## Metadata

- chunk: 022
- labels: roadmap, chunk:022, sandbox, security, execution, difficulty:advanced
- difficulty: advanced
- good first issue: false
- milestone: v0.1.0-alpha
- project board status: Ready

## Acceptance criteria

- [ ] Sandbox contracts and local safe executor deny arbitrary shell by default.
- [ ] Patch artifacts and file-write approval metadata are represented without applying unsafe changes automatically.
- [ ] E2B and Depot adapters are documented/stubbed as opt-in future integrations.

## Test commands

- `npm test -- tests/safeCodeExecution.test.ts`
- `npm test`
- `npm run build`

## Project board / Linear sync

- Add to the GitHub project board manually in **Ready** for milestone **v0.1.0-alpha**.
- Linear sync is disabled by default for open-source contributors.
- If maintainers sync manually, use team **RECTOR**, priority **high**, and labels: roadmap, chunk:022, sandbox, security, execution, difficulty:advanced.
- Do not paste credentials, API keys, or private board URLs into this issue.
