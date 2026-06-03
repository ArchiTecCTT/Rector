# Chunk 17 — Provider Adapter Layer Phase 1

Add the LLM provider interface, model router, capability metadata, fake provider contract tests, and opt-in Together AI adapter.

## Metadata

- chunk: 017
- labels: roadmap, chunk:017, providers, llm, budget, difficulty:advanced
- difficulty: advanced
- good first issue: false
- milestone: v0.1.0-alpha
- project board status: Ready

## Acceptance criteria

- [ ] Provider interface and capability metadata support fake/local and opt-in provider adapters.
- [ ] Router chooses providers by task needs while preserving provider-free defaults.
- [ ] Together AI adapter remains disabled unless explicit env and budget gates allow it.

## Test commands

- `npm test -- tests/llmProviders.test.ts tests/providers.test.ts`
- `npm test`
- `npm run build`

## Project board / Linear sync

- Add to the GitHub project board manually in **Ready** for milestone **v0.1.0-alpha**.
- Linear sync is disabled by default for open-source contributors.
- If maintainers sync manually, use team **RECTOR**, priority **high**, and labels: roadmap, chunk:017, providers, llm, budget, difficulty:advanced.
- Do not paste credentials, API keys, or private board URLs into this issue.
