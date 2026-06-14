# Chunk 39 — Neuro-Symbolic Builtin Modules

**Status:** Complete.

## Goal

Extract optional neuro-symbolic features (Chunks 26–32) into builtin modules behind the Chunk 038 registry, with feature flags and zero local-baseline regression.

## Modules

| Module | Source | Hooks / entry |
|--------|--------|---------------|
| `@rector/builtin/neuro-preprocess` | `preprocessor.ts` | `executePreprocessorPhase` |
| `@rector/builtin/neuro-planning` | `deepPlanner`, `taskDecomposer` | `preparePlanningPhase`, `executePlanningPhase` |
| `@rector/builtin/neuro-alive` | `proactive/`, `backgroundHooks` | `onBoot`, `onRunCompleted` |

## Feature flags

`src/modules/featureFlags.ts` — `preprocessor`, `deepPlanning`, `decomposition`, `proactive`, `ponder` (defaults preserve 0.1.0 external behavior).

## Wiring changes

- `chatRunner.ts` — delegates preprocessor/planning to builtin module functions when enabled
- `server.ts` — proactive/ponder boot via `neuro-alive` module `onBoot`; dev proactive trigger via `getNeuroAliveState()`
- `bin/server.ts` — shutdown stops ponder idle timer via `neuroAliveState`

## Verification

```
npm test (chatRunner, proactive, backgroundHooks, moduleRegistry) → pass
npm run build → clean
```