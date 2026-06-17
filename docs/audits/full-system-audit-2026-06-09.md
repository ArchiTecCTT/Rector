# Rector Full System-Wide Audit & Bughunt Report
**Date:** 2026-06-09
**Scope:** concerns-and-vulnerabilities.md resolution + cloud-capable-transition + neuro 26-32 + pluggable/hassle-free UI vision (memory providers) + security + tests + docs alignment. Subagents used for parallel deep dives.
**Executive Summary**

Rector's foundation is solid: the core brainstem (triage through synthesis), provider adapter layer, redaction/security baselines, and chat API vertical remain deterministic and local-provider-free by design. The cloud-capable transition (per `.kiro/specs/cloud-capable-transition/requirements.md`, `tasks.md`, `design.md`) shows substantial progress—boot-tolerant `resolveOrchestrationConfig`, conditional E2B wiring, discovery adapters, Settings_API surfaces, synthesizer gating, and ~40 property tests (Properties 1-40) are in place or hardened, with local-mode invariants (zero network, zero external sandbox, determinism) explicitly enforced and tested. Local/provider-free mode continues as the mandatory identical regression baseline (createRectorStore memory driver default, runFake paths untouched, `npm test`/`build` gates referenced throughout).

However, the neuro-symbolic usability enhancements (chunks 26-32) and the pluggable/hassle-free memory provider vision (user requirement for web-UI selection of local/Mem0/TiDB/etc. backends, non-rigid adapters) expose critical gaps that block the commercial VPS/cloud product direction. Durable stores (SqlRectorStore + TiDB path) never received the Chunk 27 memory interface backfill, despite declaring `implements RectorStore`. Neuro features 29-32 exist as isolated modules with zero integration callsites. `runStartupMigration` (fully specified with redaction, 30s deadline, PersistenceInitializationError per cloud Req 8.4/8.8) is exported but never invoked on the main boot path. The concerns register contains both outdated statuses (e.g., the external-mode catch-22 now addressed in `src/bin/server.ts`) and untracked new risks. Tests have expanded well beyond the post-Chunk-25 baseline of 27 files/272 tests (many new cloud property tests + memory/preprocessor/proactive), but coverage for unwired neuro and durable memory is absent. Build remains clean for the local baseline; no code changes occurred during this read-only audit.

Overall health: strong on LLM-provider BYOK/hassle-free configurability and symbolic guardrails; **blocked or at-risk** on memory pluggability (Chunk 34), durable neuro memory, full TiDB boot per spec, and integration of 29-32. 5-7 major concerns from the register are at least partially addressed by recent work; 4-5 new High/Med items identified. Local baseline status: intentionally preserved and identical. Readiness for VPS/hassle-free (full UI memory config, non-rigid): partial—LLM side advanced, memory/sandbox/persistence side incomplete.

**1. Concerns Register Resolution Matrix**

Summary table (from full read of `docs/plans/concerns-and-vulnerabilities.md` cross-checked against source):

| Category                  | Count | Notes |
|---------------------------|-------|-------|
| Resolved (this audit window or prior) | ~8 | Esbuild advisory, fake orchestrator, non-atomic transition, stale local-MVP docs, open-source scaffolding, etc. (see Closed section). |
| Still Open (local baseline / expected) | ~15+ | Legacy placeholders (fake planner, heuristic skeptic, deterministic crucible/DAG/executor, in-memory chat store, truth library keyword-only, etc.). These are documented as "until provider/sandbox chunks" and align with alpha baseline. |
| Still Open (actionable / cloud or neuro) | ~10 | External mode fail-fast (now code-addressed?), SLM preprocessor surface, advanced memory (esp. durable), proactive, doc/vision shift, pluggable memory providers via UI, safe sandbox real exec, developer triage prose, telemetry no-ops, Linear label mapping. |
| New High/Med (this audit) | 4+ | See Section 4. |

Detailed matrix for major Open items (selected; full register spans lines 5-332):

