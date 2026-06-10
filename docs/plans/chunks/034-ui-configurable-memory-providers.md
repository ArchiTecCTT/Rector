# Chunk 34 — UI-Configurable Pluggable Memory Providers (Cloud-Capable Transition, adapted for hassle-free vision)

**Status (this chunk):** In progress. Baseline verified + pre-existing timing issue in related provider property hardened (see below). Implementation follows the approved session plan.

## Goal
Extend the cloud-capable transition so memory database providers are fully configurable via the web UI in a hassle-free way (no file/env edits for normal users). Support pluggable backends: local (in-memory, SQLite/file-based), Mem0, TiDB Cloud, and future options (Chroma etc.). Keep architecture non-rigid (adapters, registry, injectable doubles, lazy optional deps, local fallbacks). Local mode / default remains *completely unaffected* and produces identical behavior (zero-config, zero network, deterministic).

This directly implements the user's explicit requirement ("configure their own agent memory database provider--either locally or something like Mem0/TiDB cloud... configurable on the web UI itself") and the "New risk from user vision: Pluggable memory providers via UI" + "Execute 034" items from the full-system audit + concerns register. It mirrors the excellent Provider_Config_Store + Secret_Store + Settings_API + Config_Bridge pattern already proven for LLM providers (BYOK).

## Scope (in this chunk)
- Define MemoryProviderRecord / state schemas + MemoryConfigStore (non-secret) + reuse Secret_Store (encrypted secrets, presence-only hasSecret).
- MemoryProvider runtime interface + registry/factory.
- Local implementations (pure in-memory reproducing Chunk 27 behavior exactly; optional "local-sqlite-mem" delegating to SqlRectorStore memory methods post-backfill).
- Stubs for external (Mem0, TiDB-memory) using lazy createRequire + clear redacted errors (like E2B).
- Settings_API surfaces (CRUD + set-active + secret + test-connection, presence-only responses, redaction).
- Wiring: resolve active provider at bootstrap, inject into places that need neuro memory (chat context search, /api/notes create+prune, contextBuilder time phrases). Default always local-inmemory.
- Local-mode + default guards (never construct external, never read secrets, zero net).
- Comprehensive tests (new memoryProvider* + properties mirroring provider ones; regression on all existing memoryAdvanced / chat / persistentStore / localMode properties).
- Update 034 plan doc, concerns register, minor .env polish.
- Full verification loops + fix any failures surfaced (per user request).

**Non-goals (deferred):** Real Mem0/TiDB client adapters (stubs + contracts only; use stack credits later). Full integration of neuro 29-32 (ponder etc. now *enabled* by pluggable memory). Data migration UI/tool between providers. Vector search extensions. Changes to main RectorStore persistence driver (memory/sqlite/tidb for convos/runs remains orthogonal; neuro agent memory is the pluggable layer).

## Key Design Decisions (non-rigid + local baseline first)
- **Separate from main persistence:** RECTOR_PERSISTENCE / createRectorStore still chooses the store for conversations/runs/artifacts/events (and now its own durable "memories" table for sql/tidb). The MemoryProvider is the *neuro/agent memory* backend (notes, episodic search for context/preprocessor/planner, prune, layers, future ponder input). This matches user language ("agent memory database provider") and allows independent choice (e.g. main sqlite + Mem0 for smart memory).
- **Default = local-inmemory (pure):** Exact reproduction of current InMemoryRectorStore memory logic (maps, scoring with recency/access/user-note bonus, auto core summaries on prune, keyword search, timestamp/lastMentioned/accessCount, time phrases in ContextPack). Injected `now` for determinism in tests. No network ever for default.
- **Delegation option:** A "local-sqlite-mem" kind can construct (or receive) a SqlRectorStore and delegate the 7 memory methods — leveraging the Chunk 27 backfill (sqlRectorStore now has createMemoryEntry etc. + "memories" table + verify). Useful for users who want durable memory without external service.
- **Config layer mirrors providers exactly:**
  - `MemoryProviderKind`: 'local-inmemory' | 'local-sqlite-mem' | 'mem0' | 'tidb-memory' | ...
  - `MemoryProviderRecord`: id, kind, label, config (baseUrl, options, account etc.), secretRef (never the value), timestamps. Validated by Zod schema.
  - `MemoryProviderState`: { version: 1, providers: MemoryProviderRecord[], activeMemoryProviderId?: string }
  - `MemoryConfigStore` interface + `createLocalMemoryConfigStore` (atomic .rector/memory-providers.json + temp/rename, injectable fs, redacted errors) + `createInMemoryMemoryConfigStore` (tests).
  - Secrets reuse the existing `SecretStore` (refs like `memory:mem0-prod-key`). hasSecret for UI "configured" badges; getSecret only at construction time inside the bridge (transient).
