# Rector Concerns and Vulnerabilities Register

> Running register for implementation concerns, security risks, review notes, and deferred fixes discovered while implementing chunks. Keep updated through final chunk.

## Open

### Chunk 048 configured product readiness and gating (G1)

- **Source:** Chunk 048 product model hardening.
- **Severity:** Low (mitigated).
- **Status:** Resolved / Closed.
- **Root cause:** Conversation creation was previously ungated, which allowed unconfigured clients to bypass the first-run onboarding screen via API calls.
- **Plan / Mitigations:** Gate both conversation creation (`POST /api/chat/conversations`) and message creation on setup readiness (returning `409 SETUP_REQUIRED` when unconfigured). Verified via unit tests (`tests/productGate.test.ts`) and end-to-end integration tests (`tests/productModel.integration.test.ts`).
- **Traceability:** `src/api/server.ts`, `tests/productGate.test.ts`, `tests/productModel.integration.test.ts`.

### Chunk 048 deprecation of ORCHESTRATOR_MODE in runtime paths (G3)

- **Source:** Chunk 048 product model hardening.
- **Severity:** Low (mitigated).
- **Status:** Resolved / Closed.
- **Root cause:** Boot routing previously checked environment variables directly instead of the authoritative `runtime-settings.json` file.
- **Plan / Mitigations:** Remove `ORCHESTRATOR_MODE` checks from active server boot sequence. It remains only for one-time legacy migration in `ensureRuntimeSettings()`. Post-migration startup router and sandbox adapter check `runtime-settings.json`'s `orchestrationProfile`.
- **Traceability:** `src/bin/server.ts`.

### Chunk 048 TogetherAIProvider HTTP integration smoke tests (G5)

- **Source:** Chunk 048 product model hardening.
- **Severity:** Low (mitigated).
- **Status:** Resolved / Closed.
- **Root cause:** TogetherAIProvider network calls are disabled in default CI, meaning the real HTTP request serialization, headers, response parsing, and error-retryable mapping code paths lacked integration test coverage.
- **Plan / Mitigations:** Added an integration test (`tests/providerSmoke.test.ts`) utilizing Node's built-in `http.createServer` to spin up a local mock server. Verifies that headers, request shape, token usage parsing, and retryable/non-retryable HTTP error mappings are correct on the live fetch path without hitting real external API endpoints.
- **Traceability:** `tests/providerSmoke.test.ts`, `src/providers/llm.ts`.

### Local performance baseline thresholds are advisory until history exists

- **Source:** Performance baseline benchmark (`scripts/performance-baseline.ts`).
- **Severity:** Low/medium — measurement exists, but production performance readiness is not claimed from local in-process timings alone.
- **Status:** Open (monitoring).
- **Root cause:** After Chunks 042–046 the codebase is large (orchestration hardening, assignment stores, templates, RBAC, expanded test suite). We need repeatable evidence before refactoring for speed, but a single developer-machine run cannot define production SLOs.
- **Plan / Mitigations:** Run `npm run benchmark:performance` locally or in CI for trend tracking (after `npm run build` so compiled cold-start and dist-backed probes are available). Thresholds in `docs/benchmarks/performance-baseline.md` are advisory unless `--enforce` is passed. Cold subprocess startup (`startup_cold_subprocess` tsx + `startup_cold_compiled_subprocess` node/dist) supplements warm in-process import timing. Pipeline phase rows (`pipeline_*`) break down `local_fake_pipeline` for regression targeting. Do not claim VPS/cloud performance readiness until multi-machine baseline history and hosted smoke timings exist.
- **Traceability:** `docs/benchmarks/performance-baseline.md`, `scripts/performance-baseline.ts`, `scripts/performance-baseline-cold-start.ts`, `scripts/performance-baseline-cold-start-compiled.mjs`, `tests/performanceBaseline.test.ts`, `package.json` (`benchmark:performance`).

> Updated during full system audit 2026-06-09 (subagents used; see audits/full-system-audit-2026-06-09.md); follow-up register cleanup 2026-06-10 after Gemini-led test fixes + neuro chunk commits (now 1241 tests green). See audit report for original matrix + evidence.
>
> 2026-06-12 042f stitch note: Chunks 042a-046 are merged on `work/042-046-stitch`; verification passed with `npm run build`, `npm test` (265 files / 1575 tests passed, 5 skipped), and `npm audit` (0 vulnerabilities). The table below supersedes older historical statuses where they conflict.

### Chunk 047a deterministic compression is safe for CI but lossy for production-quality context reduction

- **Source:** Chunk 047a tiered prompt assembly and compression lineage.
- **Severity:** Medium for long, high-context production conversations; low for deterministic spy CI.
- **Status:** Open / accepted for 047a.
- **Root cause:** Oversized context is summarized by deterministic truncation/bullet extraction so `npm test` stays network-free with `SpyLLMProvider` and in-memory stores. This preserves redaction and lineage but can drop nuance that a configured live summarizer may retain.
- **Plan / Mitigations:** Keep deterministic summarization as the default test-safe path. Add a configured, budget-aware live summarizer only after provider resilience and run-control semantics are in place; never call it in default CI. Chunk 047e should make compression lineage visible in the conversation UI so users can inspect parent/child context boundaries.
- **Traceability:** `docs/plans/chunks/047a-tiered-prompt-assembly.md`, `src/orchestration/contextCompression.ts`, `src/orchestration/promptTiers.ts`, `tests/contextCompression.test.ts`, `tests/promptTiers.test.ts`.

### Chunk 047a prompt tier stability is run-scoped, not assignment-scoped

- **Source:** Chunk 047a stable/context/volatile prompt assembly.
- **Severity:** Low/medium.
- **Status:** Open / expected behavior.
- **Root cause:** Stable tier hashes are enforced within a single run. A future model/template/assignment change between runs can legitimately change the stable tier contract, but there is not yet a product UX indicator explaining that distinction.
- **Plan / Mitigations:** Treat mid-run stable tier mutation as blocked. Record tier budget/compression events in traces, and add assignment/lineage visibility in later 047 chunks so operators can tell whether a prompt contract changed because of a deliberate configured assignment change.
- **Traceability:** `src/orchestration/promptTiers.ts`, `src/orchestration/prompts.ts`, `src/orchestration/chatRunner.ts`, `tests/promptTiers.test.ts`.

### Chunk 047b tool registry centralizes dispatch but still needs production ACL and sandbox readiness hardening

- **Source:** Chunk 047b tool registry and executor middleware.
- **Severity:** Medium for production extensibility and sandbox execution; low for current builtin-only CI coverage.
- **Status:** Open / accepted for 047b.
- **Root cause:** The builtin registry is an explicit TypeScript list, so new executor tools require manual catalog updates. Module-provided tools can register through `ModuleBootContext.toolRegistry`, but their ACL/review model is still minimal. The sandbox environment selector defaults to the safe `stub` path, while real `local`/`e2b` execution still depends on readiness checks, approvals, and future UI configuration polish.
- **Plan / Mitigations:** Keep `/api/tools` read-only and builtin-filtered for now, fail closed on unknown/unavailable tools, require middleware approval gates for write/destructive tools, and keep module tools unavailable when their module is disabled. Future chunks should add module tool ACL review, per-tool readiness diagnostics, and E2B network/isolation smoke tests behind explicit configured-product setup.
- **Traceability:** `docs/plans/chunks/047b-tool-registry-executor.md`, `src/tools/*`, `src/orchestration/sandboxExecutor.ts`, `tests/toolRegistry.test.ts`, `tests/toolMiddleware.test.ts`, `tests/sandboxExecutorRegistry.integration.test.ts`, `tests/toolsApi.test.ts`.

### Chunk 047c run control is in-memory and cooperative

- **Source:** Chunk 047c interrupt, steer, and turn-budget implementation.
- **Severity:** Medium for hosted/multi-instance deployments; low for current single-process local/product preview.
- **Status:** Open / accepted for 047c.
- **Root cause:** Run control state is process-local and cancellation is cooperative. Interrupts trip the registered abort signal and are observed by provider, sandbox, executor, and healing boundaries, but a multi-process deployment would need shared run-control state. Already-spawned local commands may also take a short time to terminate, depending on the command runner and OS behavior.
- **Plan / Mitigations:** Keep operator and user routes delegated to shared `interruptRun` / `steerRun`, emit `RUN_INTERRUPT_REQUESTED`, `RUN_STEER_ENQUEUED`, and `RUN_BUDGET_EXHAUSTED` events for auditability, and treat stop as best-effort cooperative cancellation until distributed run state and stronger sandbox process supervision land. Future hosted work should back run control with the durable run/event store or a shared coordinator.
- **Traceability:** `docs/plans/chunks/047c-run-control-budget.md`, `src/orchestration/runControl.ts`, `src/orchestration/turnBudget.ts`, `src/api/routes/runControl.ts`, `src/orchestration/sandboxExecutor.ts`, `src/tools/middleware.ts`, `tests/runControl.test.ts`, `tests/runControlApi.test.ts`, `tests/runInterrupt.integration.test.ts`, `tests/runSteer.integration.test.ts`.

