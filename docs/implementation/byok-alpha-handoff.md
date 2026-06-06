# BYOK Alpha Implementor Handoff (ORN-42)

This is the single source-of-truth handoff for an implementing agent picking up the Rector
BYOK alpha work. Read this document first, then the specs it points to. It tells you where the
authoritative docs live, the full ORN-30 → ORN-42 implementation program (Phases 1–3), how the two
run modes differ, the order the Phase 3 Linear issues must be implemented in, the verification
commands that must pass before any commit, and the explicit non-goals that bound the work.

## 1. Source-of-truth documents

Everything below is current and tracked in the repository. Do **not** re-derive context from
memory, chat history, or any deleted/quarantined document — use these.

### BYOK alpha specs

The approved specs are the controlling requirements for each phase. Each folder contains
`requirements.md`, `design.md`, and `tasks.md`.

- **Phase 1** — `.kiro/specs/byok-alpha-phase1/` (ORN-31 → ORN-34: mode switch, connection test,
  mode-aware chat runner, live planner)
- **Phase 2** — `.kiro/specs/byok-alpha-phase2/` (ORN-35 → ORN-38: live skeptic, live synthesizer,
  safe workspace executor, bounded healing loop)
- **Phase 3** — `.kiro/specs/byok-alpha-phase3/` (ORN-39 → ORN-42: persistence, streaming, cost,
  this guide)

### Architecture document

- `docs/architecture/rector-0.1.0-architecture.md` — the system architecture for the `0.1.0`
  alpha (product vision, unified run phases, the cognitive pipeline, data model, stack strategy,
  security baseline, and the scaling path). This is the framing document the three phase specs
  build on.

### Generated Linear issue chunks

- `docs/issues/generated/` — the generated, per-issue Linear chunks (`chunk-000-*.md` …
  `chunk-025-*.md`, 26 drafts) plus `docs/issues/generated/README.md` describing the set. These are
  the roadmap breakdown that the scripts in `scripts/` produce and check. `chunk-000` is the
  source-of-truth-docs and stale-doc quarantine issue — consult it if you are unsure whether a
  document is authoritative.

> Do not reference any deleted or stale document. If a doc is not in the locations above, treat it
> as non-authoritative.

## 2. Implementation overview (ORN-30 → ORN-42)

The BYOK alpha is delivered across three approved specs. The confirmed ORN issue numbers and their
deliverables, taken from each phase's `requirements.md`/`tasks.md`, are:

| ORN | Phase | Deliverable | Controlling spec |
| --- | --- | --- | --- |
| ORN-31 | 1 | Orchestration mode switch + startup validation | `.kiro/specs/byok-alpha-phase1/` |
| ORN-32 | 1 | Provider connection-test endpoint | `.kiro/specs/byok-alpha-phase1/` |
| ORN-33 | 1 | Mode-aware chat runner with budget preflight | `.kiro/specs/byok-alpha-phase1/` |
| ORN-34 | 1 | Live planner with validation + single repair | `.kiro/specs/byok-alpha-phase1/` |
| ORN-35 | 2 | Live skeptic agent | `.kiro/specs/byok-alpha-phase2/` |
| ORN-36 | 2 | Live synthesizer agent | `.kiro/specs/byok-alpha-phase2/` |
| ORN-37 | 2 | Safe workspace executor (path + command containment) | `.kiro/specs/byok-alpha-phase2/` |
| ORN-38 | 2 | Bounded validation and healing loop | `.kiro/specs/byok-alpha-phase2/` |
| ORN-39 | 3 | Local persistence (SQLite default, optional TiDB) | `.kiro/specs/byok-alpha-phase3/` |
| ORN-40 | 3 | SSE streaming trace UI (polling fallback preserved) | `.kiro/specs/byok-alpha-phase3/` |
| ORN-41 | 3 | Cost/token dashboard + per-run budget enforcement | `.kiro/specs/byok-alpha-phase3/` |
| ORN-42 | 3 | This implementor handoff guide | `.kiro/specs/byok-alpha-phase3/` |

> **On ORN-30:** the Phase 3 plan frames the program as starting at ORN-30, but none of the three
> BYOK alpha phase specs assign a deliverable to ORN-30 — Phase 1 begins at ORN-31. Treat ORN-30 as
> the pre-phase **foundation**: the source-of-truth docs, the `0.1.0` architecture document, and the
> generated roadmap/issue catalog that establish the provider-free `v0.1.0-alpha` brainstem the BYOK
> phases extend (see `docs/architecture/rector-0.1.0-architecture.md` §2 "Current Repo Reality" and
> the generated chunks, notably `chunk-000`). No specific ORN-30 scope is invented here because the
> specs do not define one.

### Overall ordering and rationale

The program runs **foundation → BYOK planning path → live pipeline → persistence → streaming →
cost → handoff**:

