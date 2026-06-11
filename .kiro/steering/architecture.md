# Architecture

## Brainstem Pipeline

Rector 0.1.0 implements one complete vertical slice of the self-healing orchestration brain.
Every run flows through deterministic phases:

```
chat -> triage -> context -> planner -> skeptic -> crucible -> DAG
     -> executor -> validation/healing -> synthesis -> final response
```

Healing re-enters validation on failure when repair is safe; unsafe or budget/permission
cases escalate to `NEEDS_DECISION`.

## Canonical Run Phases

All code and docs use this phase enum (from `src/protocol`). Status pills shown to users
are derived labels, not separate state-machine values.

```
CHAT_RECEIVED
TRIAGE
CONTEXT_BUILDING
PLANNING
SKEPTIC_REVIEW
CRUCIBLE
DAG_COMPILATION
EXECUTING
VALIDATING
HEALING
SYNTHESIZING
DONE
NEEDS_DECISION
FAILED
ABORTED
```

## Source Directories

Current/source-of-truth modules:

| Path | Responsibility |
|---|---|
| `src/api/server.ts` | Chat API, operator API, setup endpoints, static UI, brainstem wiring via `createApp`. |
| `src/orchestration/` | Run state machine + cognitive modules (see below). |
| `src/protocol/` | Phases, DAG schema, events, envelopes, Zod schemas. |
| `src/store/` | `InMemoryRectorStore` and data-model schemas (conversation, message, run, budget, artifact, event, DAG). |
| `src/security/` | Budget enforcement and redaction. |
| `src/providers/` | LLM provider contracts + fake/local and external adapters (`llm.ts`, `index.ts`). |
| `src/memory/` | In-memory truth library (TRUSTED / UNVERIFIED / REJECTED). |
| `src/observability/` | In-memory/no-op traces, spans, duration, model-call count, estimated cost. |
| `src/extensions/` | Public extension contracts (`rector.extensions.v1alpha1`). |
| `src/sandbox/` | Safe local sandbox contract; arbitrary shell denied by default. |
| `src/workflows/` | Linear/Make integration contracts/stubs; network disabled by default. |
| `src/deployment/` | Config parse/redact/readiness + graceful shutdown helpers. |
| `src/bin/server.ts` | Runtime bootstrap (executable). Defaults to `HOST=127.0.0.1`. |
| `src/index.ts` | Package root export. **Side-effect free.** |

### Orchestration modules (`src/orchestration/`)

- `triage.ts` — route/complexity classification (deterministic heuristics, optional cheap SLM).
- `contextBuilder.ts` — compact context pack with artifact handles.
- `planner.ts` — structured plan (goal, tasks, deps, validation, risk, approval gates).
- `skeptic.ts` — adversarial read-only review of the plan.
- `crucible.ts` — deterministic debate arbiter (max 2 rounds).
- `dagCompiler.ts` — accepted plan -> JSON DAG (nodes, edges, permissions, retry, timeout).
- `executorSimulator.ts` — deterministic in-memory DAG execution (no shell, no network).
- `validationHealing.ts` — deterministic checks + bounded safe repair loop.
- `synthesizer.ts` — final chat response from trace evidence.
- `runStateMachine.ts` — phase transitions + append-only event log.

## Legacy / Migration Modules

These older local-MVP directories still exist and may be re-exported for compatibility, but
**new code must depend on `protocol` / `store` / `orchestration` interfaces, not these:**

- `src/thalamus/` (e.g. `TaskManager`)
- `src/adapters/` (e.g. `LocalTelemetry`)
- `src/domain/`
- `src/workers/`

Do not build new features on the legacy task-MVP types. Wrap/adapt, don't extend. See
`docs/plans/chunks/002-migration-map.md` before touching them.

## Data Flow (chat to synthesis)

1. Chat message persists to `InMemoryRectorStore`; a `Run` is created.
2. Run transitions through phases via `runStateMachine`, appending events to the log.
3. Triage picks a route; context builder assembles a pack referencing artifact handles.
4. Planner emits a structured plan; skeptic critiques; crucible arbitrates deterministically.
5. DAG compiler produces a JSON DAG; executor simulator runs it in memory.
6. Validation runs deterministic checks; healing retries safe transient/timeout failures
   (bounded), else escalates to `NEEDS_DECISION`.
7. Synthesizer builds the final assistant response from trace evidence.

## Provider Adapter Boundaries

- `FakeLLMProvider` is the default and selected in local/provider-free mode.
- External adapters (Together, Cloudflare Workers AI, Azure OpenAI, Perplexity) require
  explicit config and have **network disabled by default** (`enableNetwork` must be true).
- The budget gate runs **before** any provider invocation.
- Routes: `cheap`, `fast`, `flagship`, `research`, `fake`.

## Extension Contracts

Public extension points (`src/extensions`, API version `rector.extensions.v1alpha1`):
`llm`, `memory`, `sandbox`, `telemetry`, `search`, `issueTracker`, `validator`, `uiClient`.
Manifests currently require `networkAccess: false`; sandbox results require `networkCalls: 0`.
No loader, isolation, or signing yet.

## Invariants — Do Not Regress

- `src/index.ts` stays side-effect free; server startup lives only in `src/bin/server.ts`.
- Dev server binds to `127.0.0.1` by default.
- Provider-free mode = zero model calls and zero cost.
- Executor/sandbox deny arbitrary shell by default.
- The in-memory baseline of the brainstem pipeline runs end-to-end with no network.