- **External mode fail-fast startup check ignores UI-persisted configurations** (High usability blocker). Prior: Open. Current: **PARTIALLY RESOLVED / code advanced**. Evidence: `src/bin/server.ts:197-214` (resolveStartupOrchestrationConfig awaits `resolveOrchestrationConfig` with providerConfigStore + secretStore; external + zero providers now warns + serves per Req 1.4/1.5, redacted, no hard exit except invalid mode); `src/providers/orchestrationConfig.ts` (new async resolver); bootstrap at 224. Concern text in register (lines 7-13) is stale and does not reflect the boot-tolerant design in `design.md` C1/Req 1. Notes: still lists "Plan" for sequencing fix; register needs update. New risk low if UI stores fail to init (treated as absent, redacted continue).

- **Dependency audit: vitest major-upgrade vulnerabilities deferred** (1 critical + 3 moderate, dev-only). Prior: Open/deferred. Current: **STILL OPEN**. Evidence: `docs/security/dependency-audit-2026-06-04.md` referenced; `package.json` pins; policy against `npm audit fix --force`. No runtime impact (not in dist). Notes: unchanged.

- **SLM preprocessor (Chunk 26) adds a new cheap-model call surface...** (Medium). Prior: Open. Current: **STILL OPEN** (as designed). Evidence: `src/orchestration/preprocessor.ts:176` (runSLMPreprocessor), wired only in external `src/orchestration/chatRunner.ts:329` (after context, before planner); `tests/preprocessor.test.ts` (property for schema/allowlist/no-leak); local/fake paths untouched. Mitigations (budget, Zod, allowlist, fallback, full pipeline downstream) implemented per chunk plan. Notes: matches register (lines 27-42); future work items remain valid.

- **Advanced memory (Chunk 27) introduces new write path (/api/notes) and pruning logic in the store** (Medium). Prior: Open. Current: **STILL OPEN (with critical durable gap)**. Evidence: `src/store/inMemoryRectorStore.ts:308-406` (full create/get/list/update/delete/search/pruneMemory + MemoryEntry in episodic/core, time fields, prune scoring); `src/api/server.ts:1393` (/api/notes), `1283-1423` (searchMemory for context, create + prune on note); `src/store/schemas.ts` (MemoryEntrySchema); `tests/memoryAdvanced.test.ts`. **Critical mismatch**: `src/store/sqlRectorStore.ts:115` (`class SqlRectorStore implements RectorStore`) + full file read (methods only through artifacts + internals; migrate() only for 5 base tables; grep for createMemoryEntry etc. returns 0 matches). tidbRectorStore.ts is thin wrapper over SqlDriver/SqlRectorStore (grep: only 1 incidental "memory"). `src/store/index.ts:73-80` (RectorStore interface lists the 7 memory methods post-Chunk 27). Callsites (`api/server.ts`) hit only in-memory paths. Notes: register (lines 43-57) flags "durable memory entities in sql/tidb stores" as future; this is now blocking. Directly impacts 034 UI memory providers and VPS + neuro usability.

- **Proactive alive layer (Chunk 28)...** (Low-Medium). Prior: Open. Current: **PARTIALLY IMPLEMENTED / STILL OPEN**. Evidence: `src/proactive/proactiveAgent.ts`; wiring in `src/api/server.ts:1157-1169` (instantiate only for external, startTimer 6h demo), dev endpoints 2213/2239 (guarded); source:"proactive" on messages. Local: no-op. Tests: `proactive.test.ts`. Register accurate. Readiness: usable for demo; future event-driven + memory integration pending.

- **Doc cleanup and vision shift (Chunk 33) + Cloud-capable transition** (Medium). Prior: Open/in progress. Current: **SUBSTANTIALLY RESOLVED for docs; implementation gaps remain**. Evidence: `docs/plans/chunks/033-*.md` (inventory + edits); AGENTS.md / README.md / docs/README.md updated for cloud vision, pluggable memory, .kiro as source of truth, neuro 26-32 as usability enablers; `docs/stale-docs-inventory.md`; banners on historical. "New risk from user vision: Pluggable memory providers via UI" (lines 89-102) added. Notes: core register entry still marked Open; 034 plan exists but not started.

- **Safe local sandbox execution uses a dummy mock runner** (High, commercial blocker). Prior: Open. Current: **STILL OPEN**. Evidence: `src/sandbox/index.ts` + WorkspaceSandboxAdapter (defaultCommandRunner echoes); `src/bin/server.ts:182` (local path always uses it); real E2B only in external + key present (`buildStartupSandboxAdapter`). Notes: matches "Sandbox stubs deny cloud..." entry. E2B adapter code exists per tasks but gated.

