# Requirements Document

## Introduction

BYOK Alpha Phase 3 (ORN-39 → ORN-42) turns Rector's BYOK-capable chat pipeline into a usable
product surface by closing four gaps that remain after Phases 1 and 2: runs do not survive a
restart, the trace UI only renders after a run completes, recorded cost and token usage is never
surfaced live, and there is no single document that lets an implementing agent pick up the work.

Phase 3 delivers (1) **local persistence with a SQLite default and an optional TiDB Cloud path**
(ORN-39) by extracting a `RectorStore` interface from the existing in-memory store and adding a
`SqlRectorStore` over an injectable `SqlDriver`; (2) an **SSE streaming trace UI** (ORN-40) built on
a `RunEventBroker` with the existing polling endpoint preserved as a fallback; (3) a **cost and
token dashboard** (ORN-41) that aggregates the `ProviderCallMetadata`/`LLMUsage` already recorded on
run events into per-run and per-conversation totals and makes the per-run budget ceiling explicit;
and (4) a **Kiro implementor handoff guide** (ORN-42).

These requirements are derived from the approved design document and preserve its hard constraints:
the symbolic control plane stays in charge, local provider-free mode with the in-memory store
remains the default and the regression baseline, no secret ever reaches a persisted row, event,
artifact, SSE frame, cost aggregate, or UI payload, and `npm test` requires no API key and no real
network.

## Glossary

- **Rector**: The BYOK chat orchestration system whose Phase 3 surface these requirements describe.
- **RectorStore**: The store interface extracted byte-for-byte from the existing public async method
  surface of `InMemoryRectorStore`; all store implementations satisfy this interface.
- **InMemoryRectorStore**: The existing in-process store implementation; the default store and the
  test baseline, implementing `RectorStore` without any signature change.
- **SqlRectorStore**: A `RectorStore` implementation that persists entities over an injectable
  `SqlDriver`.
- **SqlDriver**: The minimal synchronous SQL surface (`exec`/`run`/`get`/`all`/`close`) that
  `SqlRectorStore` depends on; implemented by the SQLite driver, the TiDB driver, and an in-memory
  test double.
- **SqliteDriver**: The local persistence `SqlDriver` implementation backed by a file or `:memory:`
  SQLite database; requires no cloud account and no network.
- **TiDBDriver**: The optional hosted `SqlDriver` implementation that connects to TiDB Cloud over the
  MySQL wire protocol; never auto-selected for local use.
- **Store_Factory**: The `createRectorStore(config, overrides)` function that resolves which
  `RectorStore` implementation to construct from the deployment persistence configuration.
- **DeploymentConfig**: The parsed deployment configuration, including the `persistence` block whose
  `driver` field is one of `memory`, `sqlite`, or `tidb`.
- **Entity_Schema**: The existing Zod schemas (`ConversationSchema`, `MessageSchema`, `RunSchema`,
  `RunEventSchema`, `ArtifactSchema`) used to validate every write and re-parse every read.
- **RunEvent**: A persisted, redaction-applied event recorded by `runEvent`/`transitionRun` before
  `appendEvent`.
- **RunEventBroker**: The in-process publish/subscribe component, keyed by `runId`, that distributes
  persisted (already-redacted) run events to SSE subscribers.
- **Event_Broadcast_Decorator**: The `withEventBroadcast(store, broker)` wrapper that publishes every
  appended or committed event to the `RunEventBroker` after it is persisted.
- **Run_Stream_Endpoint**: The `GET /api/runs/:id/stream` SSE route registered by
  `registerRunStreamRoute`.
- **Polling_Endpoint**: The existing `GET /api/runs/:id/events` route, preserved unchanged as the
  streaming fallback.
- **SSE_Frame**: A Server-Sent Events frame of type `run-event`, `cost`, `done`, or `error`, derived
  from persisted, redacted data.
- **Terminal_Phase**: A run phase in the set `{ DONE, FAILED, ABORTED, NEEDS_DECISION }`.
- **Trace_UI**: The browser client (`src/public/app.js`, `index.html`, `styles.css`) that consumes
  the SSE stream and renders the live timeline and cost panel.
- **Cost_Aggregator**: The pure functions `aggregateRunCost` and `aggregateConversationCost` that
  fold `ProviderCallMetadata`/`LLMUsage` into typed cost aggregates.
- **RunCostAggregate**: The typed per-run cost/token total (numbers and non-secret provider/model ids
  only).
