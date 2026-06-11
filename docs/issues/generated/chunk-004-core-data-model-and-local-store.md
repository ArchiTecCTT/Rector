# Chunk 4 — Core Data Model and Local Store

Introduce conversation, message, run, artifact, event, and budget types with an in-memory provider-free store.

## Metadata

- chunk: 004
- labels: roadmap, chunk:004, data-model, local-mode, difficulty:intermediate
- difficulty: intermediate
- good first issue: false
- milestone: v0.1.0-alpha
- project board status: Ready

## Acceptance criteria

- [ ] Core data model types exist for conversations, messages, runs, artifacts, events, and budgets.
- [ ] In-memory local store supports create, read, list, update, and delete behavior needed by later chunks.
- [ ] Store tests prove provider-free operation and deterministic behavior.

## Test commands

- `npm test -- tests/store.test.ts tests/state.test.ts`
- `npm test`
- `npm run build`

## Project board / Linear sync

- Add to the GitHub project board manually in **Ready** for milestone **v0.1.0-alpha**.
- Linear sync is disabled by default for open-source contributors.
- If maintainers sync manually, use team **RECTOR**, priority **medium**, and labels: roadmap, chunk:004, data-model, local-mode, difficulty:intermediate.
- Do not paste credentials, API keys, or private board URLs into this issue.