- **Other notables (STILL OPEN per register)**: Chat store in-memory (expected), synthesis deterministic (Req 7 progress via live gate), security local-only (redaction improved), triage/context placeholders, provider adapters opt-in, truth keyword-only, extension contracts no loader, operator API local-only, telemetry no-ops, Linear label UUID issue, etc. Cloud roadmap section (lines 371+) lists integration matrix and 5-step path; several items overlap resolved cloud tasks but memory/TiDB/synthesis prose remain actionable.

Many legacy "Medium product limitation" items (fake planner through validation/healing, observability in-memory) are intentional per release path (v0.1.0-alpha local preview → public alpha with providers).

**2. Cloud-Capable Transition Status**

Vs. `.kiro/specs/cloud-capable-transition/requirements.md` (11 Reqs + ACs) + `tasks.md` (16 major tasks, many sub, all marked [x] in the plan doc) + `design.md` (mode-gated graph, 40 correctness properties, error table, testing strategy):

**Complete / largely wired (with property test refs):**
- Boot-tolerant startup (Req 1, Tasks 2.x): `resolveOrchestrationConfig` + `describeRequiredProviderEnvKeys`, union of env + stores (hasSecret presence-only), default-local, invalid-mode hard-exit only, zero-provider warning + serve (redacted). Properties 1-4. `src/bin/server.ts:197` (resolve), 230 (warn), 240 (router), 241 (sandbox).
- Multi-provider model discovery + OpenAI-compatible manual models (Reqs 2-4, Tasks 4-6): 4 adapters (together/cloudflare/azure/openaiCompatible), dispatch, 30s abort, task filter, requiresDeployment, manual fallback, Settings_API /discover, label validation. Properties 5-17 (dispatch, fallback, normalization, classified errors, label, manual roundtrip, unknown/not_found, etc.). Tests: `tests/discovery*.test.ts` (many property + unit), `discoveryApi.test.ts`, `settingsDiscovery*.test.ts`.
- Provider routing in external (Req 5, Task 8): buildConfiguredRouter, designated + fallback (secret-free trace), local bypass. Properties 18-20.
- Real E2B (Req 6, Task 9): `createE2BSandboxAdapter` (policy gates first, lazy client from Secret_Store, capture/truncate/redact to 262144, no spawn on deny/init-fail). Properties 21-22. `src/bin/server.ts:174` (conditional), `src/sandbox/e2bSandboxAdapter.ts`. Local: never constructs.
- Streamed semantic answers (Req 7, Task 10): gating on external + Heavy_Developer_Route + valid flagship; live vs. Legacy_Status_Response; prompt from DAG/logs/validation/diffs; 2000 char cap + redaction; 60s deadline. Properties 23-28. Tests: `synthesizer*.property*.test.ts`, `liveSynthesizer.test.ts`.
- Local baseline invariants (Req 9, Task 13): zero provider calls, zero external sandbox, Config_Bridge bypass, providerCalls===0, determinism. Properties 31-35 (and cross-refs). Counting doubles + `byok*LocalMode*.property*.test.ts`, `localMode*.property*.test.ts`.
- Universal redaction (Req 10, Task 14): every new sink (warnings, discovery errors, sandbox streams, synth answers, TiDB errors) through Redaction_Layer + fixed placeholder + no-substring + scheme/URL rules. Properties 36-40. `redactionBeforeSink.property36.test.ts` + 37-39 siblings.
- Optional deps + build (Req 11, Task 15): lazy createRequire for sync-mysql/E2B; clear errors; `buildSmokeVerification.test.ts`; `npm run build` succeeds absent deps.
- TiDB relational (Req 8 partial, Tasks 12): pooled driver (tidbRectorStore), createRectorStore validation (StoreConfigError naming fields pre-IO, Property 29), SqlRectorStore mysql dialect + migrate() for 5 tables (conversations/messages/runs/run_events/artifacts), entity roundtrip (Property 30 via `storeRoundTrip.property.test.ts` + `entityRoundTrip.property.test.ts`), `STARTUP_MIGRATION_TABLES` + `runStartupMigration` + deadline + PersistenceInitializationError + redaction (in `src/store/index.ts:205-335`, `tidbStartupMigration.integration.test.ts`).

