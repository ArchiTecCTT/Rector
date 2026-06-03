> [!WARNING]
> STALE / QUARANTINED DOC: This document is preserved for historical research only.
> Do not use it as the active implementation plan for Rector 0.1.0.
> Current source of truth: `docs/architecture/rector-0.1.0-architecture.md` and `docs/plans/rector-master-roadmap.md`.

# Rector Local-First MVP Design

**Decision:** Build a local-first runnable MVP with a localhost UI and adapter interfaces for future cloud providers.

## Goal
Deliver a working end-to-end Rector simulation on localhost: create a task, route it through a deterministic state machine, fan out SLM-like subtasks, validate in a sandbox-like gate, run a healing loop on failure, synthesize final output, and show everything in a browser UI.

## Architecture
Use a TypeScript monorepo-style single app with:

- **Express API server** for task ingestion, state transitions, manual controls, telemetry, and static UI hosting.
- **In-memory event bus** to emulate Kafka topics.
- **In-memory task repository** to emulate MongoDB state documents.
- **Provider adapters** for future Kafka/Mongo/LLM/Sandbox/Telemetry integrations, with local implementations active by default.
- **Deterministic Thalamus router** as the only controller of task state.
- **Local workers** for intake, flagship planning/synthesis, SLM execution, sandbox validation, and telemetry.
- **Vanilla browser UI** served from the same Express app at `http://localhost:3000`.

## State Flow

```text
1_INTAKE
  -> 2_ARCHITECTURAL_PLAN
  -> 3_SLM_EXECUTION_FANOUT
  -> 4_SANDBOX_VALIDATION
  -> 5_HEALING_LOOP when a validation fails
  -> 4_SANDBOX_VALIDATION retry after local fix
  -> 6_FINAL_SYNTHESIS
  -> 7_HUMAN_HANDOFF
```

Terminal manual states:

```text
PAUSED
ABORTED
```

## Local Simulation Behavior

- Intake builds distilled context from the task description.
- Flagship planning creates deterministic subtasks from the description.
- SLM execution creates deterministic patch summaries; tasks containing words like `fail`, `broken`, or `retry` intentionally create one validation failure to prove the healing loop works.
- Sandbox validation checks generated output and emits success/failure.
- Healing loop creates a localized fix and retries validation.
- Final synthesis creates a human-readable PR-style summary.

## UI

The localhost UI includes:

- Task creation form.
- Kanban columns for the main states.
- Task detail panel with subtask statuses and event history.
- Controls: pause, retry, approve, abort.
- Cost/telemetry panel showing local simulated model invocations, cache hits, validation count, and estimated spend.
- Setup panel listing environment variables and external services needed when replacing local adapters.

## API

- `POST /api/tasks` create task.
- `GET /api/tasks` list tasks.
- `GET /api/tasks/:id` get task state machine.
- `POST /api/tasks/:id/retry` retry from failed/paused state.
- `POST /api/tasks/:id/pause` pause task.
- `POST /api/tasks/:id/approve` approve final handoff.
- `POST /api/tasks/:id/abort` abort task.
- `GET /api/telemetry` get local metrics.
- `GET /api/setup` get required provider setup checklist.
- `POST /api/dev/scenario` seed demo scenarios for tests/UI.

## Testing

Use Vitest and Supertest.

Coverage targets:

- State transitions and invalid transition rejection.
- In-memory event bus publish/subscribe semantics.
- End-to-end task happy path.
- Healing loop path.
- Manual controls.
- HTTP API contract.
- UI static serving smoke test.

## Non-goals for MVP

- Real Kafka, MongoDB, Doppler, Together AI, Azure, Depot, Bubble, or PostHog connections.
- Real repository cloning/indexing.
- Real code execution sandbox.
- Authentication.
- Production deployment.

## Future Integration Contract

Cloud provider adapters should implement the same local interfaces so the app can switch from local mode to provider mode by environment variables without changing routing logic.