- **ConversationCostAggregate**: The typed per-conversation cost/token total, summed from its runs'
  aggregates.
- **LLMUsage**: The existing per-call usage record carrying `inputTokens`, `outputTokens`,
  `estimatedUsd`, and `modelCalls`.
- **ProviderCallMetadata**: The existing per-call metadata recorded on a run event, carrying
  `LLMUsage` and non-secret provider/model identifiers.
- **Budget_Gate**: The `enforceMaxPerRunBudget` function, layered on the existing `evaluateBudget`,
  that decides whether the next provider call is allowed.
- **Cost_Endpoint**: The `GET /api/runs/:id/cost` and `GET /api/chat/conversations/:id/cost` routes.
- **Redaction**: The existing `redactSecrets`/`redactString` mechanism applied at every persistence,
  streaming, and surface boundary.
- **Handoff_Guide**: The single Markdown document `docs/implementation/byok-alpha-handoff.md`
  delivered by ORN-42.
- **Provider_Free_Mode**: The local, credential-free default mode (`ORCHESTRATOR_MODE=local`) that is
  the regression baseline and exercised by `npm test` with no API key and no network.

## Requirements

### Requirement 1: Local persistence with SQLite default and optional TiDB path (ORN-39)

**User Story:** As a Rector operator, I want runs, conversations, messages, events, and artifacts to
persist locally and survive a restart, so that the alpha is usable as a real product without losing
state.

#### Acceptance Criteria

1. WHERE no persistence driver is configured, THE Store_Factory SHALL return an InMemoryRectorStore as the default store.
2. THE InMemoryRectorStore SHALL implement the RectorStore interface with its existing public method signatures unchanged, so that the existing in-memory store tests pass without modification.
3. WHEN a sequence of one or more writes covering at least one conversation, message, run, event, and artifact is committed through a SqlRectorStore and the store is re-instantiated against the same SqlDriver, THE SqlRectorStore SHALL return each previously written conversation, message, run, event, and artifact such that every returned entity is deep-equal (every field, recursively) to the entity originally written, with ids and counters reconstructed solely from the persisted data.
4. WHEN a persisted entity is read, THE SqlRectorStore SHALL re-parse the stored payload through its Entity_Schema so that the read entity is deep-equal (every field, recursively) to the entity originally written, and so that list results preserve the original insertion order.
5. WHEN an entity is persisted to a row, THE SqlRectorStore SHALL store only Redaction-applied, Entity_Schema-validated data so that no secret value appears in any persisted row, event, or artifact.
6. WHEN the persistence driver is `sqlite`, THE Store_Factory SHALL construct a SqlRectorStore over a SqliteDriver using only a local file path, without a cloud account and without a network connection.
7. WHERE the persistence driver is `tidb`, THE Store_Factory SHALL construct a SqlRectorStore over a TiDBDriver using the supplied TiDB connection block.
8. WHEN an injected SqlDriver override is provided, THE Store_Factory SHALL construct a SqlRectorStore over the injected driver regardless of the configured driver value.
9. WHEN a duplicate event id is supplied to `appendEvent` or `commitRunTransition`, THE SqlRectorStore SHALL reject the insert with a duplicate-event-id error, matching InMemoryRectorStore semantics.
10. WHEN a run transition is committed through `commitRunTransition`, THE SqlRectorStore SHALL apply the run update and the event append atomically so that no partial transition is observable, and IF either the run update or the event append fails, THEN THE SqlRectorStore SHALL roll back both so that the prior run state and event log remain unchanged.
11. IF the configured persistence driver is outside the set `{ memory, sqlite, tidb }`, THEN THE Store_Factory SHALL raise a configuration error before constructing any store or performing any I/O.
12. IF the persistence driver is `tidb` and the TiDB connection block is missing or incomplete, THEN THE Store_Factory SHALL fail with a configuration error before constructing the TiDBDriver and SHALL NOT attempt a network connection.
13. IF a persisted payload fails its Entity_Schema on read, THEN THE SqlRectorStore SHALL raise a Redaction-applied parse error identifying the entity and id rather than returning a malformed entity.
14. THE Store_Factory SHALL ignore the `mongoUri`, `mongoDb`, and `redisUrl` configuration fields for store selection and SHALL add no Mongo client dependency.

### Requirement 2: SSE streaming trace UI with polling fallback (ORN-40)