**Gaps (vs. spec + tasks):**
- TiDB boot wire incomplete: `runStartupMigration` (the explicit 30s + verify + redacted halt per Req 8.4/8.8 and design sequence diagram and tasks 12.2/12.5) is **exported but never called** from `src/bin/server.ts` (bootstrap uses `createRectorStore(persistence)` directly via app options) or `src/api/server.ts:1146` (`const rectorStore = withEventBroadcast(createRectorStore(...))`). Sql ctor runs basic `migrate()` (CREATE IF NOT EXISTS) but lacks the timed verify, full error classification, and "halt before serve" for tidb. Integration test exists; main path does not exercise the cloud Req 8.8 path. `verifyStartupTables` only lists base 5 entities (no memory tables).
- Memory providers / pluggable backend for neuro (user vision + 034 plan): zero UI surfaces, no MemoryProviderRecord/secret pattern mirroring providers, no adapter registry, no update to createRectorStore or context/memory paths. Chunk 27 memory lives only behind InMemoryRectorStore.
- Synthesizer live prose for heavy routes: gated but depends on flagship provider being configured; fallback always available.
- Full end-to-end TiDB + E2B + live synth smoke under external + real creds: property + unit + one integration; no full VPS rehearsal in baseline (by design for local).
- Vision fit for hassle-free: Excellent for LLM providers (Settings_API + discovery + routes entirely UI-driven, no env required post-bootstrap). Memory/sandbox/telemetry lag. Non-rigid/pluggable architecture supported in design (adapters, injected deps, local fallbacks) but memory layer not yet abstracted.

All new paths respect local-mode zero-network and redaction invariants (verified via properties + counting doubles). `npm run build` + test gates referenced in every checkpoint.

**3. Neuro-Symbolic (26-32) Deep Dive + Pluggability**

- **26 (SLM preprocessor + structured tool calls)**: Fully implemented per chunk plan (`src/orchestration/preprocessor.ts`). Wired in external path only (`chatRunner.ts:329` inside runExternalChatRun, post-context pre-planner; distilled + proposedToolCalls passed downstream but original prompt/context retained for skeptic/crucible). Safety: budget gate, json_object, Zod, ALLOWED_PREPROCESSOR_TOOLS allowlist, redaction, never-throw fallback to empty. Local/fake completely untouched. Property test + `preprocessor.test.ts`. Register entry accurate. Readiness: good; additive to context for future memory.

- **27 (advanced memory system)**: Core in `InMemoryRectorStore` (hierarchical working/episodic/core via MemoryEntry + layer, timestamp/lastMentioned/accessCount, recency+access+source prune scoring with auto core summaries, bounded). API: `POST /api/notes` (episodic, redacted), time-aware injection into ContextPack (used by preprocessor/context). Prune opportunistic on writes. Tests: `memoryAdvanced.test.ts` (invariants, pruning, time). **Critical blocker for pluggability**: interface extended in `src/store/index.ts:73-80`; InMemory implements; SqlRectorStore (used for sqlite + tidb) and tidbRectorStore do not (no methods, no "memories" table in migrate(), no DDL for memory entities). Callsites (`api/server.ts`) only exercised under memory driver. Chunk plan explicitly deferred durable; register flagged it. Directly blocks 034 (UI-configurable memory providers) and any VPS use of sqlite/tidb + neuro features (notes, time context, ponder input).

- **28 (proactive alive layer)**: `ProactiveAgent` implemented; synthetic "proactive-companion" route calls through full pipeline + budget/redaction. Wired: external-only timer (demo 6h), dev trigger endpoints (guarded). Message source field added. Local: no-op. Tests: `proactive.test.ts`. Register accurate. Readiness: usable for demo; future event-driven + memory integration pending.

