# BYOK Alpha Implementor Handoff (ORN-42)

This is the single source-of-truth handoff for an implementing agent picking up the Rector
BYOK alpha work. Read this document first, then the specs it points to. It tells you where the
authoritative docs live, how the two run modes differ, the order the Linear issues must be
implemented in, the verification commands that must pass before any commit, and the explicit
non-goals that bound the work.

## 1. Source-of-truth documents

Everything below is current and tracked in the repository. Do **not** re-derive context from
memory, chat history, or any deleted/quarantined document — use these.

### BYOK alpha specs

The approved specs are the controlling requirements for each phase. Each folder contains
`requirements.md`, `design.md`, and `tasks.md`.

- **Phase 1** — `.kiro/specs/byok-alpha-phase1/`
- **Phase 2** — `.kiro/specs/byok-alpha-phase2/`
- **Phase 3** — `.kiro/specs/byok-alpha-phase3/` (ORN-39 → ORN-42: persistence, streaming, cost, this guide)

### Architecture document

- `docs/architecture/rector-0.1.0-architecture.md` — the system architecture for the `0.1.0`
  alpha (chat pipeline, symbolic control plane, store, providers, deployment surfaces).

### Generated Linear issue chunks

- `docs/issues/generated/` — the generated, per-issue Linear chunks (`chunk-000-*.md` …
  `chunk-025-*.md`) plus `docs/issues/generated/README.md` describing the set. These are the
  roadmap breakdown that the scripts in `scripts/` produce and check. `chunk-000` is the
  source-of-truth-docs and stale-doc quarantine issue — consult it if you are unsure whether a
  document is authoritative.

> Do not reference any deleted or stale document. If a doc is not in the locations above, treat it
> as non-authoritative.

## 2. Local vs external mode

Rector runs in one of two orchestration modes, selected by the `ORCHESTRATOR_MODE` environment
variable (parsed in `src/deployment/index.ts`; default `local`).

- **`ORCHESTRATOR_MODE=local`** (default) — the deterministic, **provider-free** path. No API key,
  no outbound network. This is the **regression baseline** exercised by `npm test`.
- **`ORCHESTRATOR_MODE=external`** — the BYOK path. Requires at least one configured, validated
  provider; a `ModelRouter` is built once at app init and injected into the runner.

### How the chat runner dispatches by mode

`runChat(store, args, deps)` in `src/orchestration/chatRunner.ts` branches on `deps.mode`:

- `deps.mode === "external"` → `runExternalChatRun(...)`. A configured `ModelRouter` is required;
  the **only** divergence from local is the planner step (`runLivePlanner` against a
  router-selected provider) plus the recorded provider/model/cost metadata. Every other phase
  (skeptic → crucible → DAG → executor → validation → synthesis) is the deterministic shared
  sequence.
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

## 3. Implementation order (ORN-39 → ORN-40 → ORN-41 → ORN-42)

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

## 4. Verification commands

All of the following must pass before any commit:

```bash
npm test
npm run build
npm run check
node scripts/generate-roadmap-issues.js --check
node scripts/export-linear-issues.js --check
```

## 5. Explicit non-goals

- **No additional fake or filler systems.** Extend the existing primitives; do not add new
  placeholder subsystems.
- **No cloud-first rewrite.** Local provider-free mode stays the default and the regression
  baseline; hosted paths are optional, never required.
- **No Mongo dependency unless Mongo access already exists.** The `mongoUri`/`mongoDb`/`redisUrl`
  config fields remain for backward compatibility but are unused by store selection, and no Mongo
  client dependency is added.
