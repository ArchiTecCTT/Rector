# Implementation Plan: BYOK Alpha Phase 3 (ORN-39 → ORN-42)

## Overview

This plan implements Phase 3 in the required dependency order — **persistence (ORN-39) → streaming
(ORN-40) → cost (ORN-41) → handoff guide (ORN-42)** — extending the existing primitives rather than
replacing them. Each task builds on the previous one and ends wired into the running system. The
language is **TypeScript** (the existing codebase and design).

Hard constraints enforced throughout every task: the symbolic control plane stays in charge, the
in-memory provider-free mode stays the default and the `npm test` baseline, no secret reaches any
persisted row/event/SSE frame/cost aggregate/UI payload, and `npm test` passes with no API key and
no real network (mocked providers, local/injected `SqlDriver`).

## Tasks

- [x] 1. Extract the store interface and add persistence configuration (ORN-39 foundation)
  - [x] 1.1 Extract the `RectorStore` interface and keep `InMemoryRectorStore` as the default
    - In `src/store/index.ts`, declare `RectorStore` byte-for-byte from the existing public async
      method signatures of `InMemoryRectorStore` (conversations, messages, runs,
      `commitRunTransition`, events, artifacts)
    - Mark `InMemoryRectorStore implements RectorStore` with no signature change; export the interface
    - _Requirements: 1.1, 1.2_

  - [x] 1.2 Add the persistence configuration block to `DeploymentConfig`
    - In `src/deployment/index.ts`, add `PersistenceDriverSchema = z.enum(["memory","sqlite","tidb"])`
      and a `persistence` block: `driver` (default `memory`), optional `sqlitePath`, optional `tidb`
      connection block; leave `mongoUri`/`mongoDb`/`redisUrl` present but unused
    - _Requirements: 1.6, 1.7, 1.11, 1.12, 1.14_

- [x] 2. Implement `SqlRectorStore` over an injectable `SqlDriver` with a SQLite default (ORN-39)
  - [x] 2.1 Define the `SqlDriver` contract and the local SQLite driver
    - In `src/store/sqlRectorStore.ts`, define `SqlDriver` (`dialect`/`exec`/`run`/`get`/`all`/`close`)
      and `createSqliteDriver({ path })` backed by a file or `:memory:` SQLite database (no cloud
      account, no network)
    - _Requirements: 1.6_

  - [x] 2.2 Implement `SqlRectorStore` with schema-validated round-trip and store semantics
    - In `src/store/sqlRectorStore.ts`, implement the full `RectorStore` over `options.driver`:
      idempotent `CREATE TABLE IF NOT EXISTS` DDL, one table per entity with a `seq` insertion-order
      column and a JSON `payload`; validate every write with its `Entity_Schema` before insert and
      re-parse every read; preserve insertion-order list semantics, duplicate-event-id rejection in
      `appendEvent`/`commitRunTransition`, atomic-and-rollback `commitRunTransition`, and a
      redaction-applied parse error on a corrupt payload
    - _Requirements: 1.3, 1.4, 1.5, 1.9, 1.10, 1.13_

  - [x] 2.3 Write property test for persisted-then-reloaded round-trip
    - **Property 2: Persisted-then-reloaded store returns identical entities (restart survival)**
    - **Validates: Requirements 1.3, 1.4**
    - In `tests/persistentStore.test.ts`, generate operation sequences against a `:memory:`/temp-file
      or injected driver, re-instantiate the store against the same driver, assert all reads deep-equal
      and list order preserved

  - [x] 2.4 Write property test for in-memory store parity (regression baseline)
    - **Property 1: In-memory store behavior and existing tests are unchanged**
    - **Validates: Requirements 1.1, 1.2**
    - In `tests/persistentStore.inmemory.test.ts`, reuse the same create/update/list/delete generator
      and assert `InMemoryRectorStore` still satisfies its current invariants and signatures

  - [x] 2.5 Write unit tests for store semantics
    - In `tests/persistentStore.semantics.test.ts`, cover duplicate-event-id rejection, atomic
      rollback on a failed `commitRunTransition`, and the redaction-applied parse error on read
    - _Requirements: 1.9, 1.10, 1.13_

