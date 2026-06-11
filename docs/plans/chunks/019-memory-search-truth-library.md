# Chunk 19 — Memory, Search, and Truth Library

## Goal

Add a provider-free local truth library and memory/search seam so Rector can retrieve trusted local knowledge without requiring external vector/search services.

## Scope

- Define truth status, provenance, and citation schemas.
- Add an in-memory truth library with deterministic keyword scoring.
- Support upsert, lookup, search, and filtering by status, provenance, and tags.
- Exclude rejected truth items from default retrieval.
- Add semantic memory/search adapter interfaces and no-op Chroma/Algolia stubs with no network calls.
- Lightly integrate optional local truth library retrieval into the context builder while preserving empty defaults.
- Update tests and concerns register.

## Non-goals

- No Chroma, Algolia, or other network calls.
- No embeddings, external indexing, or durable persistence.
- No provider-backed semantic ranking.
- No broad chat pipeline rewiring.

## TDD Plan

1. Add tests for truth status/provenance/citation validation.
2. Add tests for in-memory upsert, filtering, deterministic keyword scoring, and rejected-by-default behavior.
3. Add tests proving Chroma/Algolia adapters are no-op and do not call fetch/network.
4. Add context builder tests proving default memory/doc arrays remain empty and provided local memory can populate relevantMemory/relevantDocs.
5. Implement the smallest local module and optional context builder hook needed to pass tests.
6. Update concerns register.
7. Run `npm test` and `npm run build`.
