# Chunk 35 — Durable Memory, Boot Migration, and Neuro-Symbolic Integration

**Status:** Complete.

## Goal

Wire boot-time `runStartupMigration`, implement real pluggable cloud memory providers (Mem0, TiDB memory, Chroma), and integrate neuro-symbolic steps 4–7 (symbolic engine, deep planner, ponder swarm, task decomposition) into the external chat pipeline — while preserving the local-mode regression baseline.

## Implemented

### Phase 1: Boot-Time Persistence Migration
- `src/bin/server.ts`: `await runStartupMigration` for `sqlite`/`tidb` drivers before `createApp`; redacted halt on failure
- `src/api/server.ts`: `store?: RectorStore` injection; `isSqlBackedStore` + `delegateStoreForLocalSqliteMem` for memory bridge
- Tests: `tests/startupMigrationBoot.test.ts`, timeout case in `tests/tidbStartupMigration.integration.test.ts`

### Phase 2: Real Memory Adapters
- `src/memory/{budget,adapterBase,mem0Adapter,tidbMemoryAdapter,chromaMemoryAdapter,defaultRun}.ts`
- `src/providers/memoryBridge.ts`: `buildMemoryProviderFromRecord` factory with graceful local fallback
- Lazy optional deps (`mem0ai`, `chromadb`) — build/tests pass without packages installed
- Tests: `tests/memoryBridge.test.ts`, `tests/memoryProviderAdapters.test.ts`

### Phase 3a: Symbolic Engine + Deep Planner (Steps 4–5)
- `src/symbolic/defaultRules.ts` + preprocessor symbolic validation
- `validationHealing.ts` symbolic repair hints
- `deepPlanning?: boolean` in `ChatRunOptions` + chat API body; `runDeepPlanner` branch in external path
- Tests: `tests/symbolicEngine.test.ts`, `tests/preprocessorSymbolic.test.ts`, `tests/deepPlanner.test.ts`

### Phase 3b: Task Decomposition + Ponder (Steps 6–7)
- `decomposeIntoTasks` + `executeDecomposedSubGoals` for `complexity === "high"` (external only)
- `src/orchestration/backgroundHooks.ts`: ponder + subconscious on run complete + idle timer
- Tests: `tests/taskDecomposer.test.ts`, `tests/ponderSwarm.test.ts`, `tests/backgroundHooks.test.ts`

## Verification

```
npm test   → 202 files / 1281 tests passing
npm run build → clean
```

## Commits

- `c212b89` feat(chunk-035): wire boot-time runStartupMigration and store injection
- `c34939f` feat(chunk-035): implement Mem0/TiDB/Chroma memory adapters with budget and bridge factory
- `6da4800` feat(chunk-035): wire symbolic engine validation and opt-in deep planner
- `b4c2181` feat(chunk-035): wire task decomposition and ponder/subconscious background hooks

## Deferred / Follow-on

- `/api/memory-providers` Settings API CRUD routes (034 polish)
- Real Mem0/Chroma integration tests against live services (credits)
- Ponder idle timer tuning; event-driven triggers vs fixed interval
- Property tests for prune survival invariants (existing Medium gap)