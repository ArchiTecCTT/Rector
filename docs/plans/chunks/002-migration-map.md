# Chunk 2 — Repo Migration Map and Compatibility Strategy

> Status: current planning artifact for Rector 0.1.0 migration.
> Scope: documentation only. No runtime behavior changes.
> Source of truth context: `docs/architecture/rector-0.1.0-architecture.md` and `docs/plans/rector-master-roadmap.md`.

## Purpose

The current repository contains the old local task MVP: a task-first state machine, in-memory task repository, deterministic mock providers, Express task API, and static control-center UI.

Rector 0.1.0 is moving to a chat-first architecture where users create conversations and messages, while hidden orchestration creates runs, run events, DAGs, validation/healing cycles, and artifacts. This map prevents a big-bang rewrite by deciding how each old module should be wrapped, renamed, retired, preserved temporarily, or replaced later.

## Migration principles

1. Do not break the provider-free local baseline while new architecture lands.
2. Introduce new protocol/chat/run modules alongside old task modules first.
3. Treat old `Task` as a temporary compatibility representation of a future `Run`.
4. New code must depend on new protocol and chat/run contracts after they exist, not on old task-specific types.
5. Keep old tests as regression coverage until equivalent run/chat tests exist.
6. Adapt APIs in layers: add chat/run endpoints first, then route old task endpoints through adapters, then retire task endpoints.
7. Preserve artifact handles and event logs as first-class concepts instead of pushing large content into messages.

## Legacy Module Do-Not-Edit Checklist

To prevent regression of the provider-free baseline during early migration phases, treat the following legacy files as **read-only/no-edit** except for minor compatibility shims:

- [ ] `src/domain/states.ts` (Freeze entirely after `src/protocol/phases` lands)
- [ ] `src/domain/transitions.ts` (Keep transitions stable for task compatibility)
- [ ] `src/adapters/taskRepository.ts` (Do not expand into a multi-model store)
- [ ] `src/adapters/eventBus.ts` (Do not add durability or new event types here)
- [ ] `src/workers/workers.ts` (Do not modify pipeline execution logic)
- [ ] `tests/state.test.ts`, `tests/adapters.test.ts`, `tests/pipeline.test.ts` (Maintain as pure baseline protection)

## Fate definitions

- **wrap** — keep implementation temporarily but expose it through a new interface or adapter.
- **rename** — move or rename once the equivalent new concept exists.
- **retire** — remove after replacement and migration tests exist.
- **preserve temporarily** — keep as-is for compatibility/baseline confidence during early chunks.
- **replace later** — planned replacement is required, but not before dependent contracts are implemented.

## Current old-MVP module inventory