1. **Foundation (pre-Phase 1).** The provider-free brainstem, protocol boundaries, run state
   machine, in-memory store, and the deterministic pipeline already exist; the BYOK phases extend
   these primitives rather than replacing them. Keeping provider-free local mode as the regression
   baseline is the migration principle the architecture doc sets out.
2. **Phase 1 (ORN-31 → ORN-34) — first live surface.** Make only the **planning** phase
   BYOK-capable behind an explicit mode switch, add a credential connection test, and route runs
   through a mode-aware runner. Planning comes first because it is the narrowest live surface that
   proves the budget-preflight, redaction, and structured-blocker contracts end to end.
3. **Phase 2 (ORN-35 → ORN-38) — the rest of the pipeline goes live.** With the contracts proven,
   make the skeptic, synthesizer, executor, and healing loop live, adding real workspace containment
   and a bounded repair loop. This depends on the Phase 1 primitives.
4. **Phase 3 (ORN-39 → ORN-42) — product surface.** Persist runs so they survive restart, stream the
   trace live, surface cost/token totals, and write this handoff. Strict order within the phase is
   covered in §4.

Throughout every phase the symbolic control plane stays in charge, secrets are redacted at every
boundary, a budget preflight runs before any network call, and malformed/unsafe output is refused
deterministically rather than crashing.

### Phase 1 — BYOK planning path (ORN-31 → ORN-34)

- **Goal:** make Rector's chat pipeline use a real BYOK provider for the **PLANNING** phase only,
  while the provider-free local path stays the default and the `npm test` regression baseline.
- **ORN-31 — Orchestration mode switch + startup validation.** `parseOrchestrationConfig`,
  `OrchestrationConfigError`, and the `ORCHESTRATOR_MODE` parsing in `src/deployment/index.ts`;
  wired into startup via `src/bin/server.ts`, `src/api/server.ts`, and `src/setupChecklist.ts`.
- **ORN-32 — Provider connection-test endpoint.** `runConnectionTest` and the
  `POST /api/setup/test-connection` route in `src/api/server.ts`, reusing `src/providers/llm.ts`;
  at most one provider ping, no secret in any response.
- **ORN-33 — Mode-aware chat runner.** `runChat` in `src/orchestration/chatRunner.ts` dispatching to
  `runFakeChatRun` (local) or `runExternalChatRun` (external), with the budget preflight and recorded
  `ProviderCallMetadata`.
- **ORN-34 — Live planner.** `runLivePlanner` in `src/orchestration/planner.ts` with prompts in
  `src/orchestration/prompts.ts`: budget preflight, JSON-object response, schema validation, exactly
  one repair retry, and structured `BUDGET_DENIED`/`PLANNER_INVALID`/`PROVIDER_ERROR` blockers.

### Phase 2 — live pipeline and safe execution (ORN-35 → ORN-38)

- **Goal:** turn the remaining deterministic phases into a real neuro-symbolic coding agent with the
  control plane still in charge; local mode stays byte-for-byte identical to Phase 1.
- **ORN-35 — Live skeptic.** `runLiveSkeptic` in `src/orchestration/skeptic.ts`: critiques the plan,
  recomputes the verdict from finding severities, one repair retry, budget preflight, structured
  `SkepticBlocker`s.
- **ORN-36 — Live synthesizer.** `runLiveSynthesizer` in `src/orchestration/synthesizer.ts`:
  evidence-cited final answer that falls back to the deterministic synthesizer on any
  budget/provider/validation failure, with redaction on input and assembled output.
- **ORN-37 — Safe workspace executor.** `resolveWithinWorkspace` and `WorkspaceSandboxAdapter` in
  `src/sandbox/index.ts`, bridged from the DAG by `executeDagThroughSandbox` in
  `src/orchestration/sandboxExecutor.ts`: workspace-root containment, command allowlist/denylist,
  approval gating, timeouts, and bounded output capture.
- **ORN-38 — Bounded healing loop.** `validateAndHealExecution` in
  `src/orchestration/validationHealing.ts`: bounded live repair over real failures, patches applied
  only through the safe executor, all artifacts preserved, structured `NEEDS_DECISION`/`FAILED`
  outcomes. All four are wired into `runExternalChatRun`.

### Phase 3 — product surface (ORN-39 → ORN-42)

- **Goal:** close the gaps that remain after Phases 1–2 — runs that do not survive restart, a trace
  UI that only renders after completion, cost/token usage never surfaced live, and the lack of a
  single handoff document.
- **ORN-39 — Local persistence.** The `RectorStore` interface and factory in `src/store/index.ts`,
  `SqlRectorStore` over an injectable `SqlDriver` (`src/store/sqlRectorStore.ts`), the SQLite default,
  and the optional TiDB driver (`src/store/tidbRectorStore.ts`); `InMemoryRectorStore`
  (`src/store/inMemoryRectorStore.ts`) stays the default and baseline.