- **29-32 (pluggable symbolic expert systems, opt-in MCTS, ponder swarm subconscious, task decomposition concurrent)**: Modules exist per plans (`src/symbolic/symbolicEngine.ts` + registry with default SimpleRuleEngine; `src/orchestration/ponderSwarm.ts` (runPonderSwarm using multi-agent on MemoryEntry[] for lessons into core); orchestration/index.ts re-exports ponder; chunk plans describe hooks, MCTS for planning, decomposition/stitching, subconscious daemon). **Status: dead/unwired**. Grep across src for runPonderSwarm / ponderSwarm / symbolicEngine (beyond self/index) / MCTS / decomposeTask / taskDecomp etc.: only definitions, exports, and the ponderSwarm internal call. No callsites in `chatRunner.ts`, `contextBuilder.ts`, preprocessor, planner, crucible, main run paths, or api/server.ts (beyond proactive 28 and memory 27 injection). No tests for 29-32 (only preprocessor/memoryAdvanced/proactive). Chunk 31 plan is minimal ("using existing live modules"). Per AGENTS.md and 033 plan, these were intended to make the system "alive" for real work and integrate with configurable cloud product. Current: isolated research stubs. Test coverage: 0 for integration. Readiness for 034: none—ponder is explicitly noted in register (line 56) as future consumer of advanced memory.

Neuro features overall: 26-28 add value in external paths while preserving local baseline exactly. 29-32 do not yet contribute to usability or the non-rigid/UI-config vision. Memory (27) is the linchpin for later ponder + pluggable backends but is in-memory-only.

**4. New Concerns & Bugs Discovered**

