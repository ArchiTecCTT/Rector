# Chunk 9 — Planner Schema and Fake Planner

Define planner input/output contracts and a deterministic fake planner for local tests and provider-free development.

## Metadata

- chunk: 009
- labels: roadmap, chunk:009, planner, schemas, local-mode, difficulty:intermediate
- difficulty: intermediate
- good first issue: false
- milestone: v0.1.0-alpha
- project board status: Ready

## Acceptance criteria

- [ ] Planner input and output schemas validate goals, assumptions, tasks, dependencies, validation, and risk.
- [ ] Fake planner produces deterministic plans for local provider-free tests.
- [ ] Approval gates are represented for unsafe or ambiguous work.

## Test commands

- `npm test -- tests/planner.test.ts`
- `npm test`
- `npm run build`

## Project board / Linear sync

- Add to the GitHub project board manually in **Ready** for milestone **v0.1.0-alpha**.
- Linear sync is disabled by default for open-source contributors.
- If maintainers sync manually, use team **RECTOR**, priority **medium**, and labels: roadmap, chunk:009, planner, schemas, local-mode, difficulty:intermediate.
- Do not paste credentials, API keys, or private board URLs into this issue.
