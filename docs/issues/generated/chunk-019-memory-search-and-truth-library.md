# Chunk 19 — Memory, Search, and Truth Library

Add local memory/search abstractions and Truth Library statuses with provenance, citations, and rejected-item filtering.

## Metadata

- chunk: 019
- labels: roadmap, chunk:019, memory, search, truth-library, difficulty:advanced
- difficulty: advanced
- good first issue: false
- milestone: v0.1.0-alpha
- project board status: Ready

## Acceptance criteria

- [ ] Truth Library supports TRUSTED, UNVERIFIED, and REJECTED statuses with provenance and citations.
- [ ] Local search excludes rejected material by default and returns deterministic results.
- [ ] Chroma and Algolia are represented as optional future integrations, not required local dependencies.

## Test commands

- `npm test -- tests/memoryTruthLibrary.test.ts`
- `npm test`
- `npm run build`

## Project board / Linear sync

- Add to the GitHub project board manually in **Ready** for milestone **v0.1.0-alpha**.
- Linear sync is disabled by default for open-source contributors.
- If maintainers sync manually, use team **RECTOR**, priority **high**, and labels: roadmap, chunk:019, memory, search, truth-library, difficulty:advanced.
- Do not paste credentials, API keys, or private board URLs into this issue.