Prioritized (High first); copy-paste ready text for concerns register (add under ## Open, update traceability).

**High: Durable SQL stores (sqlite/TiDB) lack Chunk 27 advanced memory interface methods**

- **Source:** Full-system audit + cross-check of neuro 27 vs. store impls + cloud pluggability vision.
- **Severity:** High (blocks neuro usability + 034 memory providers + any durable + memory usage on VPS).
- **Status:** New / Open.
- **Root cause:** `RectorStore` interface in `src/store/index.ts:73-80` extended with 7 memory methods (createMemoryEntry through pruneMemory) during Chunk 27; only `InMemoryRectorStore` received impl (maps + logic at 308-406); `SqlRectorStore` (class at 115 declares implements, but file ends after artifact delete + migrate for only 5 base tables at 371-375; zero memory* identifiers per grep) and `tidbRectorStore.ts` (thin SqlDriver wrapper) were never updated. `createRectorStore` returns Sql for sqlite/tidb. Memory callsites (`api/server.ts:1284` search, `1420/1423` create+prune) and context injection only exercised under memory driver. No "mem" table or JSON payload path in Sql DDL.
- **Impact on vision:** Directly prevents hassle-free web-UI memory DB providers (local-inmemory vs. Mem0 vs. TiDB-backed per 034 plan and user requirement); neuro features (notes, time-aware context for preprocessor/planner, future ponder) unavailable or crash under durable persistence required for VPS/cloud restarts/scaling. Violates non-rigid pluggable architecture for backends. Local baseline unaffected (defaults to InMemory).
- **Plan:** Backfill SqlRectorStore with memory tables (e.g., "memory_entries" with layer filter + JSON payload, seq, using same pattern as artifacts), implement the 7 methods (reuse InMemory logic or share), add to migrate()/verify, extend runStartupMigration tables if needed, add roundtrip + prune/search properties for durable, update createRectorStore/tidb paths. Make memory pluggable in 034 (separate provider abstraction over the store methods). Update register + 027/034 plans.
- **Traceability:** This entry; `src/store/sqlRectorStore.ts:115` (implements claim), full file; `src/store/index.ts:164-195` (factory), `300` (runStartupMigration); `src/api/server.ts:1146,1283`; `docs/plans/chunks/027-advanced-memory-system.md`, `034-ui-configurable-memory-providers.md`; `tests/memoryAdvanced.test.ts` (in-memory only).

**High: runStartupMigration exported and fully specified for TiDB cloud path but not invoked in server bootstrap**

- **Source:** Cloud-capable audit + grep verification of key claims.
- **Severity:** High (incomplete Req 8.4/8.8 compliance; TiDB path may serve before tables verified or on slow connect).
- **Status:** New / Open.
- **Root cause:** `src/store/index.ts:300` exports `runStartupMigration` (races createRectorStore + verifyStartupTables against 30s deadline, redacts, throws PersistenceInitializationError or StoreConfigError, per design sequence and tasks 12.2/12.5); `STARTUP_MIGRATION_TABLES` + `verifyStartupTables` (base 5 entities); `tidbStartupMigration.integration.test.ts`. But live boot (`src/bin/server.ts:223` bootstrap (resolve, build router/sandbox, createApp with persistence) and `src/api/server.ts:1145` (direct `createRectorStore(securityOptions.persistence)`) never call it. Sql ctor does basic migrate(); no 30s timed verify + halt-before-listen for tidb.
- **Impact on vision:** Cloud-capable VPS/TiDB persistence (Req 8) not fully realized; operator may get partial tables or hangs instead of clean redacted failure. Undermines boot-tolerant + durable story. Local/memory unaffected.
- **Plan:** Wire `await runStartupMigration(deploymentConfig.persistence, ...)` in bin/server.ts bootstrap (after config resolve, before or inside createApp for tidb driver; only when driver==='tidb' or always for the verify path). Update api/server create path or centralize. Ensure memory tables included post-27 backfill. Add to main smoke paths. Update register.
- **Traceability:** This entry; `src/bin/server.ts:245` (persistence only), `197` (no migration); `src/store/index.ts:276-334`; `.kiro/specs/cloud-capable-transition/requirements.md:360-372` (Req 8.4/8.8), `tasks.md:214-225`, `design.md:104-106,340-349`.

**High: Neuro-symbolic chunks 29-32 (symbolic engines, MCTS, ponder swarm, task decomposition) are dead/unwired code**

- **Source:** Grep + chunk plan review + callsite audit.
- **Severity:** High (wasted implementation effort; misleads on "alive" system usability per AGENTS.md vision; incomplete for cloud product).
- **Status:** New / Open.
- **Root cause:** Per `docs/plans/chunks/029-*.md` to `032-*.md` and 031 plan: pluggable symbolic (src/symbolic/symbolicEngine.ts + registry), ponderSwarm (orchestration/ponderSwarm.ts using multi-agent on MemoryEntry for lessons into core), MCTS opt-in, decomposition concurrent. Exported in `src/orchestration/index.ts:15`. But greps show no callsites in chatRunner, contextBuilder, preprocessor, planner, crucible, main run paths, or api/server.ts (beyond 26-28 wiring). PonderSwarm impl is itself a stub demo. No integration tests or property tests. Chunk 27 explicitly deferred full ponder to Step 6.
- **Impact on vision:** Neuro enhancements (26-32) were to make system "usable and alive" and integrate into configurable cloud product. 29-32 add nothing to hassle-free UI, pluggable memory, or VPS daily work. Increases maintenance surface without benefit. Local baseline clean (no impact).
- **Plan:** Either wire (e.g., ponder on memory write / periodic via proactive or new daemon, symbolic in planner/skeptic, MCTS/decomp in planning paths, behind feature flags or external-only), or quarantine as research + remove from "implemented chunks" lists / update plans/register. At minimum add "unwired" banner in chunks 029-032 and cross-ref in concerns. Prioritize after 27 backfill + 034.
- **Traceability:** This entry; `src/orchestration/ponderSwarm.ts:10` (def + internal only), `src/orchestration/index.ts:15`; `src/symbolic/*`; grep results across src; `docs/plans/chunks/026-*.md` (scope notes), `027` (future), `031`, `033` (neuro retained), AGENTS.md:97.

**Medium: Pluggable memory provider UI/config abstraction not started (blocks 034 + user vision)**

- **Source:** 034 plan + concerns cross-check + store gap.
- **Severity:** Medium (core to hassle-free non-rigid memory config).
- **Status:** New / Open (pre-034).
- **Root cause:** 034 plan exists (`docs/plans/chunks/034-*.md`: MemoryProviderRecord mirroring providers, secret handling, interface, local adapters + Mem0/TiDB stubs, Settings_API, wire behind neuro 27, local guards, property tests). No code yet. Current persistence (RECTOR_PERSISTENCE + createRectorStore) and memory (hard on InMemory) are not UI-configurable like LLM providers (Provider_Config_Store + Secret_Store + discovery). Chunk 27 memory not abstracted.
- **Impact on vision:** User requirement ("configure their own providers for LLMs, memory databases (local in-memory/SQLite, Mem0, TiDB Cloud, and others) entirely through the web UI") unsupported for memory. Non-rigid architecture promise partially delivered (LLM side) but memory is rigid. VPS users cannot switch backends without code/env.
- **Plan:** Execute 034 after fixing store gap (4.1). Extend config pattern, define MemoryProvider (upsert/search/list/prune etc. to match 27 needs), local impls first (reuse/extend InMemory + truth), stubs for external (lazy, clear errors), UI/API, integration with rectorStore/context, local isolation properties. Update concerns entry "New risk from user vision".
- **Traceability:** This entry + existing concerns lines 89-102; `docs/plans/chunks/034-ui-configurable-memory-providers.md`; `.kiro/.../requirements.md` (glossary has no memory provider yet).

Additional lower items: register contains several pre-cloud "open" entries whose status is now stale post-033 + cloud wiring (re-audit needed); no evidence of ponder/MCTS etc. in property coverage; SqlRectorStore "implements" claim is misleading without the methods (type safety gap at runtime for durable + memory).

**5. Security, Redaction, Sandbox, Secret Handling**

Redaction_Layer (`redactString`, `redactSecrets`, `redactOutbound`, fixed placeholder, scheme/URL rules) is mature and universally applied to new sinks per cloud properties 36-40 (startup warnings, discovery, sandbox streams/artifacts, synth answers/citations, TiDB errors). All secret-bearing values (E2B key, provider secrets, connection creds) read transiently from Secret_Store (encrypted local file) or env fallback; never logged or returned in API responses (sendRedacted). Property tests cover no-substring, fixed placeholder, auth scheme, URL userinfo.

Sandbox: policy gates (allowlist, destructive denylist, approvals, path containment via WorkspaceSandboxAdapter) before any execution or E2B. Local: dummy echo (no child_process, no real patches—known high concern). External: real E2B only with key present; otherwise degrades to local runner; no container on deny/init-fail; streams truncated + redacted. Stubs for E2B/Depot replaced in wiring but real client lazy.

BYOK secrets: local encrypted store + providerConfigStore (non-secret records); UI-driven; no env required for external post-resolution. Operator console /api/operator/* and dev endpoints explicitly local-only or dev-guarded. Rate limiting in-memory (local-only concern noted). No new PII/secret leakage paths found in cloud or neuro wiring (all routed through redaction).

Known open: `npm audit` 1 critical (vitest UI, unused in `npm test`) + 3 moderate (dev-only, not dist); deferred per policy. No forced fixes. Sandbox real exec and multi-user auth/RBAC remain pre-production per register.

No evidence of secret leakage in traces, logs, or telemetry (LocalTelemetry in-memory; others no-op).

**6. Tests, CI, Property Coverage, Build**

Test surface significantly expanded (>>27 files; 100+ .test.ts entries in tests/ including many cloud-specific property*.test.ts, byok*.test.ts, discovery*.test.ts, synthesizer*.property*.test.ts, memoryAdvanced.test.ts, preprocessor.test.ts, proactive.test.ts, e2b*.property*.test.ts, redaction*.property*.test.ts, localMode*.property*.test.ts, tidbStartupMigration.integration.test.ts, buildSmokeVerification.test.ts, etc.).

Cloud transition: each of 40 properties has dedicated fast-check test (≥100 iterations targeted; hermetic via injected doubles for fetch/fs/clock/command/client). Tags reference design properties. Strong coverage of config resolution, discovery normalization/routing, redaction invariants, local isolation, stream truncation, roundtrips, determinism, failure degradation.

Neuro: good for 26-28 (preprocessor, memoryAdvanced, proactive); zero dedicated for 29-32 integration.

Durable stores: semantic/roundtrip/persistentStore.* + store* property tests; tidb integration for migration (but not main boot); no memory methods exercised for sql/tidb.

Other: E2E brainstem (chatBrainstemE2E), streaming/redaction, approval flows, budget, workflows, extensions, security, UI dom/shell tests, dependencySecurity regression for overrides. CI drift checks (roadmap issues) per prior chunks.

`npm run build`: succeeds (local baseline + optional deps absent per smoke). `npm test`: referenced as gate after every chunk; assumed clean (no execution in this read-only audit). Property tests + unit + integration + smoke provide good regression for cloud features while protecting local exactness. Gaps: no durable memory properties yet; no integration tests exercising 29-32 or full ponder; TiDB migration not on main server path.

**7. Docs / Vision / Stale Alignment**

Chunk 33 + 033 plan executed substantial cleanup: AGENTS.md (both copies), root README, docs/README, stale-docs-inventory.md, .env.example comments, master-roadmap, architecture notes updated to emphasize cloud-capable VPS/hassle-free UI-configurable product (LLM + memory providers), non-rigid/pluggable architecture, local as "mandatory perfect regression baseline and contributor-friendly default" (never broken). Source of truth: .kiro/specs/cloud-capable-transition/ (reqs/design/tasks) + `docs/architecture/current-rector-byok-architecture.md` + concerns + chunks (incl. 26-32 neuro + 033+ cloud). Historical alpha docs (old rector-0.1.0-architecture.md etc.) retain banners or moved to generated/issues.

Alignment with user vision: good on messaging for "hassle-free... without editing files or environment variables"; pluggable memory explicitly called out as next (034 plan created). Neuro retained as usability layer for the cloud product.

Gaps: concerns register itself has stale "Open" statuses (external catch-22, etc.) and incomplete cross-refs to resolved cloud items. Some chunk plans (029-032) read as "to be integrated" but code reality is unwired. 034 plan is aspirational (no implementation). Architecture doc and roadmap need minor refresh post-audit (e.g., memory provider layer). No evidence of conflicting stale docs overriding source-of-truth.

**8. Recommendations & Prioritized Next Work**

1. **Immediate (pre-034, high leverage):** Backfill SqlRectorStore (and update tidbRectorStore/migrate/verify) with the 7 Chunk 27 memory methods + supporting table. Add durable memory roundtrip/prune/search properties. This unblocks all neuro + pluggable memory. (Addresses new High concern 1 + existing register "future work" for durable entities.)

2. **Wire the missing migration:** Invoke `runStartupMigration` (or equivalent) from `src/bin/server.ts` bootstrap for the tidb path (and centralize store construction) before createApp/listen, per cloud design/Req 8 + tasks 12. Include memory tables post-backfill. Exercise in smoke + update integration. (New High concern 2.)

3. **Integrate or quarantine 29-32:** After memory backfill, either add minimal wiring (e.g., ponder hook on memory writes or timer, symbolic in planner paths) with tests + local guards, or explicitly mark as deferred/research in plans/register/AGENTS with "unwired" status. Remove from "implemented" counts if not contributing. (New High concern 3.)

4. **Execute 034 (UI-configurable memory providers):** Top priority per active vision and cloud extension. Follow the plan: config model + secrets, MemoryProvider interface (local + stubs), Settings_API, wiring to neuro 27 + rectorStore/context, local isolation + properties, non-rigid design. Update .kiro glossary if needed. Leverage stack credits (Mem0/TiDB/Chroma) for real adapters later. Keep local zero-config default.

5. **Update concerns register:** Mark resolved/partial items with evidence (external boot, doc cleanup); add the 4 new High/Med items verbatim (with traceability); refresh "New risk from user vision" and cloud roadmap section. Keep `docs/plans/concerns-and-vulnerabilities.md` as living doc.

6. **Docs/alignment polish:** Quick pass on current-rector-byok-architecture.md + rector-master-roadmap.md + AGENTS for post-audit state (memory layer, migration wiring, 29-32 status). Ensure 034 plan refs the store gap fix as prerequisite.

7. **Tests/CI:** Add property coverage for durable memory once backfilled; main-path TiDB migration smoke; integration exercising ponder/symbolic if wired. Re-run full `npm test && npm run build` (and absent-optional-deps variant) after each. Consider drift check for neuro "implemented" status.

8. **Re-audit:** After 1-4 above + 034 start, perform targeted follow-up (focus on memory pluggability + TiDB boot + neuro integration). Continue chunk discipline.

9. **Broader:** No changes to local baseline ever. Emphasize non-rigid adapters everywhere for future providers. Triage the vitest vulns with maintainers before public. Update release path notes if memory providers accelerate beta readiness.

All findings from read-only exploration + subagent reports (parallel tool calls for docs/specs deep-dive, store implementation verification, orchestration callsite greps, .kiro requirements cross-check, chunk plan review). No code changes in audit phase.