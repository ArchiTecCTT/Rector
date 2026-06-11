# Chunk 18 — Provider Adapter Layer Phase 2

## Goal

Extend Rector's optional external LLM provider seam with Cloudflare Workers AI, Azure OpenAI, and Perplexity research adapters while preserving the provider-free local fake default.

## Scope

- Add adapters for Cloudflare Workers AI, Azure OpenAI, and Perplexity.
- Keep all external adapters behind explicit config validation, budget checks, and network-disabled-by-default gates.
- Add request builders and response parsers for each provider.
- Extend route-based model assignment for `cheap`, `fast`, `flagship`, and `research` using the existing model router.
- Add tests that mock fetch and require no real network or API keys.
- Update concerns register with Phase 2 limitations.

## Non-goals

- No live provider calls in normal tests.
- No provider credentials required for contributors.
- No streaming/tool-calling support.
- No production-accurate token/cost accounting.
- No full chat pipeline rewiring to external providers.

## TDD Plan

1. Add failing tests for missing-config errors, request builders, mocked response parsing, route selection, budget denial, and no-network default for Cloudflare, Azure OpenAI, and Perplexity.
2. Implement narrowly inside `src/providers/llm.ts`, reusing Phase 1 contracts.
3. Ensure router defaults remain local fake and only picks configured external providers in external mode.
4. Update `docs/plans/concerns-and-vulnerabilities.md`.
5. Run `npm test` and `npm run build`.
