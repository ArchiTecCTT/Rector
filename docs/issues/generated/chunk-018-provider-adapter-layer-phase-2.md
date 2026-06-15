# Chunk 18 — Provider Adapter Layer Phase 2

Add Cloudflare Workers AI, Azure OpenAI, and Perplexity research adapters with route-based selection and opt-in network behavior.

## Metadata

- chunk: 018
- labels: roadmap, chunk:018, providers, llm, research, difficulty:advanced
- difficulty: advanced
- good first issue: false
- milestone: v0.1.0-alpha
- project board status: Ready

## Acceptance criteria

- [ ] Cloudflare Workers AI, Azure OpenAI, and Perplexity adapters validate config and build provider requests.
- [ ] Route-based model assignment covers cheap, fast, flagship, and research calls.
- [ ] All live-provider behavior remains disabled by default and protected by env and budget gates.

## Test commands

- `npm test -- tests/providers.test.ts`
- `npm test`
- `npm run build`

## Project board / Linear sync

- Add to the GitHub project board manually in **Ready** for milestone **v0.1.0-alpha**.
- Linear sync is disabled by default for open-source contributors.
- If maintainers sync manually, use team **RECTOR**, priority **high**, and labels: roadmap, chunk:018, providers, llm, research, difficulty:advanced.
- Do not paste credentials, API keys, or private board URLs into this issue.
