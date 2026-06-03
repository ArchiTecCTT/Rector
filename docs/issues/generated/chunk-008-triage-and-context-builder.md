# Chunk 8 — Triage and Context Builder

Implement deterministic triage routes and context-pack generation with artifact handles for large material.

## Metadata

- chunk: 008
- labels: roadmap, chunk:008, triage, context, difficulty:intermediate
- difficulty: intermediate
- good first issue: false
- milestone: v0.1.0-alpha
- project board status: Ready

## Acceptance criteria

- [ ] Incoming chat work is routed by deterministic triage rules.
- [ ] Context packs include relevant artifacts, assumptions, and limits without dumping oversized content.
- [ ] Large docs, logs, or repo data are referenced by artifact handles.

## Test commands

- `npm test -- tests/triageContext.test.ts`
- `npm test`
- `npm run build`

## Project board / Linear sync

- Add to the GitHub project board manually in **Ready** for milestone **v0.1.0-alpha**.
- Linear sync is disabled by default for open-source contributors.
- If maintainers sync manually, use team **RECTOR**, priority **medium**, and labels: roadmap, chunk:008, triage, context, difficulty:intermediate.
- Do not paste credentials, API keys, or private board URLs into this issue.