### Chunk 047d user-supplied skills are prompt material, not trusted code

- **Source:** Chunk 047d procedural memory / skills catalog.
- **Severity:** Medium for prompt-injection and stale-procedure risk; low for bundled low-risk skills.
- **Status:** Open / accepted for 047d.
- **Root cause:** `.rector/skills/` files are user-supplied procedural text. The catalog is read-only and crucible-gated, but approved skill bodies still become prompt context and can contain stale or adversarial instructions.
- **Plan / Mitigations:** Keep skills passive: no automatic execution, no network install, and no file writes from the catalog. Crucible denies unknown skills, enforces a max activation cap, blocks high-risk skills without approval gates, and emits redacted skill activation events. Context injection is limited to approved skill IDs and capped by `maxSkillContextChars`. Future chunks should add stronger provenance/signature checks and skill write-guard scanning before marketplace/import support.
- **Traceability:** `docs/plans/chunks/047d-procedural-memory-skills.md`, `src/memory/skillsCatalog.ts`, `src/orchestration/crucible.ts`, `src/orchestration/contextBuilder.ts`, `tests/skillsCatalog.test.ts`, `tests/skillCrucible.integration.test.ts`.

### Chunk 047e SQLite FTS search is redacted and workspace-scoped but still a local keyword index

- **Source:** Chunk 047e session search and conversation lineage.
- **Severity:** Medium for production search quality and retention policy, low for default CI.
- **Status:** Open / accepted for 047e.
- **Root cause:** SQLite FTS5 indexes redacted message text for local persistence only. This prevents raw secret substrings from entering or matching the FTS table, but it is still keyword-only, stores redacted copies of message text, and does not cover future TiDB/vector-backed search semantics.
- **Plan / Mitigations:** Keep `npm test` hermetic with in-memory stores and SQLite `:memory:`. Continue redacting before FTS writes, API egress, and UI snippet rendering. Workspace filters stay mandatory on search routes. Follow-up production hardening should add retention-aware index pruning, TiDB/search-provider parity, and broader fuzz coverage for unusual FTS query syntax.
- **Traceability:** `docs/plans/chunks/047e-session-search-lineage.md`, `src/store/sessionSearch.ts`, `src/store/sqlRectorStore.ts`, `tests/sessionSearchSqlite.test.ts`, `tests/conversationSearchApi.test.ts`.

### Chunk 042f reconciliation matrix for known hardening concerns

| Concern | 042f status | Evidence | Remaining follow-up |
|---|---|---|---|
| SQL/TiDB advanced memory parity | RESOLVED for local/SQL contract coverage | `src/store/sqlRectorStore.ts`, `src/memory/tidbMemoryAdapter.ts`, `tests/sqlMemoryParity.test.ts`, `tests/memoryProviderContract.test.ts` | Live TiDB smoke remains env-gated and not run in default verification. |
| Startup migration boot path | RESOLVED | `src/bin/server.ts` calls `runStartupMigration` before `createApp` for sqlite/tidb; `tests/startupMigrationBoot.test.ts`, `tests/tidbStartupMigrationBoot.test.ts` | Production migrations still need operator backup/rollback policy. |
| Deterministic orchestration placeholders | PARTIALLY RESOLVED | 042a/042b added schema validation, repair/fallback, explicit DAG/approval/validation policies; local deterministic mode preserved; `tests/*Hardening.test.ts`, `tests/livePlanner.test.ts`, `tests/liveSkeptic.test.ts` | Local fake planner remains regression baseline; real provider quality/live smokes are optional. |
| Heuristic skeptic/crucible/planner | PARTIALLY RESOLVED | Deterministic rules are named/deduped; live planner/skeptic paths are schema-gated and cannot suppress deterministic blockers; `src/orchestration/{planner,skeptic,crucible}.ts` | Deep semantic quality and human escalation UX need later product work. |
| Sandbox mock runner | PARTIALLY RESOLVED | Sandbox policy and safe local runner guard added; E2B remains optional; `src/sandbox/index.ts`, `src/orchestration/sandboxExecutor.ts`, `tests/sandboxPolicyHardening.test.ts`, `tests/safeLocalRunner.guard.test.ts` | Default local mode still avoids real execution; production isolation requires configured external sandbox and live smoke. |
| Rate limiter local-only | PARTIALLY RESOLVED | `src/security/rateLimiter.ts` introduces interface, route buckets, fail-closed behavior; `tests/rateLimiterHardening.test.ts` | Default backend is still in-memory; distributed backend required for multi-instance hosting. |
| Truth library keyword-only | PARTIALLY RESOLVED | Hybrid scoring/provenance validation added; `src/memory/truthLibrary.ts`, `tests/truthLibraryHardening.test.ts` | Vector-backed truth retrieval remains future adapter work. |
| Provider adapter hardening | PARTIALLY RESOLVED | Probe classification, discovery, redaction, model assignment routing, and tests pass; `src/providers/*`, `tests/*Discovery*.test.ts`, `tests/orchestrationAssignments*.test.ts` | Live provider smoke remains opt-in and was not run. |
| Telemetry no-ops | STILL OPEN | Local telemetry/observability tests pass, but external telemetry integrations remain inert/no-op | Add PostHog/DataDog/New Relic adapters only behind UI config and redaction gates. |
| Operator API auth/local-only | PARTIALLY RESOLVED | 046 adds RBAC middleware around `/api/operator`; `tests/rbacApiAuthorization.test.ts` | Operator envelope still labels local/no-auth for compatibility; durable team membership/admin UX remains open. |
| Linear UUID labels | STILL OPEN | Linear export remains network-disabled/stub-oriented | Add real Linear ID mapping once integration is enabled. |
| `pruneMemory` determinism | RESOLVED for tested stores | Deterministic clock/contract coverage in memory hardening tests | Reassess when external memory pruning is live. |
| Template assignment stubs | RESOLVED by stitch | `TemplateService` now writes through durable `OrchestrationAssignmentStore`/`MemoryAssignmentStore`; `tests/templateService.test.ts`, `tests/templateApi.test.ts` | Restart-persistence UI smoke can be added later. |
| Commercial auth/RBAC | PARTIALLY RESOLVED | Auth/RBAC/quotas/audit/readiness merged and tested; OIDC/Auth0 remains adapter-only optional shape | Durable workspace membership, invitation flows, backup/restore, billing, and compliance are not production-ready. |

### Chunk 045 template assignments required stitch to durable Chunk 043/044 stores

- **Source:** Chunk 045 implementation wave; durable orchestration/memory assignment stores from Chunks 043/044 were not present in that isolated worktree.
- **Severity:** Low after stitch for current local/file-backed behavior; persistence coverage still needs final verification.
- **Status:** Partially resolved during 042f stitch.
- **Root cause:** Template preview/apply needs role assignment targets, but the durable stores/routes from sibling chunks were unavailable during wave 2. Chunk 045 added secret-free additive interfaces plus in-memory assignment stores so template apply could be tested without touching provider secrets or provider records.
- **Plan:** Final 042f verification must confirm template apply writes through `OrchestrationAssignmentStore` and `MemoryAssignmentStore` from Chunks 043/044 and preserve the current template schema/API contract.
- **Traceability:** `src/providers/orchestrationAssignments.ts`, `src/providers/memoryAssignmentStore.ts`, `src/providers/memoryAssignments.ts`, `src/templates/templateService.ts`, `tests/templateService.test.ts`, `tests/templateApi.test.ts`.

### Chunk 046 commercial auth/RBAC baseline still needs durable workspace membership backing

- **Source:** Chunk 046 implementation.
- **Severity:** Medium for hosted/team production, low for local-dev.
- **Status:** Open.
- **Root cause:** RBAC, quotas, audit logging, deployment readiness checks, and workspace isolation helpers are now centralized and tested, but the default workspace directory is an in-memory helper. The live server persists audit events to `.rector/audit-events.jsonl`, and per-user provider/memory/secret stores already exist, but workspace/user/membership administration needs a durable store before relying on team membership changes across restarts.
- **Plan / Mitigations:** Local-dev auth-disabled mode remains implicit owner and zero-config. Auth-enabled deployments can inject a `WorkspaceDirectory` implementation; route-level authorization/audit/quota checks are centralized around that interface. Follow-up production hardening should add SQLite/TiDB-backed users/workspaces/memberships, invitation flows, owner-transfer constraints, and backup/restore coverage for membership state.
- **Traceability:** `docs/plans/chunks/046-commercial-readiness-auth-rbac.md`, `src/security/rbac.ts`, `src/security/workspaces.ts`, `src/security/auditLog.ts`, `src/security/quotas.ts`, `src/deployment/readiness.ts`, `tests/rbacApiAuthorization.test.ts`, `tests/workspaceIsolation.test.ts`.