- **Bridge / resolver:** `resolveActiveMemoryProvider(configStore, secretStore, {mode})` — in local mode or no active/default kind → always returns a pure LocalMemoryProvider (no secret read, no network). For external kinds: read secret, build the impl, validateConfig. Graceful fallback to local-inmemory on any error (redacted).
- **Runtime `MemoryProvider` interface:** the 7 methods from RectorStore (createMemoryEntry, get/list/search/update/deleteMemoryEntry, pruneMemory) + validateConfig(), metadata. All memory *content* flows through redactString on ingress/egress.
- **Wiring (minimal surface change):** 
  - ApiSecurityOptions gets optional `memoryConfigStore?`.
  - createApp / bootstrap: create local memoryConfigStore (real app) or inmem (tests), resolve active (or default), expose via app context or a small `getActiveMemoryProvider()` helper.
  - In `src/api/server.ts`: chat pipeline uses `memoryProvider.searchMemory(...)` (instead of or in addition to pipelineStore); /api/notes uses `memoryProvider.createMemoryEntry + pruneMemory`.
  - `src/orchestration/contextBuilder.ts`: accepts or resolves memory entries from the provider.
  - RectorStore.memory* methods stay (for direct persistentStore tests + any "durable chat memory" use of the sql table). The default MemoryProvider can optionally delegate for the sqlite-mem kind.
- **Local baseline protection:** Every construction path checks mode or active kind. Properties assert 0 external calls + identical outputs for default. Existing 1241 tests (especially localMode* properties, memoryAdvanced, inmem persistentStore parity, chat) must continue to pass with zero behavior change when using the default.
- **Redaction & safety:** Universal on every new path (content in notes, search results, errors, any config that might leak). Same as provider discovery / E2B / synth.
- **Tests mirror the proven provider ones:** separation (secret never in .json), no secret egress (Property 1 style across all new /api/memory-providers responses + test-connection), local isolation (Properties 31+ style), roundtrips, failure degradation, redaction on memory payloads.

## Refined Implementation Plan (steps executed in order, with verification after each)
1. **Baseline + fix (done in this chunk start):** `npm test && npm run build`. Hardened the pre-existing "Provider_Config_API — Property 1: no secret egress" it() with explicit 120s timeout + comment (it was hitting default 5s it() timeout under slow harness + 40 fc runs in some envs; now robust and we will copy the pattern + timeouts for memory equivalents). Confirmed clean (build green; the property + file 11/11 green).
2. Refine this 034 plan doc (this file) with the above design, exact files, interfaces, test list, verification steps, traceability.
3. Schemas + MemoryConfigStore (src/providers/memoryConfig.ts + memoryConfigStore.ts). In-memory double + local atomic (copy/adapt the exact patterns from configStore.ts, including temp+rename, redacted errors, DiscoveryCache-style invalidator hook if we later add memory "discovery").
4. Secret reuse + MemoryBridge + core providers (src/providers/memoryBridge.ts, src/memory/provider.ts or providers/memory.ts). LocalMemoryProvider (pure inmem + optional sqlite delegate). Stubs (lazy createRequire, clear errors, redaction).
5. API + wiring (server.ts routes mirroring /api/providers but /api/memory-providers or unified; options + bootstrap in bin/server.ts + createApp; call site updates in chat/notes/contextBuilder with default guard).
6. Tests (new tests/memoryProviderConfig.test.ts, memoryProvider.test.ts, memoryProviderApi.test.ts or extend providerConfigApi style; properties for the key invariants; regression passes on memoryAdvanced.test.ts + chat + localMode* + persistentStore*).
7. Docs/concerns polish + final verification loops (full `npm test && npm run build`; fix anything that appears; update concerns with progress on pluggable item).
8. Commit as single chunk.

## Concrete Files & Changes (additive + mirroring)
- `src/providers/memoryConfig.ts` — kinds, MemoryProviderRecordSchema (id/kind/label/config/secretRef/etc.), MemoryProviderStateSchema, empty*State, arb helpers for properties.
- `src/providers/memoryConfigStore.ts` — MemoryConfigStore interface (getState, upsertMemoryProvider, removeMemoryProvider, setActiveMemoryProvider), createLocalMemoryConfigStore (atomic .rector/memory-providers.json), createInMemoryMemoryConfigStore.
- `src/providers/memoryBridge.ts` — resolveActiveMemoryProvider (mode guard → pure local; secret read only for construction; fallbacks), buildMemoryProviderFromRecord.
- `src/memory/provider.ts` (or under providers) — MemoryProvider interface, LocalMemoryProvider class (reproduces inMemoryRectorStore memory logic 1:1 or delegates), Mem0MemoryProvider stub, etc. Registry/factory.
- `src/api/server.ts` — ApiSecurityOptions.memoryConfigStore?, new routes (or extend), wiring in runChatPipeline + notes handler + context.
- `src/bin/server.ts` — create the memoryConfigStore (local), resolve, pass to createApp.
- `src/orchestration/contextBuilder.ts` — minor update to pull from memory provider when supplied.
- Tests: `tests/memoryProvider*.test.ts` (new), updates to `tests/memoryAdvanced.test.ts`, `tests/providerConfigApi.test.ts` (we already hardened the pattern), existing local/persistent properties (must stay green).
- `docs/plans/chunks/034-...md` (this file — expanded), `docs/plans/concerns-and-vulnerabilities.md` (update pluggable + vision entries).
- Minor: .env.example comments.

