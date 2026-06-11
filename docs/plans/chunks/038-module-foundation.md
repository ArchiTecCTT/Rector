# Chunk 38 — Module Foundation

**Status:** Complete.

## Goal

Introduce a runtime module registry and hook system with **zero behavior change**. Builtin modules are registered as placeholders; neuro/provider extraction lands in Chunks 39–40.

## Implemented

### `src/modules/`
- `manifest.ts` — `ModuleManifestSchema`, tiers (`core` | `builtin` | `optional`), hook names
- `context.ts` — boot, external-run, run-completed, enrich-context contexts
- `registry.ts` — `ModuleRegistry` with enable/disable and ordered hook invocation
- `builtin/placeholders.ts` — reserved manifests for neuro, cloud memory, E2B, workflows, observability
- `loadBuiltinModules.ts` — `createBuiltinModuleRegistry()`

### Wiring
- [`src/api/server.ts`](src/api/server.ts) — boot registry, `app.locals.moduleRegistry`, pass to `runChat`, `onRunCompleted` hooks
- [`src/orchestration/chatRunner.ts`](src/orchestration/chatRunner.ts) — optional `moduleRegistry` dep, `onExternalRunStart` before preprocessor
- [`src/index.ts`](src/index.ts) — export `modules` namespace

### Tests
- `tests/moduleRegistry.test.ts` — register, enable/disable, local vs external gating, enrichContext merge

## Core vs module boundary

| Core (not disableable) | Modules (builtin/optional) |
|------------------------|----------------------------|
| Run state machine | Preprocessor, ponder, proactive |
| Budget / redaction / approvals | Deep planner, task decomposition |
| Crucible, DAG, executor, healing | Cloud memory / LLM / E2B factories |
| Module registry + ACL | Workflows, telemetry exporters |

## Verification

```
npm test   → 214 files (incl. moduleRegistry)
npm run build → clean
```

## Next

- Chunk 039: wire real handlers for neuro-symbolic modules (high priority first)
- Chunk 040: provider module registry (replace bridge `switch` statements)
- Chunk 041: Module Manager UI (`GET/POST /api/modules`)