### External mode fail-fast startup check ignores UI-persisted configurations

- **Status:** RESOLVED.
- **Traceability:** Boot-tolerant async resolution (Req 1) now on live path: `src/bin/server.ts:223` (bootstrap calls `resolveStartupOrchestrationConfig` which uses `resolveOrchestrationConfig` + BYOK stores), `src/providers/orchestrationConfig.ts:270` (full `resolveOrchestrationConfig` + union of env + Provider_Config_Store/Secret_Store presence-only via `hasSecret`; only hard-halt is `ORCHESTRATOR_MODE_INVALID` per Req 1.6; zero-provider external now warns + serves per Req 1.4/1.5/1.7; store-read failures tolerated per Req 1.8). Legacy synchronous env-only `parseOrchestrationConfig` (and `EXTERNAL_MODE_NO_PROVIDER` throw path) retained only in `src/deployment/index.ts` for pure-env callers + existing tests/property tests (e.g. `tests/deployment.test.ts:247` and `tests/deployment.test.ts:414`). Property tests for Req 1 / boot-tolerant resolution + local default + warnings: `tests/orchestrationConfigResolution.property.test.ts`, `tests/startupWarningEnvKeyNaming.property.test.ts`, `tests/orchestrationModeInvalidHalt.property.test.ts`, `tests/defaultLocalModeResolution.property.test.ts`. See `.kiro/specs/cloud-capable-transition/requirements.md` Requirement 1 (Boot-Tolerant Startup Validation) ACs 1-8 + 9.5. (Historical root cause/plan retained below for audit trail.)

- **Source:** User report / startup validation audit.
- **Severity:** High usability/onboarding blocker.
- **Root cause:** When `ORCHESTRATOR_MODE=external`, the server runs a fail-fast synchronous check `parseOrchestrationConfig(process.env)` at startup. This check only reads variables from `process.env` (loaded from `.env`). It does not look at the persisted UI provider store (`.rector/providers.json` & `.rector/secrets.enc`), which is loaded asynchronously later. If the user only sets up their credentials in the browser UI (which writes to the JSON and encrypted key files) but leaves the `.env` variables blank, Rector fails to boot with `EXTERNAL_MODE_NO_PROVIDER`.
- **Plan:** (Resolved on live boot path; legacy parser retained for pure-env/tests only. See traceability above.) Fix the startup sequencing so the fail-fast orchestration mode parser either integrates the persisted UI configuration asynchronously, or clearly document that to run in `external` mode, at least one provider's environment variables must be populated in `.env` as a bootstrap signal even if UI-based overrides are configured. (Historical plan text retained for audit trail.)

### Dependency audit: vitest major-upgrade vulnerabilities deferred (require maintainer approval)

- **Source:** `npm audit` during the `dependency-security-triage` spec; see `docs/security/dependency-audit-2026-06-04.md`.
- **Severity:** Was 1 critical + 3 moderate (dev-tooling only).
- **Status:** **RESOLVED** (Chunk 37). Upgraded to `vitest@4.1.8`; `npm audit` reports **0 vulnerabilities**. Full suite green (1369+ tests). `persistentStore` property test given explicit 120s timeout for Vitest 4 / slow I/O.
- **Traceability:** `docs/plans/chunks/037-vitest-auth-live-memory.md`, `package.json`.

### SLM preprocessor (Chunk 26) adds a new cheap-model call surface before flagship planning in external mode

- **Source:** Chunk 26 (SLM Preprocessor + Structured Tool Calls) implementation.
- **Severity:** Medium (new LLM surface + JSON proposal boundary, but heavily mitigated).
- **Status:** Open.
- **Root cause:** In `runExternalChatRun`, a router-selected cheap/SLM provider is now invoked (via `runSLMPreprocessor`) after context building and before the live planner. It produces `distilledContext` + `proposedToolCalls`. Even though the preprocessor runs `evaluateBudget` + `invokeWithBudget`, forces json_object, validates with Zod, filters tools against a conservative allowlist, and redacts output, this is a new place where model output influences downstream flagship prompts and is visible in traces.
- **Plan / Mitigations (already implemented in this chunk; mitigations implemented; see new gaps below):**
  - Local mode (`runFakeChatRun`) is completely untouched — preprocessor is never called.
  - The preprocessor never throws; every failure path (budget denial, provider error, bad JSON, schema failure) produces a safe deterministic fallback with empty `proposedToolCalls`.
  - Original `prompt` + full `contextPack` are retained and passed to skeptic/crucible/healing/synthesis for cross-validation.
  - `proposedToolCalls` are only *proposals*; they are filtered to `ALLOWED_PREPROCESSOR_TOOLS` and still flow through the full symbolic pipeline (`WorkspaceSandboxAdapter` containment/allowlist/approvals, skeptic, crucible, validation/healing, budget).
  - Usage (if any) is intended to be accounted (Step 1 keeps accounting lightweight; later refinement can commit preprocessor usage explicitly before the planner preflight).
  - Property test (fast-check) asserts that arbitrary bloat always produces schema-valid output with only allowlisted (or zero) tool proposals and no obvious secret leakage.
- **Future work:** Prompt hardening / few-shot examples for the preprocessor, richer usage accounting, optional exposure of preprocessor output in the UI trace drawer, and quality metrics once real cheap providers are exercised. (See new High gap on Chunks 29-32 stubs below.)
- **Traceability:** `docs/plans/chunks/026-slm-preprocessor-structured-tool-calls.md`, `src/orchestration/preprocessor.ts`, `tests/preprocessor.test.ts`, wiring in `src/orchestration/chatRunner.ts`.

### Advanced memory (Chunk 27) introduces new write path (/api/notes) and pruning logic in the store

- **Source:** Chunk 27 (Advanced Memory System / neuro-symbolic Step 2) implementation.
- **Severity:** Medium (new persistent-ish state in local mode, pruning decisions, note capture as user-controlled input).
- **Status:** Open.
- **Root cause:** New MemoryEntry entities (layered working/episodic/core) stored in InMemoryRectorStore (and interface extended for future durable stores). `POST /api/notes` allows quick capture into episodic. `pruneMemory` uses heuristic scoring (recency + access + source bonuses) and can create auto-summaries in core. Time fields (`timestamp`, `lastMentioned`) are injected into ContextPack as natural language phrases. All new paths must respect redaction.
- **Plan / Mitigations (implemented in this chunk; mitigations implemented; see new gaps below):**
  - Local/in-memory baseline only; no new network or paid services required (Chroma/Mem0/TiDB stubs or future adapters follow existing pattern).
  - All memory content goes through `redactString` on note creation and search results are simple keyword for alpha.
  - Prune is bounded (`maxEntries`) and opportunistic on note writes; high-value items (user notes, high access) are protected by scoring.
  - Time context is derived client-side in buildContextPack (no external clock dependency beyond store `now`).
  - Existing ContextPack consumers (preprocessor, planner, skeptic) see additive `memoryContext` field; original paths unchanged.
  - Tests include pruning invariants and time fields.
- **Future work:** Real vector similarity in prune/search when Chroma or Mem0 adapters are activated (using stack credits); durable memory entities in sql/tidb stores; full ponder swarm (Step 6) that reads/writes this memory; UI for captured notes; retention policies per layer.
- **Traceability:** `docs/plans/chunks/027-advanced-memory-system.md`, `src/store/schemas.ts` (MemoryEntry), `src/store/inMemoryRectorStore.ts` (impl + prune), `src/api/server.ts` (/api/notes + context enrichment), `src/orchestration/contextBuilder.ts` (time-aware injection), `tests/memoryAdvanced.test.ts`. (See new High gap on RectorStore memory methods + 034 plan below.)

### Proactive alive layer (Chunk 28) adds timer-driven and on-demand message initiation

- **Source:** Chunk 28 (Proactive / "Alive" Layer / neuro-symbolic Step 3).
- **Severity:** Low-Medium (new initiation path, potential for unwanted messages if timer misconfigured).
- **Status:** Open.
- **Root cause:** New ProactiveAgent that can call runChat with synthetic prompts using "proactive-companion" route and marks resulting assistant messages with source "proactive". Timer is strictly guarded (only external mode, long interval). Synthetic messages go through full budget/redaction/pipeline.
- **Plan / Mitigations:** (mitigations implemented; see new gaps below)
  - Local mode: agent is never instantiated with timer (startTimer is a no-op).
  - All proactive LLM calls (if router present) are budget-gated and redacted.
  - Dev trigger endpoint /api/dev/proactive-trigger is behind dev guard (similar to /api/dev/scenario).
  - Source field added as optional to Message (no breakage to existing creates/updates/tests).
  - Reuses existing runChat pipeline so all symbolic controls (skeptic, crucible, healing, sandbox) apply.