**RectorStore impact:** None for the interface (already extended in Chunk 27 + backfilled). The new layer sits *above* it for the neuro features.

## Test Strategy & Properties (must all pass at end)
- Unit + store parity for MemoryConfigStore (mirrors providerConfigStore.test.ts).
- Bridge (mirrors configBridge.test.ts).
- Secret separation + no-egress Property 1 across the new memory provider API responses (we will copy the exact fc.asyncProperty + bodies collection + expect not.toContain after the hardening we did for the provider version).
- Local isolation properties (no network when default/local-inmemory; deterministic with injected now; identical prune/search results and ContextPack time phrases vs. pre-034 inmem).
- Roundtrip + restart survival for records (non-secret only).
- Integration: memoryAdvanced.test.ts + notes + chat context enrichment continue to produce *identical* results with the default provider.
- Existing 1241-test baseline + new tests: zero regressions for localMode*, byok*, persistentStore (inmem + sqlite), chatRunner, etc.
- Fast-check numRuns reasonable (e.g. 20-40 for the egress one to keep duration sane); explicit timeouts on heavy its.

## Verification (non-negotiable, per plan + user request)
- After 0 (baseline): done (build green; provider secret egress property passes cleanly with the fix; ~1241 total per prior full runs).
- After 3/4 (core + bridge): run new memory provider tests + memoryAdvanced.
- After 5 (API + wiring): full relevant (memoryAdvanced, chat, notes, providerConfigApi, local properties) + the new ones.
- **Final (before claim):** `npm test && npm run build`. If any failures (new from wiring, the old timeout pattern, drift in prune scoring, missing exports, etc.): diagnose (read stack + file), implement exact fix (search_replace), re-run the failing + full until 0 failures + build clean. Document the fixes.
- Confirm in log: local default identical (same memory entry shapes, same context "X days ago" phrases, prune invariants, 0 external calls in local properties); no secret values anywhere; build succeeds absent optional deps.

## Acceptance Criteria (expanded)
- Memory provider (kind + non-secret config + secret) fully manageable via the (mirrored) API; UI can select active.
- Local/default path: zero-config, zero network, *byte-identical* memory behavior and test results vs. pre-chunk.
- Pluggable: adding a new kind requires only a new adapter + registry entry (no core changes).
- Chunk 27 features (notes, episodic context for preprocessor/planner, prune, layers, time phrases) work transparently for any chosen provider.
- All tests (existing + new) pass; build green (after any fixes applied).
- Concerns register updated; 034 plan doc reflects reality.
- Aligns with non-rigid, hassle-free, local-baseline-mandatory vision (AGENTS + .kiro Req 9 + concerns).

## Risks / Mitigations (carried from concerns + .kiro)
- Test count / flakiness (the secret egress timeout we just fixed; potential new similar for memory API): explicit timeouts + reasonable numRuns + repeated verification loops + fixes.
- Local baseline drift: default provider *is* the old inmem logic; properties + regression tests + "identical output" checks.
- Secret leakage: reuse SecretStore + redact layer + presence-only + the exact Property 1 test we hardened.
- Data / cost on real backends: stubs only in this chunk; limits on injected context size already exist; future budget hook.
- Coupling: memory provider is independent; RectorStore.memory* untouched for its original purpose.
- See also the "New risk..." entry in concerns (we will advance it) and the audit recs.

## References & Traceability
- .kiro/specs/cloud-capable-transition/requirements.md (Provider_Config_Store, Secret_Store, Settings_API, Req 9 local baseline + Properties 31-40, redaction).
- `docs/plans/concerns-and-vulnerabilities.md` (pluggable memory vision, now-RESOLVED durable memory methods High that enabled this, neuro 29-32 note that pluggable memory helps future integration).
- Chunk 27 (advanced memory) + the post-audit register updates.
- Provider implementation (configStore.ts:147, config.ts:79, configBridge.ts:314, secretStore.ts) — we mirror structure and idioms.
- User's "hassle free... UI itself" requirement + 033 vision alignment.
- Stack credits noted for later real adapters.

This refined plan turns the original high-level stub into an executable, evidence-based chunk plan (per AGENTS "each chunk gets its own plan under docs/plans/chunks/ before code"). Implementation will follow the steps, use foreground subagents for parallel pieces where helpful, run verification + fix failures at every gate, and produce a clean, non-rigid, UI-configurable memory layer while keeping the 1241-test local baseline perfect.

(Expanded during Chunk 34 execution per the session plan. Original stub content preserved in spirit above.)

## Post-Implementation Notes (to be filled during execution)
- Baseline verification output: ...
- Any fixes applied (with file:line): the providerConfigApi.test.ts it() timeout hardening (tests/providerConfigApi.test.ts:523).
- Final test count + build status: ...
- Concerns updates: ...
- Commit hash / message: ...