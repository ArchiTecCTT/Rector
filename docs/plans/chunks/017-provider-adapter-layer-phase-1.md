# Chunk 17 — Provider Adapter Layer Phase 1

## Goal

Add the first provider adapter seam for Rector LLM calls while preserving the local provider-free default. The layer must be schema-validated, budget-gated, deterministic in tests, and safe to extend with real provider adapters later.

## Scope

- Add `src/providers` with LLM request/response schemas, provider interfaces, capability metadata, structured errors, budget-gated invocation helper, deterministic fake provider, model router, and Together AI request/config adapter.
- Keep local/default routing on the fake provider with zero cost and no network calls.
- Gate provider invocation by `maxModelCalls`, `maxUsd`, and allowed provider constraints before calling the provider.
- Add contract tests for fake provider, local router default, budget denial, Together missing-key validation, and Together request shape without network.
- Update concerns register with Phase 1 provider limitations.

## Non-goals

- No live provider calls in normal tests.
- No Cloudflare/Azure/Perplexity adapters; those are Chunk 18.
- No production token accounting accuracy; Phase 1 uses conservative estimates.
- No chat pipeline rewiring to live providers yet.

## Implementation Plan

1. Write failing provider tests for the required contracts.
2. Implement schemas, interface/types, `ProviderError`, `FakeLLMProvider`, `TogetherAIProvider`, router, and budget-gated invocation helper.
3. Export provider module from `src/providers/index.ts`.
4. Update concerns register with local/fake default and Phase 1 adapter limitations.
5. Run `npm test` and `npm run build`.