- **Future work:** Event-driven triggers (e.g. on long NEEDS_DECISION from memory), better frequency control using memory, UI badge using the source field.
- **Traceability:** `docs/plans/chunks/028-proactive-alive-layer.md`, `src/proactive/proactiveAgent.ts`, wiring in `src/api/server.ts`, `tests/proactive.test.ts`, schema extension in `src/store/schemas.ts`. (See new High gap on Chunks 29-32 stubs below.)

### Doc cleanup and vision shift (Chunk 33) + Cloud-capable transition

- **Source:** Direction change from lightweight local alpha MVP to hassle-free, web-UI-configurable cloud-capable VPS product (with pluggable memory providers: local/Mem0/TiDB/etc.).
- **Severity:** Medium (documentation debt, potential contributor confusion during transition; increased emphasis on UI surfaces for config may expand attack surface or complexity for pluggable backends).
- **Status:** Open / in progress.
- **Root cause:** Many docs, AGENTS.md, README, roadmap, architecture, .env, etc., were written for "v0.1.0-alpha local developer preview" as the target. The cloud-capable-transition .kiro spec exists but was not fully reflected in main docs. New requirement for non-rigid architecture + full UI config for memory DB providers adds pluggability needs beyond current persistence driver.
- **Plan / Mitigations:**
  - Created Chunk 33 plan + inventory (`docs/stale-docs-inventory.md`).
  - Updated AGENTS.md, root README, docs/README, added banners to historical architecture/deployment docs, aligned .env.example comments to prefer UI config and note pluggable memory vision.
  - Local baseline language preserved where it is factually a regression requirement.
  - Future cloud chunks will extend UI-managed config pattern (already used for providers) to memory/persistence backends.
  - Non-rigid design: avoid hard dependencies; use adapters/interfaces for memory providers.
- **Future work:** Complete remaining items from .kiro/cloud-capable-transition (E2B, synthesizer streaming, TiDB, etc.), adapted for hassle-free UI memory config (e.g. new MemoryProvider config store + UI flows, adapters for Mem0/TiDB/local). Update more docs, add cloud quickstart. Verify no breakage to local tests. Partial progress via 033 (see cross-ref); see new Medium/Low-Medium gaps + 034 plan below for pluggable memory + vision lag.
- **Traceability:** `docs/plans/chunks/033-stale-doc-cleanup-vision-alignment.md`, `docs/stale-docs-inventory.md`, edits to AGENTS.md/README/docs/README/etc., `.kiro/specs/cloud-capable-transition/`. (See 034 plan `docs/plans/chunks/034-ui-configurable-memory-providers.md`.)

### New risk from user vision: Pluggable memory providers via UI