**User Story:** As a Rector user, I want the trace UI to update live as a run progresses, so that I
can watch planner, skeptic, executor, and validation steps stream in instead of waiting for the run
to complete.

#### Acceptance Criteria

1. WHEN a chat message request includes the `stream` flag, THE Rector chat endpoint SHALL create the run, return its `runId` and `traceId` with status `202` before the run reaches a Terminal_Phase and without waiting on run completion, and execute the run in the background.
2. WHEN a client opens the Run_Stream_Endpoint for a run, THE Run_Stream_Endpoint SHALL set SSE headers, replay each of the run's already-persisted events exactly once as `run-event` frames in ascending insertion order, and then stream live frames as new events are published, with no event duplicated or omitted across the replay-to-live boundary.
3. WHEN a run reaches a Terminal_Phase, THE Run_Stream_Endpoint SHALL emit exactly one `done` terminal frame carrying that phase, unsubscribe from the RunEventBroker, clear the heartbeat timer, and call `res.end()` exactly once.
4. IF a run errors mid-stream or the client disconnects before a Terminal_Phase, THEN THE Run_Stream_Endpoint SHALL perform a single clean teardown that unsubscribes from the RunEventBroker, clears the heartbeat timer, and ends the response, leaving no listener or timer registered.
5. WHEN any SSE_Frame is written, THE Run_Stream_Endpoint SHALL serialize only persisted, Redaction-applied data so that no secret value appears in any SSE frame, and SHALL pass any `error` frame message through Redaction.
6. THE Event_Broadcast_Decorator SHALL publish an event to the RunEventBroker only after that event has been persisted and redacted by the underlying store.
7. THE Rector chat endpoint SHALL keep the synchronous POST path and the Polling_Endpoint unchanged so that they remain available as the streaming fallback.
8. IF the browser `EventSource` global is unavailable OR the SSE stream emits an error event, THEN THE Trace_UI SHALL fall back to rendering run events through the Polling_Endpoint, polling every 2 seconds until the run reaches a Terminal_Phase.
9. WHEN the Run_Stream_Endpoint is opened for a `runId` that has no persisted run or events, THE Run_Stream_Endpoint SHALL replay no events, subscribe for live events, and emit no fabricated or secret-bearing payload.
10. WHILE a stream is open and the run has not reached a Terminal_Phase, THE Run_Stream_Endpoint SHALL send a heartbeat keep-alive frame carrying no run data and no secret value every 15 seconds, and SHALL stop sending heartbeats after teardown.
11. IF run creation fails for a streamed chat request, THEN THE Rector chat endpoint SHALL return a Redaction-applied error, SHALL NOT start background execution, and SHALL NOT open an SSE stream.

### Requirement 3: Cost and token dashboard with per-run budget enforcement (ORN-41)

**User Story:** As a Rector operator, I want to see estimated token and cost totals per run and per
conversation and have a per-run budget ceiling enforced, so that I can monitor and cap BYOK spend.

#### Acceptance Criteria

1. THE Cost_Aggregator SHALL derive cost and token totals from the ProviderCallMetadata and LLMUsage already recorded on persisted run events, without adding any new per-call recording mechanism.
2. WHEN `aggregateRunCost` is computed for a run, THE Cost_Aggregator SHALL set `inputTokens`, `outputTokens`, `estimatedUsd`, and `modelCalls` each equal to the sum of the corresponding LLMUsage field across the run's provider-call events, SHALL set `totalTokens` equal to `inputTokens` plus `outputTokens`, and SHALL set `providers` and `models` each to the de-duplicated set of non-secret provider and model identifiers from those events.
3. WHEN `aggregateConversationCost` is computed for a conversation, THE Cost_Aggregator SHALL set `inputTokens`, `outputTokens`, `totalTokens`, `estimatedUsd`, and `modelCalls` each equal to the sum of the corresponding per-run RunCostAggregate field across the conversation's runs, and SHALL set the conversation aggregate's per-run list to the runs' RunCostAggregates in the runs' insertion order.
4. IF the accumulated run `estimatedUsd` plus the next call's estimated `estimatedUsd` would be strictly greater than `budget.maxUsd`, OR the accumulated `modelCalls` plus the next call's `modelCalls` would be strictly greater than `budget.maxModelCalls`, THEN THE Budget_Gate SHALL return a non-`allowed` decision identifying the exceeded ceiling and the next provider call SHALL be denied before any network I/O.
5. WHEN a cost aggregate or `cost` SSE_Frame is produced, THE Cost_Aggregator SHALL include only numeric totals and distinct non-secret provider and model identifiers so that no secret value, key, header, or raw model output appears in any cost aggregate.
6. WHEN the Cost_Endpoint is requested for a run or conversation, THE Rector chat endpoint SHALL return the corresponding RunCostAggregate or ConversationCostAggregate derived from the persisted events.
7. WHEN a provider-call event is published during a streamed run, THE Run_Stream_Endpoint SHALL emit a `cost` SSE_Frame carrying the current RunCostAggregate so that the Trace_UI shows a live running total.
8. IF a run event carries no ProviderCallMetadata or has partially absent LLMUsage fields, THEN THE Cost_Aggregator SHALL treat the absent contributions as zero and return a schema-valid aggregate without raising an error.
9. WHEN the accumulated run `estimatedUsd` plus the next call's estimated `estimatedUsd` is less than or equal to `budget.maxUsd` AND the accumulated `modelCalls` plus the next call's `modelCalls` is less than or equal to `budget.maxModelCalls`, THE Budget_Gate SHALL return an `allowed` decision permitting the next provider call.
10. IF the Cost_Endpoint is requested for a run or conversation id that has no persisted run or events, THEN THE Rector chat endpoint SHALL return a schema-valid aggregate with all numeric totals equal to zero and empty provider and model lists, without raising an error.