- **ORN-40 — SSE streaming trace UI.** The `RunEventBroker`, `withEventBroadcast` decorator, SSE
  frame schemas, and `registerRunStreamRoute` (`GET /api/runs/:id/stream`) in `src/api/server.ts`,
  with the live client and polling fallback in `src/public/app.js`. The `GET /api/runs/:id/events`
  polling endpoint is preserved unchanged.
- **ORN-41 — Cost/token dashboard.** `aggregateRunCost`/`aggregateConversationCost` in
  `src/observability/index.ts`, `enforceMaxPerRunBudget` in `src/security/budget.ts`, the
  `GET /api/runs/:id/cost` and `GET /api/chat/conversations/:id/cost` endpoints, live `cost` SSE
  frames, and the cost panel in `src/public/app.js`.
- **ORN-42 — This implementor handoff guide** (`docs/implementation/byok-alpha-handoff.md`).

## 3. Local vs external mode

Rector runs in one of two orchestration modes, selected by the `ORCHESTRATOR_MODE` environment
variable (parsed in `src/deployment/index.ts`; default `local`).

- **`ORCHESTRATOR_MODE=local`** (default) — the deterministic, **provider-free** path. No API key,
  no outbound network. This is the **regression baseline** exercised by `npm test`.
- **`ORCHESTRATOR_MODE=external`** — the BYOK path. Requires at least one configured, validated
  provider; a `ModelRouter` is built once at app init and injected into the runner.

### How the chat runner dispatches by mode

`runChat(store, args, deps)` in `src/orchestration/chatRunner.ts` branches on `deps.mode`:

- `deps.mode === "external"` → `runExternalChatRun(...)`. A configured `ModelRouter` is required.
  After Phases 1–2 the external path runs live agents for the planner (`runLivePlanner`), skeptic
  (`runLiveSkeptic`), and synthesizer (`runLiveSynthesizer`), executes the DAG through the safe
  workspace executor, and heals real failures through the bounded loop — recording
  provider/model/cost metadata on the relevant events. Crucible and DAG compilation remain the
  deterministic shared steps.
- otherwise → `runFakeChatRun(...)`. Fully provider-free: same phase sequence, all-zero
  budget/cost, deterministic plan source, no network call.

The symbolic control plane stays in charge in both modes — no provider or LLM output determines
run control flow.

### Persistence and the baseline

Persistence is selected independently via `RECTOR_PERSISTENCE` (`memory` default, `sqlite`, or
`tidb`) through `createRectorStore` (`src/store/index.ts`). The **in-memory store** (`memory`) is
the default and the test baseline; `sqlite` (`RECTOR_SQLITE_PATH`) is the local file-backed path
with no cloud account and no network; `tidb` (the `TIDB_*` block) is the optional hosted path,
never auto-selected for local use.

The Phase 3 regression baseline is therefore: `ORCHESTRATOR_MODE=local` + in-memory store, with
no API key present and no outbound network connection. `npm test` must pass in exactly this
configuration using mocked providers and a local/injected `SqlDriver`.

## 4. Phase 3 implementation order (ORN-39 → ORN-40 → ORN-41 → ORN-42)

Implement the Phase 3 issues strictly in this order:

1. **ORN-39 — Local persistence (SQLite default, optional TiDB).**
2. **ORN-40 — SSE streaming trace UI (polling fallback preserved).**
3. **ORN-41 — Cost and token dashboard (per-run budget enforcement).**
4. **ORN-42 — This implementor handoff guide.**

### Dependency rationale

- **Persistence first (ORN-39):** streaming and cost both read from persisted, already-redacted
  run events. There is nothing reliable to stream or aggregate until runs and events survive and
  are queryable, so persistence is the foundation.
- **Then streaming (ORN-40):** the SSE stream replays persisted events and publishes live ones via
  the `RunEventBroker`. It depends on the persistence layer existing, and it establishes the
  delivery channel that the live cost frames ride on.
- **Then cost (ORN-41):** cost aggregates are derived views folded from the
  `ProviderCallMetadata`/`LLMUsage` already recorded on persisted run events, and live `cost`
  frames are emitted over the streaming channel built in ORN-40. So cost depends on both prior
  pieces.
- **Then the handoff guide (ORN-42):** it documents the finished surface, so it comes last.

## 5. Verification commands

All of the following must pass before any commit:

```bash
npm test
npm run build
npm run check
node scripts/generate-roadmap-issues.js --check
node scripts/export-linear-issues.js --check
```

## 6. Explicit non-goals

- **No additional fake or filler systems.** Extend the existing primitives; do not add new
  placeholder subsystems.
- **No cloud-first rewrite.** Local provider-free mode stays the default and the regression
  baseline; hosted paths are optional, never required.
- **No Mongo dependency unless Mongo access already exists.** The `mongoUri`/`mongoDb`/`redisUrl`
  config fields remain for backward compatibility but are unused by store selection, and no Mongo
  client dependency is added.
