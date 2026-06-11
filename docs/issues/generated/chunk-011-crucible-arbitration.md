# Chunk 11 — Crucible Arbitration

Implement deterministic rules that arbitrate planner and skeptic outputs with revision, escalation, and blocker handling.

## Metadata

- chunk: 011
- labels: roadmap, chunk:011, arbitration, planner, difficulty:intermediate
- difficulty: intermediate
- good first issue: false
- milestone: v0.1.0-alpha
- project board status: Ready

## Acceptance criteria

- [ ] Accepted plans, requested revisions, blockers, and escalation outcomes are deterministic.
- [ ] Planner versus skeptic disagreements are resolved without LLM judgment.
- [ ] At most two revision rounds occur before escalation.

## Test commands

- `npm test -- tests/crucible.test.ts`
- `npm test`
- `npm run build`

## Project board / Linear sync

- Add to the GitHub project board manually in **Ready** for milestone **v0.1.0-alpha**.
- Linear sync is disabled by default for open-source contributors.
- If maintainers sync manually, use team **RECTOR**, priority **medium**, and labels: roadmap, chunk:011, arbitration, planner, difficulty:intermediate.
- Do not paste credentials, API keys, or private board URLs into this issue.