- **Source:** User requirement for hassle-free configuration of agent memory database (local or Mem0/TiDB cloud) entirely through web UI, non-rigid architecture.
- **Severity:** Medium (expands config surface; requires careful abstraction so local baseline isn't affected; potential for misconfiguration leading to data loss or cost in cloud backends).
- **Status:** Partially resolved (Chunks 34–36). Settings API + UI panel + setup wizard readiness shipped in Chunk 36; live cloud adapter tuning and migration UX remain open.
- **Root cause:** Current persistence is driven by RECTOR_PERSISTENCE + env / createRectorStore (memory/sqlite/tidb). Memory is layered on top (truth library + new hierarchical in-memory from 27). No UI-managed "MemoryProvider" equivalent to Provider_Config_Store yet. Adding Mem0 (external) or switching TiDB etc. via UI increases the need for runtime pluggable adapters, secure secret handling for cloud memory, and UI validation.
- **Plan / Mitigations (to be implemented in follow-on chunks; partial status from 033/transition + 034 plan in progress; see new audit gaps below):**
  - Extend the UI config pattern (non-secret records + encrypted secrets) to memory backends.
  - Create adapter interface for memory providers (local implementations + Mem0 client, TiDB-backed, etc.).
  - All config changes via Settings_API; local mode never uses external memory providers.
  - Redaction, budget (if applicable for cloud memory), and migration paths for data.
  - Keep in-memory/SQLite as zero-config local defaults.
  - Update neuro memory code (from 27) to work behind the pluggable layer.
- **Traceability:** This entry + future chunks after 033; reference in cloud-capable-transition adaptation. Use stack credits (Mem0, TiDB, Chroma) for optional adapters.
 (Cross-ref `docs/plans/chunks/034-ui-configurable-memory-providers.md`; see new High gap on RectorStore memory methods + Medium vision lag gap below.)

**Chunk 35 progress:** Real external memory adapters + neuro-symbolic wiring (see `docs/plans/chunks/035-durable-memory-neuro-symbolic-wiring.md`):
- Mem0/TiDB/Chroma `MemoryProvider` adapters with lazy optional deps, budget preflight, bridge factory (`src/memory/*Adapter.ts`, `src/providers/memoryBridge.ts`).
- Boot migration wired; store injection avoids double init.
- Neuro steps 4–7 wired in external pipeline (symbolic, deepPlanning, decomposition, ponder hooks).
- Optional `npm install mem0ai chromadb` for live cloud memory; build/tests pass without them.
- Ponder background jobs: budget-gated, 2h idle timer, fire-and-forget on run complete — monitor latency/cost in production.

**Chunk 34 progress (post-audit):** Core pluggable layer implemented and wired:
- MemoryConfigStore + schemas + local atomic + in-memory double (src/providers/memoryConfig*.ts) mirroring the Provider_Config_Store pattern exactly.
- MemoryProvider interface + LocalMemoryProvider (faithful reproduction of Chunk 27 inmem logic + sqlite-mem delegation using the backfilled sql methods) + external adapters (Chunk 35; stubs retained as unknown-kind fallback only).
- Bridge with local-mode guards, secret reuse (prefixed), graceful fallback (src/providers/memoryBridge.ts).
- Real bootstrap now always creates + passes memoryConfigStore (bin/server.ts); createApp resolves active provider (always a provider, default local-inmemory when omitted or local mode).
- Neuro call sites (chat context searchMemory for episodic, /api/notes create+prune) now go through activeMemoryProvider.
- Default path verified identical: memoryAdvanced.test.ts + new memoryConfigStore.test.ts green; build clean; the providerConfigApi harness was updated (await for async createApp) as part of fixing failures surfaced by the wiring.
- Chunk 36 completed the Settings API (`/api/memory-providers` CRUD + test-connection) and the settings UI memory-provider panel (cards, active toggle, secret-presence-only, test-connection). Setup status/wizard now surfaces memory-provider readiness.
- Local baseline preserved (pure local-inmemory default, zero net, identical outputs for all pre-34 memory features).
See the refined 034 plan doc for details + verification steps. The "RectorStore memory methods" High gap (now RESOLVED) was a prerequisite that enabled safe durable + pluggable memory.

### Chat store is in-memory and resets on restart

- **Source:** Chunk 6 worker/reviewer.
- **Severity:** Expected prototype limitation.
- **Status:** Open until MongoDB/local durable store adapter chunk.
- **Plan:** Keep documented. Replace/augment with durable store in later persistence/provider chunks.

**CI spy baseline (v0.3.0 Req 9):** `npm test` uses in-memory stores and `SpyLLMProvider` doubles — not a user-facing provider-free product path. Real installs use SQLite persistence and configured orchestration per `configured-product-architecture.md`. 

**External / Cloud paths (partially advanced by transition: E2B gated, live gated synth, SSE, boot-tolerant, discovery full, etc.):** See updates below for sandbox/synthesizer/streaming/startup (and cross-refs in new gaps + roadmap section). Startup item resolved (see top of Open). 

### Chat run progress is polling/list only, no SSE/WebSocket

- **Source:** Chunk 6 worker.
- **Severity:** Product UX limitation.
- **Status:** Open.
- **Plan:** Add streaming/SSE in a future chat UX chunk after state/events stabilize.
 (Updated: SSE events + early 202 for ?stream=1 now implemented on External path in `src/api/server.ts:1332` (runChatPipeline + registerRunStreamRoute + broker-wrapped store); polling preserved as fallback. Full answer streaming still gated.)

### Chat synthesis is deterministic trace summary, not semantic answer generation

- **Source:** Chunk 15 implementation.
- **Severity:** Medium product limitation.
- **Status:** Open until provider-backed/local-model synthesis chunks.
- **Plan:** Current final assistant response summarizes local trace evidence from triage/context/planning/review/arbitration/DAG/execution/validation/healing without provider calls. It is safe and testable for alpha brainstem proof, but it does not yet generate rich task-specific prose, cite real external sources, or explain code changes from actual filesystem execution.
 (Updated status: `src/orchestration/synthesizer.ts:56` (synthesizeChatBrainstemResponse + legacyStatusResponse for default/heavy routes), `selectResponseText:91`, `runLiveSynthesizer:401` (gated live flagship prose for Heavy_Developer_Routes in external when router + budget allow; falls back to deterministic Legacy_Status_Response per Req 7.4/7.5). Local always deterministic/0 calls (Req 9). Partial progress on cloud path; see 034 + new gaps.)

### Store list ordering relies on insertion order

- **Source:** Chunk 4 GLM review.
- **Severity:** Low.
- **Status:** Accepted for in-memory prototype.
- **Plan:** Production/durable store should sort explicitly by `createdAt` where UX requires chronological order.

### Store deletes are shallow and do not cascade

- **Source:** Chunk 4 GLM review.
- **Severity:** Low.
- **Status:** Documented in code.
- **Plan:** Production store should define cascade/retention policy explicitly.

### RunEvent IDs require uniqueness across distributed systems

- **Source:** Chunk 5 GLM review.
- **Severity:** Low in local mode, higher in distributed mode.
- **Status:** Mitigated locally with duplicate rejection and random UUID default.
- **Plan:** Production stores must enforce unique event IDs and transaction/conditional-write semantics.

### Security controls are local-process baselines only

- **Source:** Chunk 7 implementation; Gemini final audit.
- **Severity:** Medium for production deployment.
- **Status:** Open.
- **Plan:** Replace in-memory rate limiting with shared/distributed limiter, add real auth/session enforcement, centralize budget enforcement at provider call boundaries, and continue hardening redaction with structured secret classifiers before public multi-user deployment. Confirmed camelCase secret-key and username-only URI redaction gaps were fixed after final audit with regression tests.

### In-memory rate limiter is local-only and requires distributed backend in production

- **Source:** Chunk 7 review fixes.
- **Severity:** Low for local-MVP, High for multi-instance production.
- **Status:** Mitigated locally via opportunistic expiry cleanup in middleware.
- **Plan:** The current rate limiter uses an in-memory `Map` with opportunistic cleaning of expired buckets on each request. While this prevents unbounded memory growth locally, a production-grade deployment with multiple API instances requires a distributed rate limiter (e.g. Redis, Memcached, or Cloudflare KV/Durable Objects) to enforce rate limits consistently across instances and prevent local `Map` memory overhead under high concurrency.

### Triage and context builder are deterministic placeholders

- **Source:** Chunk 8 implementation.
- **Severity:** Medium product limitation.
- **Status:** Open until planner/provider orchestration chunks replace or augment the baseline.
- **Plan:** Current routing uses local keyword heuristics and placeholder provider/tool/doc/memory inventories. It is safe for the no-provider chat shell, but production routing should add learned/LLM-assisted classification, confidence calibration, workspace-aware tool/provider inventory, and retrieval-backed docs/memory selection.

### Oversized context artifacts are in-memory only

- **Source:** Chunk 8 implementation.
- **Severity:** Low for local-MVP, Medium for longer sessions or restart durability.
- **Status:** Open until durable artifact storage chunk.
- **Plan:** Context packs omit raw oversized content and reference artifact handles, but artifact records are still stored only in `InMemoryRectorStore` metadata and reset on restart. Current in-memory artifacts keep raw oversized content in `artifact.metadata.content`; durable stores must separate blob content from metadata and define retention, access controls, redaction, and encryption before production use.

### Planner is deterministic fake and does not execute or optimize plans

- **Source:** Chunk 9 implementation.
- **Severity:** Medium product limitation.
- **Status:** Open until crucible/DAG/provider chunks replace the fake planner shell.
- **Plan:** Current planner validates schema shape, route-specific task templates, validation coverage, and unsafe approval gates. It does not use LLM reasoning, workspace-aware dependency analysis, real tool availability, or execution DAG compilation yet.

### Skeptic review is heuristic-only

- **Source:** Chunk 10 implementation.
- **Severity:** Medium product limitation.
- **Status:** Open until provider-backed review chunks.
- **Plan:** Current skeptic review deterministically checks validation coverage, dangling dependencies, approval gates, empty-task clarification, absent context references, and low-risk underestimates. It does not perform semantic plan critique, real filesystem/API existence checks, exploit analysis, or multi-reviewer consensus yet.

### Crucible arbitration is deterministic and does not repair plans

- **Source:** Chunk 11 implementation.
- **Severity:** Medium product limitation.
- **Status:** Open until planner revision/healing/provider-backed arbitration chunks.
- **Plan:** Current Crucible accepts sound plans, blocks blocker findings, requests targeted revisions, and escalates after two rounds. It does not mutate plans, invoke alternate reviewers, run external validation, or automatically produce revised planner output yet.

### DAG compiler emits safe local metadata, not executable sandbox policies

- **Source:** Chunk 12 implementation.
- **Severity:** Medium production-hardening limitation.
- **Status:** Partially mitigated by Chunk 13 simulator; still open for real execution.
- **Plan:** Current DAG compilation is deterministic and denies unsafe shell permissions by default, and the Chunk 13 fake executor enforces shell denial in the simulated path. Real provider/tool execution must still enforce these policies at sandbox/tool boundaries, define real sandbox capabilities, prevent metadata drift from granting shell/file access, and harden `budgetPolicy` merging so caller-provided overrides cannot weaken local/default limits without explicit approval.

### Executor simulator is deterministic fake execution only

- **Source:** Chunk 13 implementation.
- **Severity:** Medium product/prod limitation.
- **Status:** Open until real sandbox/provider executor chunks.
- **Plan:** The executor simulator runs in memory, never calls shell/providers, and only compares deterministic metadata for retries, dependency blocking, timeout, and unsafe shell denial. Production execution still needs sandbox isolation, durable execution logs, cancellation, real timeout enforcement, tool allowlists, filesystem/network controls, and provider budget enforcement at call boundaries.

### Validation/healing loop replays the whole fake DAG

- **Source:** Chunk 14 implementation.
- **Severity:** Medium product/prod limitation.
- **Status:** Open until real executor/healing chunks.
- **Plan:** The alpha healing loop is deterministic, bounded, provider-free, shell-free, and safe for local simulation. It heals only transient/timeout simulator failures by re-running the DAG with adjusted simulator options. Real execution needs node-level replay, artifact isolation/rollback, durable attempt records, richer failure taxonomy, human decision UX for permission/destructive actions, and real timeout/root-cause diagnostics.

### Observability baseline is in-memory/no-op only

- **Source:** Chunk 16 implementation.
- **Severity:** Low for local alpha, Medium for production operations.
- **Status:** Open until durable telemetry/provider integrations.
- **Plan:** Current traces, spans, latency, and cost/model-call counters are process-local and reset on restart. Sentry/PostHog/OpenTelemetry adapters are explicit no-ops with no network calls. Production/provider chunks must add durable/exportable traces, bounded retention, redaction review for telemetry payloads, real token/model/cost metering at provider call boundaries, sampling, and SDK-backed adapters.

### Provider adapter layer Phase 1 is not live-provider production ready

- **Source:** Chunk 17 implementation.
- **Severity:** Medium product/prod limitation.
- **Status:** Open until later provider/runtime hardening chunks.
- **Plan:** Phase 1 defines LLM contracts, deterministic fake local provider, router, budget gate, and a Together AI request/config adapter with network calls disabled by default. Token/cost estimates are approximate, Together live calls require explicit opt-in and mocked tests, provider selection is heuristic, and chat brainstem wiring still defaults to fake/local. Before production/provider-backed flows, add exact provider pricing metadata, robust response/error taxonomy, retry/backoff policy, redaction at provider payload boundaries, streaming/tool-call handling, durable usage accounting, and broader adapter contract tests.

### Budget approval is hard-blocked until approval UX exists (NEEDS_DECISION)

- **Source:** Chunk 17 polish review.
- **Severity:** Medium product limitation.
- **Status:** Open / NEEDS_DECISION.
- **Plan:** While budget limits are correctly evaluated at the provider call boundary, any request exceeding budget or requiring manual human approval is hard-blocked because the corresponding approval interactive UX (user-in-the-loop permissioning) does not yet exist. This needs a product/architecture decision on how human approval responses are solicited, formatted, and injected back into the execution flow.

### Provider adapter layer Phase 2 remains opt-in and not production hardened

- **Source:** Chunk 18 implementation.
- **Severity:** Medium product/prod limitation.
- **Status:** Open until provider runtime hardening and chat integration chunks.
- **Plan:** Cloudflare Workers AI, Azure OpenAI, and Perplexity adapters now have config validation, request builders, mocked response parsing tests, budget-gated invocation compatibility, route-based router selection, and network-disabled-by-default behavior. They are still optional adapters with approximate token/cost estimates, no streaming/tool calls, no retry/backoff/circuit breaker policy, no provider-side redaction audit beyond existing baseline utilities, and no live-provider CI. Production flows must add exact pricing/version metadata, richer provider error normalization, retry/backoff, timeout controls, redaction at payload boundaries, durable usage accounting, and explicit user approval UX before enabling live calls broadly.

### Truth library is in-memory keyword retrieval only

- **Source:** Chunk 19 implementation.
- **Severity:** Low for local alpha, Medium for production knowledge workflows.
- **Status:** Open until durable memory/search/provider integrations.
- **Plan:** Current truth library is provider-free and process-local. It validates TRUSTED/UNVERIFIED/REJECTED status, provenance, and citations; excludes rejected items by default; and uses deterministic keyword scoring. It does not provide durable persistence, embeddings, semantic ranking, access controls beyond in-process callers, citation freshness checks, or Chroma/Algolia network integrations. Production memory/search must add durable storage, retention/deletion policy, permission filtering, redaction review for stored content, semantic retrieval, and explicit trust-review workflows before enabling shared or hosted use.

### Public extension contracts have no loader or isolation

- **Source:** Chunk 20 implementation.
- **Severity:** Low for local alpha, Medium for production extension ecosystems.
- **Status:** Open until extension runtime/security hardening.
- **Plan:** Current public extension contracts define typed schemas, manifests, API version compatibility, and no-network sample interfaces only. Rector does not yet load third-party packages, verify signatures, isolate extension code, enforce runtime permissions beyond schema-level `networkAccess: false`/`networkCalls: 0`, or provide a durable extension registry. Production extension support must add explicit permission grants, sandboxing/isolation, provenance/signing, version negotiation, revocation, audit logging, and network/file-system policy enforcement before accepting untrusted extensions.

### Operator console API is local-only and unauthenticated

- **Source:** Chunk 21 implementation.
- **Severity:** Low for local alpha, High if exposed beyond localhost/trusted dev networks.
- **Status:** Open until production operator access controls and real control-plane semantics exist.
- **Plan:** Current `/api/operator/*` endpoints are explicitly marked `localOnly: true` / `auth: local-only-no-auth`, use the in-memory store, expose run/event/cost/artifact metadata for optional Retool consumption, keep retry/abort/approval decisions as non-mutating placeholders, and stub Linear issue creation with zero network calls. Final audit found the dev server implicitly bound to all interfaces; bootstrap now defaults to `127.0.0.1` via `HOST`. Before any hosted or shared deployment, add authentication, authorization/RBAC, CSRF/origin hardening, audit logs, durable persistence, real approval/retry/abort semantics, artifact access controls, and a real Linear adapter behind explicit env/budget gates.

### Safe code execution is contract-only and not an isolation boundary

- **Source:** Chunk 22 implementation.
- **Severity:** Low for local deterministic alpha, High if mistaken for production sandboxing.
- **Status:** Open until real sandbox isolation and approval UX exist.
- **Plan:** Current safe code execution adds typed sandbox contracts, a hardened local allowlist, patch artifacts, file-write approval metadata, and E2B/Depot no-network stubs. It intentionally does not run arbitrary shell, apply patches, isolate processes, enforce OS/container controls, or call cloud sandboxes. Production execution still needs real sandbox isolation, filesystem/network policy enforcement, durable audit logs, patch application/rollback, human approval UX, timeout/cancellation controls, and live E2B/Depot adapters behind explicit budget/env/user approval gates.

### External workflow integrations are contract/stub-only and network-disabled

- **Source:** Chunk 23 implementation.
- **Severity:** Low for local alpha, Medium for production/operator workflows.
- **Status:** Open until workflow approvals, durable audit logging, and live integration hardening exist.
- **Plan:** Current Linear and Make integrations provide typed payload schemas, config validation, request builders, and default network-disabled invocation gates. Requestly and BrowserStack are docs-only plan stubs with zero network calls. Note that Linear's integration maps escalation `labels` directly to `labelIds`, which are provider-specific UUIDs rather than human-readable text display labels; string display label resolution is deferred to a future iteration. Production use still needs explicit user/operator approval UX, authentication/RBAC for workflow actions, durable audit logs, webhook signature verification, retry/backoff/idempotency, provider error normalization, rate limiting, secret management, and live-provider CI isolated from local contributor tests.

### Deployment prototype is config/docs only and not production hosting

- **Source:** Chunk 24 implementation.
- **Severity:** Low for local alpha, High if treated as production deployment readiness.
- **Status:** Open until hosted alpha hardening exists.
- **Plan:** Current deployment support validates/redacts env config, documents Heroku/Cloudflare shapes, and installs graceful HTTP shutdown. It does not provision infrastructure, connect MongoDB/Redis/Chroma, configure real Sentry/PostHog SDKs, define release pipelines, add auth/RBAC, run migrations, enforce TLS/origin policy, or provide production health checks/rollback. Before any hosted/shared deployment, add secret management, durable adapters, CI/CD, infrastructure-as-code, migration/backup policy, runtime health checks, telemetry SDK wiring, and security review.

### Contributor issue drafts can drift from the roadmap

- **Source:** Chunk 25 implementation.
- **Severity:** Low for local alpha, Medium for contributor coordination if stale.
- **Status:** Partially mitigated — drift checks now enforced in CI; GitHub/Linear sync still manual.
- **Plan:** The issue catalog and generated Markdown drafts are deterministic and checked by `node scripts/generate-roadmap-issues.js --check`. As of the `ci-release-workflow` spec, this drift check runs as a required gate in GitHub Actions (`.github/workflows/ci.yml`) on Node 22 and Node 24, so catalog drift now fails CI. A deterministic, provider-free Linear export (`node scripts/export-linear-issues.js`, output under `docs/issues/linear/`) is also generated from the same catalog and drift-checked in CI, giving maintainers import-ready CSV/JSON without any network calls or credentials. The drafts are still not automatically derived from the roadmap text and are not pushed to GitHub or Linear automatically; an API-based importer would require `LINEAR_API_KEY` and a team id and remains deferred behind explicit maintainer approval. When roadmap chunks change, maintainers must update `docs/issues/roadmap-issues.json`, regenerate docs and the Linear export, and run the check commands.

### Safe local sandbox execution uses a dummy mock runner

- **Source:** Codebase audit.
- **Severity:** High (imminent commercial product blocker).
- **Status:** Open.
- **Root cause:** The `WorkspaceSandboxAdapter` executes allowlisted commands via `defaultCommandRunner` which is a dummy mockup returning `${[command, ...args].join(" ").trim()} completed`. It does not spawn any real child processes or apply actual unified patches, meaning code execution and validation is currently a local simulation rather than actual execution.
- **Plan:** (Local baseline intentionally preserved per Req 9 / cloud design in `src/sandbox/index.ts:622` (defaultCommandRunner) + `WorkspaceSandboxAdapter`.) External/Cloud path partially advanced: real E2B wired + gated (key from Secret_Store or E2B_API_KEY fallback) in `src/bin/server.ts:174` (buildStartupSandboxAdapter) + `src/sandbox/e2bSandboxAdapter.ts` (real client + runCommandInContainer when key present; reuses Workspace as gateway for local-only ops). See new High gap (RectorStore memory methods + 034) + roadmap item 3. Dummy/local stub remains for regression baseline + when no E2B key.

### Sandbox stubs deny cloud execution by default

- **Source:** Codebase audit.
- **Severity:** Medium.
- **Status:** Open.
- **Root cause:** The E2B and Depot adapters in `src/sandbox/index.ts` are completely stubbed out. Invoking them throws a `SANDBOX_PROVIDER_STUB_NO_NETWORK` denial error.
- **Plan:** (Updated: stubs largely replaced by real E2B adapter per above; still gated on config/key per Req 6.1/6.7. Local path + no-key external degrade to the network-free WorkspaceSandboxAdapter/dummy. See `src/sandbox/e2bSandboxAdapter.ts:131` and bin/server.ts wiring. Full UI config + key injection in later 034+ work.)

### Developer-oriented triage routes fall back to diagnostic traces instead of LLM prose

- **Source:** Codebase audit.
- **Severity:** Medium.
- **Status:** Open.
- **Root cause:** In `src/orchestration/synthesizer.ts`, all developer routes (`RESEARCH`, `CODE_EDIT`, `PLAN_ONLY`, `LONG_RUNNING`) default to returning `legacyStatusResponse` which formats diagnostic execution summaries (e.g. `Status: ... Observed: ...`) instead of calling the LLM router to formulate a rich prose response.
- **Plan:** (Updated: live path now exists and is gated in `runLiveSynthesizer` + `src/orchestration/synthesizer.ts:401` (and selectResponseText); heavy dev routes fall back to legacy per Req 7.4/7.5 when no router/key/budget or in local. Streaming events partial (see above). See roadmap item 4 + new gaps.)

### Linear workflow integration relies on raw string display labels instead of UUIDs

- **Source:** Codebase audit / workflows inspection.
- **Severity:** Low.
- **Status:** Open.
- **Root cause:** The Linear integration adapter maps raw string display labels (e.g. `["bug", "rector"]`) directly to GraphQL variables `labelIds`. In the Linear API, label IDs are unique team-specific UUIDs. Passing raw string labels will cause mutation errors.
- **Plan:** Implement a pre-flight resolver query to fetch the team's label catalog and map human-readable names to their corresponding UUIDs.

### Telemetry integrations are all inert no-ops

- **Source:** Codebase audit.
- **Severity:** Low.
- **Status:** Open.
- **Root cause:** Although Sentry, PostHog, and OpenTelemetry adapters are defined in the schema and config check, their runtime implementations are inert mocks that perform no network I/O.
- **Plan:** Configure and initialize the actual Sentry Node SDK and PostHog Node SDK in `src/observability` behind user configuration toggles.

### RectorStore memory methods missing from sql/tidb implementations (Chunk 27 interface extension incomplete)

- **Status:** RESOLVED (implementation backfill landed; durable memory surface now present for sqlite/TiDB paths).
- **Traceability (post-audit fix):** `src/store/sqlRectorStore.ts:512` (createMemoryEntry), `531` (listMemoryEntries), `555` (searchMemory), `578` (pruneMemory) — full impls matching InMemoryRectorStore semantics + MemoryEntrySchema roundtrips. `src/store/index.ts:283` (`verifyStartupTables` now calls `listMemoryEntries()`), `209` (`STARTUP_MIGRATION_TABLES` includes "memories"). `src/api/server.ts:1294` (unconditional `searchMemory` for episodic context in runChatPipeline) + note create/prune on /api/notes now safe for all drivers returned by createRectorStore. Test updates: `tests/buildSmokeVerification.test.ts` (ENTITY_TABLES/assertions 5→6), `tests/tidbStartupMigration.integration.test.ts` (comments/names), budget accounting realign in byokExternalE2E + chatRunner tests for the preprocessor cheap call. Full suite: 192 files / 1241 tests passing + `npm run build` green after the fixes (see user's "Walkthrough - Test Suite Fixes and Commits" + commits e06861a0 + chore neuro chunks). The original crash risk for durable + neuro 27 (notes, time-aware context for preprocessor/planner) is eliminated.
- **Source:** Full system audit (server + store wiring + createRectorStore tests) + post-fix verification.
- **Severity:** High (was blocking durable/TiDB VPS + 034 pluggable memory).
- **Root cause:** (Historical — retained for audit trail) `RectorStore` interface in `src/store/index.ts:74` (post-Chunk 27) declares `createMemoryEntry`/`searchMemory`/`pruneMemory` + siblings. Only `InMemoryRectorStore` implements them (src/store/inMemoryRectorStore.ts:309+). `SqlRectorStore` (used for both sqlite + tidb via `createRectorStore` in src/store/index.ts:164 and src/api/server.ts:1155) has no implementations (file ends after artifacts without the methods). `src/api/server.ts:1284` (chat runChatPipeline, unconditional `searchMemory` for episodic injection into contextPack) + `src/api/server.ts:1420` (/api/notes POST, unconditional `createMemoryEntry` + `pruneMemory`) + proactive + other call sites will crash (or fail to type) on any durable/persistent driver. `runStartupMigration` + TiDB path (and 034 MemoryProvider abstraction) blocked. createRectorStore tests (persistentStore.test.ts etc.) do not cover the advanced memory surface for sql/tidb.
- **Plan / Mitigations:** Backfill completed (see traceability). Long-term: proper MemoryProvider abstraction + pluggable impls for hassle-free UI selection (local in-memory/SQLite vs. Mem0/TiDB cloud etc.) per user vision and 034 plan `docs/plans/chunks/034-ui-configurable-memory-providers.md`; keep in-memory as local baseline (Req 9 / cloud design). Add durable memory roundtrip/prune/search property tests if not already expanded in the 1241-test baseline. Do not assume all stores are equivalent until the abstraction layer lands. (See also TiDB migration wire item below and neuro 29-32 item.)

### Neuro-symbolic chunks 29-32 (symbolic engine, deep planner, ponder swarm, task decomposer) are dead/unwired stubs with zero callsites in main pipeline

- **Source:** Full system audit (orchestration/chat wiring + src/orchestration/index.ts + chunk plans).
- **Severity:** High (was blocking "alive" usability goal from AGENTS.md + neuro vision).
- **Status:** **RESOLVED** (Chunk 35).
- **Resolution (Chunk 35):** Wired into external chat pipeline: symbolic tool validation in preprocessor + healing hints; opt-in `deepPlanning` → `runDeepPlanner`; high-complexity `decomposeIntoTasks` + concurrent sandbox execution; `createNeuroBackgroundHooks` for ponder/subconscious (external mode). Local `runFakeChatRun` path unchanged. Tests: symbolicEngine, preprocessorSymbolic, deepPlanner, taskDecomposer, ponderSwarm, backgroundHooks + E2E regression green.
- **Remaining limitations:** `memoryContext` time phrases still not in all LLM prompts; ponder uses fixed 2h idle timer (not event-driven); task decomposition is alpha heuristic (max 4 sub-goals).
- **Traceability:** `docs/plans/chunks/035-durable-memory-neuro-symbolic-wiring.md`, commits `6da4800`, `b4c2181`.

### TiDB Startup_Migration (with 30s deadline + verify + redacted halt) fully coded but not invoked on live boot path (bin/server.ts + createApp)

- **Source:** Full system audit (store/index.ts vs. bin/server.ts + api/server.ts).
- **Severity:** Medium (was blocking TiDB path per Req 8 on live boot).
- **Status:** **RESOLVED** (Chunk 35).
- **Resolution (Chunk 35):** `src/bin/server.ts` bootstrap awaits `runStartupMigration` for `sqlite`/`tidb` drivers; passes pre-migrated store via `ApiSecurityOptions.store`; memory driver skips migration (Req 9). `tests/startupMigrationBoot.test.ts` + deadline timeout test added.
- **Traceability:** commit `c212b89`, `docs/plans/chunks/035-durable-memory-neuro-symbolic-wiring.md`.

### pruneMemory heuristic is non-deterministic (Date.now()) and only opportunistic; missing property tests for survival invariants

- **Source:** Full system audit (inMemoryRectorStore + memoryAdvanced.test.ts).
- **Severity:** Medium.
- **Status:** **RESOLVED** for survival-invariant property coverage (Chunk 036 Wave 1D). Opportunistic `Date.now()` scoring remains an accepted alpha limitation.
- **Resolution (Chunk 036):** `tests/memoryPrune.property.test.ts` adds fast-check properties for maxEntries bounds, user-note survival, high-access survival, and core-summary creation via `LocalMemoryProvider` with injected `now()` clock (deterministic prune semantics).
- **Root cause:** (Historical) `src/store/inMemoryRectorStore.ts:388` (pruneMemory) uses `Date.now() - Date.parse(...)` for recency scoring + opportunistic call only on /api/notes writes (and bounded). Tests (memoryAdvanced.test.ts:62) exercised happy paths but lacked fast-check property tests for survival invariants.
- **Remaining / follow-on:** Consider deterministic clock injection at all prune call sites (not only tests). Tie durable-store prune parity into future pluggable-layer hardening.
- **Traceability:** commit `f0d1209`, `docs/plans/chunks/036-hassle-free-ui-neuro-observability.md`.

### concerns register and some post-033 docs still carry heavy 'alpha prototype / local developer preview' framing; vision lag vs AGENTS + .kiro + user hassle-free UI memory requirement

- **Source:** Full system audit (docs + AGENTS.md + .kiro + 033/034 plans).
- **Severity:** Low-Medium.
- **Status:** Open / partial.
- **Root cause:** Post-033 cleanup (Chunk 33 plan) + banners + AGENTS/README updates done, but many entries here + some roadmap/deployment docs still frame as "local alpha prototype / v0.1.0-alpha local developer preview" as the primary target (vs. current hassle-free UI-configurable cloud/VPS product with pluggable memory per user vision + AGENTS.md + .kiro/specs/cloud-capable-transition/ + 034). Local baseline language is factually required (Req 9) but framing lags.
- **Plan / Mitigations:** Continue 033/034 doc sweeps. Update this register + remaining chunks/docs on each cloud chunk. Cross-ref 034.

## Closed / Mitigated

### Esbuild dev-server advisory resolved via npm overrides (GHSA-67mh-4wv8-2f99)

- **Source:** `npm audit` during branch setup and Gemini final audit; remediated by the `dependency-security-triage` spec.
- **Severity:** Moderate (CVSS 5.3, CWE-346) — esbuild dev server allowed any website to send requests and read responses (DNS-rebinding-style exposure). Dev/test tooling only; never shipped in the `dist` runtime.
- **Fix:** Added an additive npm `overrides` entry to `package.json` forcing `esbuild >=0.28.1`, then regenerated the lockfile with `npm install` (no `npm audit fix --force`, no runtime dependency change). `npm ls esbuild` now resolves every entry to `esbuild@0.28.1` (via both `tsx` and `vitest > vite`), and `npm audit` no longer reports GHSA-67mh-4wv8-2f99. The full verification baseline stayed green after the change: `npm test` 28 files / 278 tests (29 files / 280 tests with the added `tests/dependencySecurity.test.ts` override regression guard), `npm run build` and `npm run check` both succeeded. Chunk 047a reconfirmed the override with `npm test` (260 files / 1624 tests passed, 5 skipped), `npm run build`, and `npm audit` (0 vulnerabilities).
- **Status:** Closed / Mitigated for the esbuild advisory. The remaining `vitest`/`vite`/`@vitest/mocker`/`vite-node` findings (which require a forced `vitest@4` major upgrade) are tracked separately under `## Open` and deferred for maintainer approval.
- **Traceability:** `docs/security/dependency-audit-2026-06-04.md`.

### Fake orchestrator returned placeholder assistant text

- **Source:** Chunk 6 worker; replaced during Chunk 15.
- **Severity:** Expected until brainstem integration.
- **Fix:** Added deterministic synthesis from trace outcomes and wired chat responses to status/route/trace evidence instead of receipt-only placeholder text.
- **Status:** Closed for local alpha brainstem; richer semantic synthesis remains tracked as an open product limitation.

### Non-atomic run update then event append

- **Source:** Chunk 5 GLM review.
- **Severity:** Major.
- **Fix:** Added `commitRunTransition` and updated `transitionRun` to use atomic store method. Added regression tests.
- **Status:** Closed for in-memory store; production adapters must implement equivalent atomicity.

### Stale local-MVP docs could mislead agents/contributors

- **Source:** Chunk 0 reviews; follow-up aggressive doc cleanup audit.
- **Severity:** Major planning risk.
- **Fix:** Removed superseded local-MVP and cloud-heavy planning docs, then updated `docs/README.md`, `docs/architecture/rector-0.1.0-architecture.md`, and `.kiro/steering/docs.md` so current source-of-truth docs are the only active guidance.
- **Status:** Closed.

### Provider resilience retries can add provider spend beyond the initial preflight

- **Source:** Chunk 047f implementation.
- **Severity:** Medium provider/budget risk.
- **Concern:** The resilience wrapper preflights through the existing `invokeWithBudget` call before the first provider invocation, then may perform a bounded 429 retry, auth retry, or fallback substitution inside that call site. Those extra attempts are traced and bounded, but per-attempt budget preflight/accounting should be tightened in a follow-up so retry/fallback spend is projected before each recovery call.
- **Status:** Open follow-up before public alpha billing/quotas.

### Open-source project lacked license/community scaffolding

- **Source:** Chunk 1 scope.
- **Severity:** Release blocker.
- **Fix:** Added Apache-2.0 LICENSE, NOTICE, trademarks, contributing, security, CoC, issue/PR templates.
- **Status:** Closed.

## Cloud-Capable Transition Roadmap

This section documents the transition path from a local-only MVP/simulator to a fully functional commercial cloud product using your active stack credits.

### Integration Matrix & Credit Routing

| Service Layer | Cloud Provider | Credit Allocation | Commercial Role |
| --- | --- | --- | --- |
| **Relational Database** | TiDB Cloud | $2,000 | Stores persistent users, conversations, runs, and events. |
| **Unstructured Store** | MongoDB | $3,600 | Stores temporary cache, runs history, and raw context materials. |
| **LLM Inference (Flagship)** | Azure OpenAI | $5,000 | Flagship reasoning (planning, skeptic review, crucible). |
| **LLM Inference (SLM/Fast)** | Cloudflare Workers AI | $10,000 | Runs open-weight models (Llama 3, Phi 3) for fast execution/triage (prioritized initial provider). |
| **LLM Inference (SLM/Fast)** | Together AI | $15,000 | Alternate fast SLM model provider. |
| **Sandbox Execution** | E2B / Depot | $5,000 | Containerized build, test, and command sandbox execution. |
| **Vector Database** | Chroma | $5,000 | Semantic memory search for the truth library. |
| **Keyword Search** | Algolia | $10,000 | Indexes codebase, documentation, and files. |
| **Secrets Management** | Doppler | 3 months free | Safe injection of credentials, API keys, and environment variables. |
| **Observability (Error)** | Sentry | 1 year / 50K errors | Out-of-band error monitoring and diagnostics. |
| **Observability (Product)** | PostHog | $50,000 | Session recording, usage analytics, and feature flags. |
| **Observability (APM)** | DataDog / New Relic | 2 years | Real-time performance profiling and infrastructure metrics. |
| **Workflow Sync** | Linear / Make | 6 months / 240K calls | Issue tracking, escalation tickets, and notification routing. |
| **Testing** | BrowserStack | 1 parallel / 1 year | Automated browser testing of the frontend chat UI. |

### Architectural Transition Path

To successfully transition Rector to a cloud-ready commercial state, the following implementation order must be pursued:

#### 1. Decouple Config Validation from Boot Sequencing (Fix Startup Catch-22)
* **Goal**: Enable starting Rector in `external` mode when credentials are stored only in the browser database (`providerConfigStore` and `secretStore`) rather than hardcoded in the server environment (`process.env`).
* **Status (post-audit)**: IMPLEMENTED (boot-tolerant path live). See `src/bin/server.ts:223` (resolveStartupOrchestrationConfig), `src/providers/orchestrationConfig.ts:270` (store-aware union + presence-only), property tests, and top resolved item in this register + `.kiro/specs/cloud-capable-transition/requirements.md` Req 1. (Legacy parser retained in deployment/index.ts for tests only.)
* **Implementation**: Modify the server startup block in `src/bin/server.ts` to defer validation of credentials. Check credentials lazily at request time or load them asynchronously from the database at startup, logging a warning rather than crashing with `EXTERNAL_MODE_NO_PROVIDER`.

#### 2. Implement Bring-Your-Own-Key (BYOK) Model Discovery
* **Goal**: Enable users to input their Cloudflare API Token or Together AI API Key and dynamically view and route models.
* **Status (post-audit)**: Partial / advanced in transition work (configBridge, discovery adapters, Settings_API, providerConfigStore + secretStore, route maps). Full UI flows + 034 memory extension pending. See providers/ + api/server.ts.
* **Implementation**: Wire the UI to trigger the `ModelDiscoveryService`. Fetch active models directly from the provider API, and write user preferences (role-to-model mappings) directly to the `.rector/providers.json` config store.

#### 3. Transition from Mock to Real Sandboxed Execution
* **Goal**: Enable executing code patches and shell commands inside containerized environments.
* **Status (post-audit)**: PARTIAL (External/Cloud advanced + gated; local baseline preserved per Req 9). Real E2B adapter implemented + wired when key present (`src/sandbox/e2bSandboxAdapter.ts`, `src/bin/server.ts:174` (buildStartupSandboxAdapter + resolveE2BApiKey)). Local uses `src/sandbox/index.ts:622` (defaultCommandRunner dummy in WorkspaceSandboxAdapter) + SafeLocalSandboxAdapter. See new High gap (RectorStore memory methods + 034) + "Safe local sandbox" item. Full unconditional real execution + UI key config in follow-on.
* **Implementation**: In `src/orchestration/sandboxExecutor.ts`, replace the dummy `defaultCommandRunner` with E2B Node SDK instance calls and Depot image builds to run test suites safely inside micro-containers, enforcing strict timeout and memory limits.

#### 4. Replace Diagnostic Traces with Streamed Assistant Prose
* **Goal**: Return human-like answers rather than execution traces to the user.
* **Status (post-audit)**: PARTIAL (live gated synth + SSE events advanced on cloud path; legacy/deterministic preserved for local + fallbacks per Req 7/9). See `src/orchestration/synthesizer.ts:401` (runLiveSynthesizer + 60s deadline + fallback to legacyStatusResponse), `src/api/server.ts:1332` (SSE ?stream=1 + 202 early + broker events; polling preserved). Heavy dev routes still often legacy. See updated prototype items + new gaps + roadmap item 4 cross-ref in synthesizer.
* **Implementation**: Connect `src/orchestration/synthesizer.ts` to the `ModelRouter` to request a natural language synthesis from the flagship model, instructing it to summarize what was done, what was verified, and what files were modified, referencing the trace drawer metadata only as an option.

#### 5. Implement Vector DB Retrieval and Storage
* **Goal**: Add durable memory storage for truth validation and user preferences.
* **Status (post-audit)**: Not yet (still future per 034 + stack credits). Current memory is Chunk 27 in-memory hierarchical (notes/prune/search/time) + truth library (keyword) behind RectorStore. Blocked on new High gap (RectorStore sql/tidb memory methods missing) + pluggable MemoryProvider work in `docs/plans/chunks/034-ui-configurable-memory-providers.md`. Local baseline + redaction preserved.
* **Implementation**: Upgrade `src/memory/` and the truth library to sync documents and transcripts to Chroma DB, using Algolia to back fast keyword indexes.