- [x] 3. Add the TiDB driver and the `createRectorStore` factory (ORN-39)
  - [x] 3.1 Implement the optional TiDB Cloud driver
    - In `src/store/tidbRectorStore.ts`, implement `createTiDBDriver({ host, port, user, password,
      database, tls? })` as a MySQL-wire `SqlDriver`; never auto-constructed for local use
    - _Requirements: 1.7_

  - [x] 3.2 Implement the `createRectorStore` selection factory
    - In `src/store/index.ts`, implement `createRectorStore(config, overrides)`: return
      `InMemoryRectorStore` when driver is `memory`/absent, `SqlRectorStore` + SQLite for `sqlite`,
      `SqlRectorStore` + TiDB for `tidb`; an injected `overrides.driver` always wins; raise a config
      error for an unknown driver or a `tidb` driver with a missing/incomplete connection block
      before any I/O; ignore `mongoUri`/`mongoDb`/`redisUrl` and add no Mongo dependency
    - _Requirements: 1.1, 1.6, 1.7, 1.8, 1.11, 1.12, 1.14_

  - [x]* 3.3 Write unit tests for factory selection and configuration errors
    - In `tests/storeFactory.test.ts`, cover memory default, sqlite/tidb selection, injected-driver
      override precedence, unknown-driver error, incomplete-tidb error (no network), Mongo fields ignored
    - _Requirements: 1.8, 1.11, 1.12, 1.14_

- [x] 4. Checkpoint - persistence layer
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Wire persistence into application bootstrap (ORN-39)
  - [x] 5.1 Select the store via `createRectorStore` at startup and document env
    - In `src/api/server.ts`, construct the store from the deployment persistence config (default
      in-memory provider-free path unchanged); add the persistence env documentation in
      `src/setupChecklist.ts`; keep `InMemoryRectorStore` the default and regression baseline
    - _Requirements: 5.1, 5.2, 5.4_

- [x] 6. Build the run event broker and broadcast decorator (ORN-40)
  - [x] 6.1 Implement `createRunEventBroker`
    - In `src/api/server.ts`, implement the in-process `RunEventBroker` (`publish`/`subscribe`
      returning an unsubscribe), keyed by `runId`
    - _Requirements: 2.6_

  - [x] 6.2 Implement the `withEventBroadcast` store decorator
    - In `src/api/server.ts`, implement `withEventBroadcast(store, broker)` that publishes each
      appended/committed event to the broker **only after** it is persisted and redacted by the
      underlying store, wrapping any `RectorStore` without changing its interface
    - _Requirements: 2.6_

  - [x]* 6.3 Write unit tests for broker and decorator
    - In `tests/chatStreaming.broker.test.ts`, assert publish-after-persist ordering, subscriber
      delivery keyed by `runId`, and unsubscribe removes the listener
    - _Requirements: 2.6_

- [x] 7. Implement the SSE stream route and the streaming chat branch (ORN-40)
  - [x] 7.1 Define the SSE frame schemas
    - In `src/api/server.ts`, add `SseFrameSchema` (discriminated union of `run-event`, `cost`,
      `done`, `error`) carrying only persisted, redaction-applied data; `error.message` passes
      through `redactString`
    - _Requirements: 2.5_

  - [x] 7.2 Implement `registerRunStreamRoute` (`GET /api/runs/:id/stream`)
    - In `src/api/server.ts`, set SSE headers, subscribe, replay `listEvents(runId)` exactly once in
      ascending order as catch-up, then stream live frames with no duplicate/omission across the
      boundary; emit exactly one `done` frame on a Terminal_Phase then teardown; send a 15s heartbeat
      with no run data; handle a non-existent `runId` (no replay, no fabricated payload)
    - _Requirements: 2.2, 2.3, 2.4, 2.5, 2.9, 2.10_

  - [x] 7.3 Add the streaming chat branch and preserve the synchronous fallback
    - In `src/api/server.ts`, on `?stream=1` create the run and return `{ runId, traceId }` with `202`
      before any Terminal_Phase, run `runChat` in the background publishing events; on run-creation
      failure return a redacted error, start no background run, and open no stream; keep the
      synchronous POST and the `GET /api/runs/:id/events` Polling_Endpoint unchanged
    - _Requirements: 2.1, 2.7, 2.11_

  - [x] 7.4 Write property test for clean SSE teardown
    - **Property 4: The SSE stream always terminates (closes cleanly) on completion or error**
    - **Validates: Requirements 2.3, 2.4**
    - In `tests/chatStreaming.teardown.test.ts`, with a mock `res`/clock drive runs to each terminal
      phase, to an error, and to a client disconnect; assert one terminal frame, one `res.end()`, zero
      remaining subscribers, and a cleared heartbeat timer

  - [x] 7.5 Write property test for no secret in SSE frames
    - **Property 3 (streaming boundary): No secret appears in any SSE frame**
    - **Validates: Requirements 2.5**
    - In `tests/chatStreaming.redaction.test.ts`, inject a key-like string, drive a mocked external
      run against a persistent store, assert the substring is absent from every replayed/live frame

  - [x] 7.6 Write unit tests for stream edge cases
    - In `tests/chatStreaming.edge.test.ts`, cover the non-existent `runId` stream (no events, no
      fabricated payload) and the streamed run-creation failure (redacted error, no stream opened)
    - _Requirements: 2.9, 2.11_

