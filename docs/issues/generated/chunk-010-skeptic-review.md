# Chunk 10 — Skeptic Review

Add adversarial plan review that flags missing validation, unsafe assumptions, unsupported claims, and nonexistent dependencies.

## Metadata

- chunk: 010
- labels: roadmap, chunk:010, review, planner, quality, difficulty:intermediate
- difficulty: intermediate
- good first issue: false
- milestone: v0.1.0-alpha
- project board status: Ready

## Acceptance criteria

- [ ] Skeptic review returns structured findings with severity and actionable messages.
- [ ] Review flags missing validation, dangling dependencies, risky assumptions, and unsupported claims.
- [ ] Tests cover accepted plans, warnings, blockers, and low-risk underestimation.

## Test commands

- `npm test -- tests/skeptic.test.ts`
- `npm test`
- `npm run build`

## Project board / Linear sync

- Add to the GitHub project board manually in **Ready** for milestone **v0.1.0-alpha**.
- Linear sync is disabled by default for open-source contributors.
- If maintainers sync manually, use team **RECTOR**, priority **medium**, and labels: roadmap, chunk:010, review, planner, quality, difficulty:intermediate.
- Do not paste credentials, API keys, or private board URLs into this issue.
