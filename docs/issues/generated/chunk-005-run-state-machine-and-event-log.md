# Chunk 5 — Run State Machine and Event Log

Implement the hidden run lifecycle with append-only events, validated transitions, and resumable NEEDS_DECISION state.

## Metadata

- chunk: 005
- labels: roadmap, chunk:005, state-machine, events, difficulty:intermediate
- difficulty: intermediate
- good first issue: false
- milestone: v0.1.0-alpha
- project board status: Ready

## Acceptance criteria

- [ ] Run lifecycle transitions match the architecture phase model.
- [ ] Every valid transition emits an append-only event and invalid transitions are rejected.
- [ ] NEEDS_DECISION is represented as a first-class resumable state.

## Test commands

- `npm test -- tests/runStateMachine.test.ts`
- `npm test`
- `npm run build`

## Project board / Linear sync

- Add to the GitHub project board manually in **Ready** for milestone **v0.1.0-alpha**.
- Linear sync is disabled by default for open-source contributors.
- If maintainers sync manually, use team **RECTOR**, priority **medium**, and labels: roadmap, chunk:005, state-machine, events, difficulty:intermediate.
- Do not paste credentials, API keys, or private board URLs into this issue.
