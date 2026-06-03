# Chunk 3 — Protocol Foundation

Create canonical protocol contracts for phases, envelopes, events, DAG schemas, retry policies, and validation policies.

## Metadata

- chunk: 003
- labels: roadmap, chunk:003, protocol, schemas, difficulty:intermediate
- difficulty: intermediate
- good first issue: false
- milestone: v0.1.0-alpha
- project board status: Ready

## Acceptance criteria

- [ ] Protocol types cover run phases, event envelopes, DAG nodes, retry policy, and validation policy.
- [ ] Invalid protocol payloads are rejected by schema tests.
- [ ] No provider or UI behavior changes are introduced.

## Test commands

- `npm test -- tests/protocol.test.ts`
- `npm test`
- `npm run build`

## Project board / Linear sync

- Add to the GitHub project board manually in **Ready** for milestone **v0.1.0-alpha**.
- Linear sync is disabled by default for open-source contributors.
- If maintainers sync manually, use team **RECTOR**, priority **medium**, and labels: roadmap, chunk:003, protocol, schemas, difficulty:intermediate.
- Do not paste credentials, API keys, or private board URLs into this issue.