- [x] 8. Wire the live SSE client into the trace UI with polling fallback (ORN-40)
  - [x] 8.1 Add the `EventSource` consumer and polling fallback
    - In `src/public/app.js`, open an `EventSource`, apply `run-event` frames to the live timeline,
      close on `done`/`error`; if `EventSource` is unavailable or the stream errors, fall back to the
      Polling_Endpoint every 2s until a Terminal_Phase; add the live indicator in
      `src/public/index.html` and `src/public/styles.css`
    - _Requirements: 2.8_

- [x] 9. Checkpoint - streaming trace
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Implement cost/token aggregation and per-run budget enforcement (ORN-41)
  - [x] 10.1 Implement aggregate schemas and the pure aggregation folds
    - In `src/observability/index.ts`, add `RunCostAggregateSchema`/`ConversationCostAggregateSchema`
      and the pure `aggregateRunCost(runId, events)` and `aggregateConversationCost(conversationId,
      runs, eventsByRun)` folds over the `ProviderCallMetadata`/`LLMUsage` already on persisted events;
      `totalTokens = inputTokens + outputTokens`; distinct non-secret provider/model ids only; treat
      absent/partial usage as zero without raising
    - _Requirements: 3.1, 3.2, 3.3, 3.5, 3.8_

  - [x] 10.2 Implement `enforceMaxPerRunBudget` over `evaluateBudget`
    - In `src/security/budget.ts`, add `enforceMaxPerRunBudget(run, accumulated, nextEstimate)` that
      layers on `evaluateBudget`: deny when accumulated `estimatedUsd` + next `estimatedUsd` strictly
      exceeds `budget.maxUsd` or accumulated + next `modelCalls` strictly exceeds `budget.maxModelCalls`;
      otherwise allow
    - _Requirements: 3.4, 3.9_

  - [x]* 10.3 Write property test for cost aggregation correctness
    - **Property 5: Aggregated per-run/per-conversation cost equals the sum of per-call usage**
    - **Validates: Requirements 3.2, 3.3**
    - In `tests/costTracking.test.ts`, generate `LLMUsage` lists, synthesize run events, assert run and
      conversation aggregates equal the independently computed sums

  - [x]* 10.4 Write property test for max-per-run budget enforcement
    - **Property 6: A run exceeding its max per-run budget is denied before the next provider call**
    - **Validates: Requirements 3.4**
    - In `tests/costTracking.budget.test.ts`, generate budgets/accumulated costs/next estimates; assert
      a non-`allowed` decision exactly when the sum would breach the ceiling and a spy provider's
      `invoke` is called zero times on denial

  - [x]* 10.5 Write unit tests for aggregation edge cases and the allowed boundary
    - In `tests/costTracking.edge.test.ts`, cover events with missing/partial usage (zeroed, schema
      valid) and the `allowed` boundary (`<=` ceilings)
    - _Requirements: 3.8, 3.9_

- [x] 11. Expose cost endpoints, live cost frames, and runner enforcement (ORN-41)
  - [x] 11.1 Add the cost endpoints
    - In `src/api/server.ts`, add `GET /api/runs/:id/cost` and `GET /api/chat/conversations/:id/cost`
      returning the derived aggregate; for an unknown id return a schema-valid all-zero aggregate with
      empty provider/model lists
    - _Requirements: 3.6, 3.10_

  - [x] 11.2 Emit live `cost` SSE frames
    - In `src/api/server.ts`, after each published provider-call event emit a `cost` frame carrying the
      current `RunCostAggregate` so the UI shows a live running total
    - _Requirements: 3.7_

  - [x] 11.3 Wire `enforceMaxPerRunBudget` into the chat runner preflight
    - In `src/orchestration/chatRunner.ts`, gate each live provider call through
      `enforceMaxPerRunBudget` so a run that would breach its ceiling is denied before any network I/O,
      with the symbolic control plane retaining control-flow authority
    - _Requirements: 3.4, 5.1_

  - [x]* 11.4 Write unit tests for the cost endpoints
    - In `tests/costTracking.endpoints.test.ts`, cover the run/conversation cost responses and the
      empty-aggregate response for an unknown id
    - _Requirements: 3.6, 3.10_

