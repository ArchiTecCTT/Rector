# Chunk 40 — Provider Module Registry

**Status:** Complete.

## Goal

Replace hardcoded `switch (record.kind)` in LLM and memory bridges with a `KindProviderRegistry` populated by builtin provider modules.

## Implemented

- `src/modules/providerRegistry.ts` — generic kind → factory registry
- `src/modules/builtin/llmProviderModules.ts` — together, cloudflare, azure-openai, openai-compatible
- `src/modules/builtin/memoryProviderModules.ts` — mem0, tidb-memory, chroma
- `configBridge.buildProviderFromRecord` — delegates to LLM registry
- `memoryBridge.buildMemoryProviderFromRecord` — delegates to memory registry (unknown kinds → stub)

## Verification

```
tests/providerModuleRegistry.test.ts
Existing provider/memory API tests unchanged
```