| Module | Current role | New architecture role | Fate | Notes |
| --- | --- | --- | --- | --- |
| `src/domain/schemas.ts` | Zod schemas/types for `Task`, `Subtask`, and task-local `Event`. | Temporary compatibility schema. Future canonical types live under `src/chat`, `src/protocol`, and run/store modules: `Conversation`, `Message`, `Run`, `RunEvent`, `Artifact`, `Budget`, `DAG`. | **wrap**, then **retire** | In chunks 3-5, old task schemas should be adapted behind mappers rather than expanded into the new data model. Do not add chat/run fields directly to `Task` except for explicit compatibility shims. |
| `src/domain/states.ts` | Old task phase constants: `1_INTAKE` through `7_HUMAN_HANDOFF`, plus `PAUSED`/`ABORTED`; task event topics. | Historical state map for compatibility. New canonical phases are `CHAT_RECEIVED`, `TRIAGE`, `CONTEXT_BUILDING`, `PLANNING`, `SKEPTIC_REVIEW`, `CRUCIBLE`, `DAG_COMPILATION`, `EXECUTING`, `VALIDATING`, `HEALING`, `SYNTHESIZING`, `DONE`, `NEEDS_DECISION`, `FAILED`, `ABORTED`. | **wrap**, then **retire** | Chunk 3 should introduce `src/protocol/phases` instead of editing this enum. Chunk 5 can map old states to new phases for bridge tests. Note that `TaskSchema.state` is tightly coupled to this `STATES` enum; freeze the old `STATES` enum entirely after new protocol phases land to prevent cross-contamination. |
| `src/domain/transitions.ts` | Validates old task state transitions and computes next states. | Temporary bridge for old task manager only. New run state machine needs phase transition rules and append-only events. | **preserve temporarily**, then **replace later** | Keep old transition behavior stable until run state machine tests cover equivalent lifecycle, pause/abort, and invalid transition rejection. |
| `src/adapters/eventBus.ts` | Synchronous in-memory pub/sub keyed by string topics. | Local dev event publisher can back early `RunEvent` notifications or test subscriptions. | **wrap** | Wrap with a `RunEventPublisher`/event-log adapter after chunk 3/5. It is not durable and should not be the source of truth for run events. |
| `src/adapters/taskRepository.ts` | In-memory CRUD for old `Task` objects with defensive cloning. | Temporary compatibility store; pattern can inform local store implementation. | **preserve temporarily**, then **replace later** | Chunk 4 should create a new local store for conversations, messages, runs, artifacts, and events. Do not mutate this into a multi-model store. |
| `src/adapters/providers.ts` | Deterministic mock planning, SLM execution, validation, healing, synthesis, and local telemetry. | Seed material for fake/local providers, validation simulator, healing simulator, and telemetry contract tests. | **wrap**, then **rename**/**replace later** | Split later into provider interfaces and fake implementations. Clarify that the split separates `LocalTelemetry` (which integrates into the main observability/metrics setup) from mock AI provider worker helpers (which become deterministic fallback implementations for testing). `planFlagshipTask`, `executeSLM`, `validateResults`, `applyHealing`, `reexecHealed`, and `synthesizeFinalOutput` can become deterministic local provider behavior only after protocol contracts exist. |
| `src/thalamus/router.ts` | `TaskManager`: creates tasks, transitions tasks, advances pipeline, stores tasks, emits events, exposes telemetry. | Compatibility orchestrator until `RunManager`/run state machine exists. Some orchestration responsibilities move to `src/orchestration`. | **wrap**, then **replace later** | Do not rename immediately. Chunk 5 should introduce a new run lifecycle and mapper. Chunk 6 can keep old manager behind legacy endpoints while chat endpoints use runs. |
| `src/workers/workers.ts` | Implements old linear task pipeline functions and `advancePipeline`. | Behavioral reference for early fake executor, validation, healing, and synthesis. | **preserve temporarily**, then **replace later** | The new pipeline is not one function per old state. It should use unified phases, DAG execution, append-only events, and bounded healing. |
| `src/api/server.ts` | Express app with task CRUD/control endpoints, telemetry, setup checklist, dev scenario seeding, static UI hosting, SPA fallback. | HTTP shell to host both legacy task endpoints and new chat/run endpoints during migration. | **wrap** | Chunk 6 should add chat-first routes alongside existing task routes. Later, old `/api/tasks` routes can be marked legacy and then removed after UI/tests migrate. |
| `src/public/app.js` | Static landing/control-center simulator using old assembly-line task states and hard-coded scenarios. | Historical demo assets until chat UI lands. Can provide visual ideas for trace drawer/status pills. | **preserve temporarily**, then **replace later** | Avoid large edits before chunk 6. New UI should be chat-first, with orchestration trace optional. |
| `src/public/index.html` | Static marketing/demo shell with old task simulator controls. | Temporary served UI shell. | **preserve temporarily**, then **replace later** | Chunk 6 should replace or add a minimal chat UI without exposing deterministic internals as primary UX. |
| `src/public/styles.css` | Static UI styles for landing/control-center. | Style source for near-term static chat UI if useful. | **preserve temporarily**, then **replace later** | Reuse selectively; do not let old control-center layout drive product semantics. |
| `src/public/system.css` | Design tokens/components used by old static UI. | Reusable frontend style primitives. | **wrap**/**preserve temporarily** | Can stay longer than old app UI if useful for chat shell. |
| `src/index.ts` | Server bootstrap: constructs telemetry, task manager, Express app, HTTP server. | App bootstrap moves toward `src/app` but can keep exporting legacy app during migration. | **wrap**, then **rename** | Introduce new app composition beside it before moving. Preserve start command and tests until replacement is complete. |
| `src/setupChecklist.ts` | Environment variable checklist with secret masking for local/cloud adapters. | Useful baseline for provider-free setup, redaction, and budget/security work. | **wrap**/**preserve temporarily** | Chunk 7 should reuse secret-safety approach and add redaction/CORS/dev-auth/budget checks. |
| `tests/adapters.test.ts` | Unit tests for in-memory event bus and task repository. | Regression tests for legacy adapters; source examples for local event/store contract tests. | **preserve temporarily**, then **migrate/replacement later** | Keep until new local store and event publisher tests cover cloning, missing IDs, list, subscribe, unsubscribe, and topic isolation. |
| `tests/api.test.ts` | Integration tests for task API, control routes, telemetry/setup, static UI, dev scenarios. | Baseline ensuring old local demo still works while chat API is added. | **preserve temporarily**, then **migrate/replacement later** | In chunk 6, add chat API tests without deleting these. Later convert task-route tests to legacy compatibility or remove once endpoints retire. |
| `tests/pipeline.test.ts` | End-to-end old task pipeline tests for happy path, healing, abort on unhealable task, event stream. | Behavioral baseline for run lifecycle, validation, healing, and event stream. | **preserve temporarily**, then **migrate/replacement later** | Keep until chunk 15 proves chat message → run → validation/healing → final answer with trace evidence. |
| `tests/providers.test.ts` | Unit tests for deterministic mock provider functions and telemetry counters. | Baseline for fake provider, validator, healer, synthesizer, telemetry contracts. | **wrap**, then **migrate/replacement later** | Split into provider adapter contract tests after chunks 9, 13, 14, 16, and 17. |
| `tests/state.test.ts` | Unit tests for old state constants, transition helpers, schemas. | Baseline for old transition behavior; model for new protocol phase tests. | **preserve temporarily**, then **migrate/replacement later** | Chunk 3 should add canonical phase/schema tests. Chunk 5 should add run transition tests. |

## Old Task concepts to new chat/run concepts

| Old task-MVP concept | Current location | New concept | Migration guidance |
| --- | --- | --- | --- |
| `Task.id` | `TaskSchema`, repository, API | `Run.id`; optional task compatibility alias | A user message should create or attach to a `Run`. IDs should use new run ID helpers after chunk 4/5. |
| `Task.description` | `TaskSchema`, API create body | `Message.content` for the user request; `Run` derives from `conversationId` + `userMessageId` | Do not keep accepting only `description` in new chat API. Legacy task API may keep it until retired. |
| `Task.state` | `STATES`, `TaskManager`, workers | `Run.phase` plus user-facing `Run.status` | Map old states only for compatibility. Canonical phase enum must come from protocol. Note that `TaskSchema.state` is tightly coupled to the legacy `STATES` enum; freeze the old `STATES` enum completely after protocol phases are defined. |
| `Task.previousState` | `TaskSchema`, transition logic | Append-only `RunEvent` history | Previous state should be derived from events, not stored as primary state. |
| `Task.subtasks[]` | `SubtaskSchema`, workers/providers | Planner tasks, DAG nodes, node results, artifact summaries | Replace old flat subtasks with plan tasks and compiled DAG nodes. Preserve old subtasks only in legacy responses. |
| `Subtask.status` | `SubtaskSchema` | DAG node status / validation result status | New node status should be scoped to executor/DAG, not mixed with run phase. |
| `Subtask.result` | `SubtaskSchema` | `Artifact` handle and/or node output summary | Large outputs should become artifacts with handles and summaries. |
| `Subtask.error` | `SubtaskSchema` | structured node error, `Run.lastError`, validation events | Errors should be typed and redacted before events/UI. |
| `Task.events[]` | `EventSchema`, workers | append-only `RunEvent` log | `RunEvent` is canonical source for trace drawer, validation evidence, model calls, decisions. |
| `Event.topic` | `TOPICS`, event bus | `RunEvent.type` | Keep topics only for old pub/sub. New events should be typed by protocol. |
| `Event.id` | `EventSchema` | `RunEvent.id` | Generate unique UUIDs or ULIDs for every run event to ensure distinct event identity, rather than relying on positional mapping. |
| `Event.timestamp` | `EventSchema` | `RunEvent.timestamp` | Map legacy timestamps to canonical ISO-8601 UTC string timestamps on all `RunEvent` records. |
| `Event.payload` | `EventSchema` | redacted event payload with trace ID | Payload must carry evidence pointers and redaction state. |
| `Task.output` | `TaskSchema`, synthesis | final assistant `Message.content` plus final artifacts | The final answer should be a message; artifacts hold supporting outputs. |
| `Task.approved` | `TaskSchema`, approve route | `NEEDS_DECISION` resolution / approval event | Replace boolean with explicit decision request, choice, actor, timestamp, and consequences. |
| `Task.validationResult` | `TaskSchema`, validation worker | validation events, validation artifact, run validation counters | Validation history should not be overwritten. Emit each run as an event/artifact. |
| `Task.metadata` | `TaskSchema`, healing attempts | typed `Run` fields, budget, route, complexity, attempts, decision request | Avoid dumping critical fields into untyped metadata. |
| `LocalTelemetry` metrics | `providers.ts`, API | observability spans/events, model-call counts, cost estimate/actuals | Keep fake/local values for provider-free tests. Introduce trace IDs and budget events later. |
| Task context/worker parameters (implicit/global dependencies) | `src/workers/workers.ts` | `WorkerDependencies` | Define a formal `WorkerDependencies` interface/context to inject required capabilities (such as stores, publishers, telemetry, and mock/live providers) into executors and managers rather than using global imports or implicit task contexts. |
| Hardcoded task-MVP failures (e.g., mock errors based on name/description) | `src/workers/workers.ts` and `src/adapters/providers.ts` | `isFailureTrigger` mapping for triage heuristics | Standardize description-based mock failure injection into a canonical helper `isFailureTrigger(messageContent: string): boolean` in early triage chunks, keeping failure/healing test paths completely deterministic. |
| `/api/tasks` | `server.ts` | `/api/conversations`, `/api/messages`, `/api/runs` | Add new endpoints beside old routes. Retire old routes after UI and tests migrate. |
| Static simulator scenarios | `src/public/app.js` | chat UI examples + optional trace drawer fixtures | Convert scenarios into seeded conversations/runs later if still valuable. |

## Old state to new phase compatibility map

This map is for bridge tests and UI migration only. It must not replace the canonical new phase enum.

| Old state | Approximate new phase(s) | Notes |
| --- | --- | --- |
| `1_INTAKE` | `CHAT_RECEIVED`, `TRIAGE`, `CONTEXT_BUILDING` | Old intake mixes request receipt and context building. New architecture separates them. |
| `2_ARCHITECTURAL_PLAN` | `PLANNING`, then `SKEPTIC_REVIEW`/`CRUCIBLE` later | Old planning has no skeptic/crucible. New chunks 9-11 split this. |
| `3_SLM_EXECUTION_FANOUT` | `DAG_COMPILATION`, `EXECUTING` | Old fanout skips explicit DAG compilation. New architecture should compile before executing. |
| `4_SANDBOX_VALIDATION` | `VALIDATING` | Preserve validation behavior as baseline, then emit run events/artifacts for every validation attempt. |
| `5_HEALING_LOOP` | `HEALING` | New healing is bounded, classified, budget-aware, and may escalate to `NEEDS_DECISION` or `FAILED`. |
| `6_FINAL_SYNTHESIS` | `SYNTHESIZING` | New synthesis produces final assistant message with evidence and unresolved risks. |
| `7_HUMAN_HANDOFF` | `DONE` or `NEEDS_DECISION` | Old handoff is terminal success. New decision flow is explicit and resumable. |
| `PAUSED` | `NEEDS_DECISION` (definitive) | Map `PAUSED` definitively to `NEEDS_DECISION`. Pausing in the new architecture is a runtime control flag (e.g., `run.isPaused`) or signal, not an orchestrator phase/state. |
| `ABORTED` | `ABORTED` | Same terminal intent. |

## Test inventory and migration plan

| Test file | Current coverage | Keep as baseline now? | Later migration/replacement |
| --- | --- | --- | --- |
| `tests/state.test.ts` | Old states, transition helpers, schema validation, event topic constants. | Yes. It protects old compatibility while new protocol tests are added. | Add `protocol/phases` and run transition tests in chunks 3 and 5. Retire old state assertions when legacy task manager is removed. |
| `tests/adapters.test.ts` | In-memory event bus delivery/unsubscribe and task repository clone/list behavior. | Yes. It protects local provider-free behavior. | Replace with local store and run event publisher contract tests after chunk 4/5. |
| `tests/providers.test.ts` | Deterministic planner/executor/validator/healer/synthesizer helpers and telemetry. | Yes. It is useful fake-provider behavior. | Split into fake planner, fake executor, validator, healer, synthesizer, telemetry tests across chunks 9, 13, 14, and 16/17. |
| `tests/pipeline.test.ts` | Old happy path, healing path, unhealable abort, event stream. | Yes. It is the strongest behavioral regression suite. | Replace with run lifecycle/event log tests in chunk 5 and end-to-end chat brainstem test in chunk 15. |
| `tests/api.test.ts` | Express task API, control routes, setup redaction, telemetry, static UI, dev scenario. | Yes. It proves old local demo does not regress during additive migration. | Add chat API tests in chunk 6. Later mark task endpoints legacy and remove tests when routes retire. |

Baseline rule: during chunks 3-10, do not delete old tests merely because new tests exist. Delete only after the new run/chat tests cover equivalent behavior and legacy routes/modules are intentionally retired.

## Compatibility strategy

### Phase 1: additive contracts, no old behavior changes

Chunks 3-5 should add protocol, data model, local store, and run lifecycle beside the old task MVP. Old task modules remain importable. New tests should target new modules directly.

### Phase 2: bridge old behavior through adapters

Add narrow mappers where needed:

- `Task` → `Run` compatibility view for state/progress.
- old task events → `RunEvent` bridge only for tests/UI migration.
- deterministic provider helpers → fake provider adapter.
- old pipeline result → final assistant message shape for early chat shell.

These mappers should live outside `src/domain` in a dedicated compatibility directory (prefer `src/adapters/compat/` as temporary) so the old domain does not become the new model by accident.

### Phase 3: chat API and UI migrate first

Chunk 6 should add chat-first endpoints and a minimal chat UI while preserving `/api/tasks` for compatibility. The primary product path becomes:

1. create/open conversation,
2. send user message,
3. create run,
4. show assistant response/status,
5. expose optional run events/trace.

The old simulator may remain accessible temporarily, but it must not be the primary UX.

### Phase 4: task API becomes legacy and then retires

After run lifecycle, chat API, budget/security, triage, and fake planning exist, task endpoints can be marked legacy. Remove them only after their replacements have tests for create, list, get, advance/run, abort, decision/approval, telemetry, setup, and UI shell behavior.

## Risks and sequencing notes for chunks 3-10

### Chunk 3 — Protocol Foundation

- Risk: reusing old task state names would leak stale architecture into the canonical protocol.
- Sequence note: create new phase/event/DAG schemas under `src/protocol`; do not edit old `src/domain/states.ts` except if a test import requires harmless compatibility.
- Acceptance focus: canonical phases match architecture exactly; schema tests exist; no provider/UI changes.

### Chunk 4 — Core Data Model and Local Store

- Risk: mutating `InMemoryTaskRepository` into a multi-domain store creates hidden coupling and harder retirement.
- Sequence note: add a new local store for `Conversation`, `Message`, `Run`, `Artifact`, `RunEvent`, `Budget`; keep task repository unchanged.
- Acceptance focus: defensive copies, list/get/save behavior, event append behavior, provider-free operation.

### Chunk 5 — Run State Machine and Event Log

- Risk: old `previousState` pattern can undermine append-only event truth.
- Sequence note: build a new run state machine with explicit invalid transition rejection and event appends; add only a bridge mapper if legacy tests need comparison.
- Acceptance focus: unified phase transitions, `NEEDS_DECISION`, `FAILED`, `ABORTED`, bounded invalid transitions, event log evidence.

### Chunk 6 — Chat API Vertical Shell

- Risk: retaining task-first UI/API as the main path conflicts with product direction.
- Sequence note: add `/api/conversations`, message send, run status/events, and minimal chat UI beside legacy routes.
- Acceptance focus: normal chat UX first; optional trace drawer; old tests still pass; no paid provider required.

### Chunk 7 — Budget, Security, and Redaction Baseline

- Risk: setup checklist currently masks configured secrets but event payloads and future traces may still leak sensitive values unless redaction is centralized.
- Sequence note: add redaction utilities and budget checks before real providers. Reuse `setupChecklist.ts` secret list carefully, but move canonical redaction into `src/core` or equivalent.
- Acceptance focus: no secrets in API responses/events/log snapshots; budget-denied flow is testable; local mode remains easy.

### Chunk 8 — Triage and Context Builder

- Risk: context builder may dump large files/logs into model input instead of artifacts.
- Sequence note: produce compact context packs with artifact handles and summaries; deterministic heuristics first.
- Acceptance focus: route selection, constraints capture, artifact handles, no raw context floods.

### Chunk 9 — Planner Schema and Fake Planner

- Risk: old `planFlagshipTask` returns only titles and is too weak for the new planner contract.
- Sequence note: wrap old deterministic behavior only as fake content generation; enforce new structured plan fields: goal, assumptions, tasks, dependencies, expected artifacts, validation, risk, approval gates.
- Acceptance focus: planner output schema tests and deterministic fake planner for provider-free contributors.

### Chunk 10 — Skeptic Review

- Risk: skeptic could become another unconstrained text generator instead of a testable reviewer.
- Sequence note: define findings with severity, evidence, impacted plan items, and recommended correction. Keep it read-only.
- Acceptance focus: flags missing validation, unsafe assumptions, non-existent files/APIs, unsupported claims, and risk underestimates.

## Retirement checkpoints

Do not retire old modules until these replacement checkpoints are true:

1. `TaskSchema` can retire after `Run`, `Conversation`, `Message`, `Artifact`, and `RunEvent` are canonical and legacy API no longer needs task-shaped responses.
2. `STATES`/`transitions` can retire after run phase tests cover all lifecycle transitions and invalid transitions.
3. `TaskManager` can retire after chat/run endpoints no longer call it and equivalent tests cover create, run, abort, decision, events, validation, healing, and synthesis.
4. `workers.ts` can retire after DAG executor, validator, healer, and synthesizer modules pass equivalent end-to-end tests.
5. Static simulator assets can retire after minimal chat UI supports conversation, message send, run status, final assistant answer, and optional trace/events.
6. Old tests can retire only when named replacement tests are in place and CI still runs `npm test` and `npm run build` successfully.
7. `eventBus.ts` can retire after a canonical `RunEventPublisher` or event log/pub-sub system is fully implemented in Chunk 4/5, verified, and covers all legacy test scenarios (unsubscribe, event delivery, topic isolation).
8. `taskRepository.ts` can retire after the new local store (supporting `Conversation`, `Message`, `Run`, `Artifact`, and `RunEvent`) is fully integrated and tested, legacy APIs no longer need task-shaped storage/retrieval, and tests cover deep cloning, missing IDs, and listing.
