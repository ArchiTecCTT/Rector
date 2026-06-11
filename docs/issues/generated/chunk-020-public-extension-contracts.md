# Chunk 20 — Public Extension Contracts

Document and test contributor-facing extension contracts for adapters such as LLM, memory, sandbox, telemetry, search, issue tracker, validator, and UI client.

## Metadata

- chunk: 020
- labels: roadmap, chunk:020, extensions, contracts, docs, contributor-experience, good first issue, difficulty:beginner
- difficulty: beginner
- good first issue: true
- milestone: v0.1.0-alpha
- project board status: Ready

## Acceptance criteria

- [ ] Public extension manifest and API version compatibility rules are documented.
- [ ] Adapter contract types cover LLM, memory, sandbox, telemetry, search, issue tracker, validator, and UI client surfaces.
- [ ] Contributor docs include examples that do not require network access or provider credentials.

## Test commands

- `npm test -- tests/extensions.test.ts`
- `npm test`
- `npm run build`

## Project board / Linear sync

- Add to the GitHub project board manually in **Ready** for milestone **v0.1.0-alpha**.
- Linear sync is disabled by default for open-source contributors.
- If maintainers sync manually, use team **RECTOR**, priority **low**, and labels: roadmap, chunk:020, extensions, contracts, docs, contributor-experience, good first issue, difficulty:beginner.
- Do not paste credentials, API keys, or private board URLs into this issue.