### Requirement 4: Kiro implementor handoff guide (ORN-42)

**User Story:** As an implementing agent, I want a single source-of-truth handoff document, so that I
can pick up the BYOK alpha work without re-deriving context.

#### Acceptance Criteria

1. THE Handoff_Guide SHALL identify each of its source-of-truth documents by name and location — the Phase 1, Phase 2, and Phase 3 BYOK alpha specs, the architecture document, and the generated Linear issue chunks — and SHALL NOT reference any deleted or stale document.
2. THE Handoff_Guide SHALL explain the split between local mode (`ORCHESTRATOR_MODE=local`) and external BYOK mode (`ORCHESTRATOR_MODE=external`), including how the chat runner dispatches by mode, and SHALL state that local Provider_Free_Mode is the regression baseline exercised by `npm test` with no API key and no network.
3. THE Handoff_Guide SHALL specify the implementation order ORN-39 → ORN-40 → ORN-41 → ORN-42 and SHALL state the dependency rationale for that order: persistence (ORN-39) first, then streaming (ORN-40), then cost (ORN-41), then the handoff guide (ORN-42).
4. THE Handoff_Guide SHALL list, verbatim, the verification commands that must all pass before any commit — `npm test`, `npm run build`, `npm run check`, `node scripts/generate-roadmap-issues.js --check`, and `node scripts/export-linear-issues.js --check`.
5. THE Handoff_Guide SHALL state the explicit non-goals: no additional fake or filler systems, no cloud-first rewrite, and no Mongo dependency unless Mongo access already exists.

### Requirement 5: Provider-free default and test isolation hard constraints

**User Story:** As a Rector maintainer, I want the symbolic control plane and provider-free baseline
preserved and the test suite isolated from credentials and the network, so that Phase 3 does not
regress the alpha's core guarantees.

#### Acceptance Criteria

1. THE Rector chat pipeline SHALL route all run orchestration and phase-transition decisions through the symbolic control plane across every Phase 3 surface (persistence, streaming, and cost), so that no provider or LLM output determines run control flow.
2. WHERE neither a persistence driver nor an external provider is configured, THE Rector chat pipeline SHALL default to Provider_Free_Mode (`ORCHESTRATOR_MODE=local`) backed by the InMemoryRectorStore, operating with no API key present and no outbound network connection, and this configuration SHALL serve as the Phase 3 regression baseline.
3. WHEN `npm test` runs, THE Rector test suite SHALL complete with all tests passing using mocked providers and a local or injected SqlDriver in place of a real cloud database, with no environment API key required and no outbound network connection established.
4. WHEN Phase 3 persistence, streaming, and cost surfaces are added, THE Rector chat pipeline SHALL preserve the InMemoryRectorStore default-path behavior such that the existing in-memory store test suite passes without modification and the persisted conversations, messages, runs, events, and artifacts remain byte-for-byte identical to the pre-Phase-3 baseline.
5. IF a test execution attempts an outbound network connection or requires a real provider API key, THEN THE Rector test suite SHALL fail with an error indicating the prohibited network or credential access rather than contacting any external service.