- [x] 12. Wire the cost panel into the trace UI (ORN-41)
  - [x] 12.1 Render the live cost/token panel
    - In `src/public/app.js`, apply `cost` SSE frames to a cost/token panel; add the panel markup in
      `src/public/index.html` and `src/public/styles.css`
    - _Requirements: 3.7_

- [x] 13. Cross-cutting redaction and test-isolation guards
  - [x]* 13.1 Write the end-to-end redaction property test
    - **Property 3: No secret appears in any persisted row, event, artifact, SSE frame, or cost aggregate**
    - **Validates: Requirements 1.5, 2.5, 3.5**
    - In `tests/redaction.test.ts`, inject a key-like string, drive the full external path with a mocked
      provider against a persistent store, assert the substring is absent from every stored payload,
      replayed/live frame, cost aggregate, and the connection-test response

  - [x]* 13.2 Write the network/credential isolation guard test
    - In `tests/testIsolation.test.ts`, assert the suite runs with no API key and no outbound network
      (mocked providers, local/injected `SqlDriver`) and fails loudly if an outbound connection or a
      real key is required
    - _Requirements: 5.3, 5.5_

  - [x]* 13.3 Write the in-memory baseline regression test
    - In `tests/inMemoryRegression.test.ts`, assert the in-memory default path produces conversations,
      messages, runs, events, and artifacts byte-for-byte identical to the pre-Phase-3 baseline
    - _Requirements: 5.2, 5.4_

- [x] 14. Checkpoint - cost dashboard and constraints
  - Ensure all tests pass, ask the user if questions arise.

- [x] 15. Write the Kiro implementor handoff guide (ORN-42)
  - [x] 15.1 Author `docs/implementation/byok-alpha-handoff.md`
    - Create the single Markdown guide: name and locate the source-of-truth docs (Phase 1/2/3 specs,
      architecture doc, generated Linear issue chunks) with no stale references; explain the
      local vs external mode split and that local provider-free mode is the regression baseline; state
      the ORN-31 → ORN-42 order with rationale; list verbatim the verification
      commands (`npm test`, `npm run build`, `npm run check`,
      `node scripts/generate-roadmap-issues.js --check`,
      `node scripts/export-linear-issues.js --check`); state the explicit non-goals (no more fake
      systems, no cloud-first rewrite, no Mongo dependency unless access exists)
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

- [x] 16. Final checkpoint - full Phase 3
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core
  implementation tasks are never optional.
- Each task references the specific requirement acceptance-criteria numbers it satisfies.
- Property-based tests use **fast-check** (already a dev dependency) for the six correctness
  properties: round-trip identity (P2), in-memory parity (P1), redaction safety (P3), clean SSE
  teardown (P4), aggregation correctness (P5), and budget enforcement (P6).
- The ORN-39 → ORN-40 → ORN-41 → ORN-42 order is preserved: persistence first, then streaming, then
  cost, then the handoff guide.
- All work keeps the symbolic control plane in charge and the in-memory provider-free path the default
  and `npm test` baseline, with no secret reaching any persisted/streamed/aggregated surface and no API
  key or real network in tests.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["2.1", "3.1"] },
    { "id": 2, "tasks": ["2.2"] },
    { "id": 3, "tasks": ["5.1", "3.2", "2.3"] },
    { "id": 4, "tasks": ["6.1", "2.4", "3.3", "10.1", "10.2"] },
    { "id": 5, "tasks": ["6.2", "2.5", "10.3"] },
    { "id": 6, "tasks": ["7.1", "6.3", "10.4", "11.3"] },
    { "id": 7, "tasks": ["7.2", "10.5"] },
    { "id": 8, "tasks": ["7.3"] },
    { "id": 9, "tasks": ["11.1"] },
    { "id": 10, "tasks": ["11.2", "8.1"] },
    { "id": 11, "tasks": ["7.4", "7.5", "7.6", "11.4", "12.1"] },
    { "id": 12, "tasks": ["13.1", "13.2", "13.3", "15.1"] }
  ]
}
```
