# Chunk 36 — Hassle-Free UI, Neuro Observability, and Memory Hardening

**Status:** Complete (Waves 1–3).

## Goal

Close the hassle-free UI gap for pluggable memory providers and neuro-symbolic observability: expose memory configuration in Settings, surface neuro phases in the trace drawer, wire episodic notes capture and deep-planning controls, inject bounded `memoryContext` into LLM prompts, and harden security/performance around memory API egress and background timers.

## Wave 1 — Backend foundation (commits `f0d1209`–`c98cf03`)

### 1A — Prune survival property tests (`f0d1209`)
- `tests/memoryPrune.property.test.ts`: fast-check invariants for `LocalMemoryProvider.pruneMemory`
- Properties: `maxEntries` bound, user-note survival, high-access survival, core-summary creation
- Deterministic `now()` injection for reproducible scoring

### 1B — Memory provider Settings API (`c98cf03`)
- `src/api/server.ts`: full `/api/memory-providers` CRUD mirroring Provider_Config_API
  - GET list + `secretPresent` booleans only
  - POST upsert (optional `apiKey` → Secret_Store under `memory:${id}`)
  - POST active selection, POST secret replace, DELETE record+secret
  - POST `/:id/test-connection` via `resolveMemoryProviderForTest`
- All success/error responses routed through `sendRedacted` / `redactOutbound`
- `src/providers/memoryBridge.ts`: `resolveTestMemoryProvider` helper for connection tests
- `tests/memoryProviderApi.test.ts`: CRUD, secret egress property tests, test-connection paths

## Wave 2 — Prompt wiring + setup + UI surfaces (commits `0ba4ec3`–`a22c6e7`)

### 2A — memoryContext prompt injection (`0ba4ec3`)
- `src/orchestration/prompts.ts`: `sanitizeMemoryContextForPrompt` caps (8 entries, 200 chars/line) + redaction
- Injected into planner, skeptic, synthesizer, repair prompts
- `src/orchestration/preprocessor.ts`: time-aware memory lines in SLM preprocessor prompt
- `src/orchestration/chatRunner.ts`: preprocessor usage accounting aligned with cheap-call budget
- `tests/prompts.test.ts`: presence/absence + cap regression tests

### 2B — Setup status memory readiness (`36b7f72`)
- `src/setupStatus.ts`: memory-provider readiness block (active provider, secret presence, kind)
- Setup wizard + readiness well-formed property tests updated
- `src/public/app.js`: wizard surfaces memory-provider checklist item

### 2C — Deep planning toggle (`2de04cc`)
- Composer toggle (external mode only) sends `deepPlanning: true` on message POST
- `src/public/index.html` + `base.css`: toggle UI
- `tests/deepPlanningToggle.dom.test.ts`

### 2D — Episodic notes quick-capture (`dd8a71f`)
- Composer-adjacent note capture → `POST /api/notes` (redacted server-side)
- `tests/notesCapture.dom.test.ts`

### 2E — Trace drawer neuro phases (`6e25520`)
- Trace drawer cards for SLM preprocessor, symbolic validation, deep planner, task decomposition, ponder/subconscious
- Proactive message badge (`source: "proactive"`)
- `tests/traceNeuro.dom.test.ts`

### 2F — Memory provider settings panel (`a22c6e7`)
- Settings → Memory providers panel (cards, active toggle, upsert, delete, test-connection)
- `tests/memoryProviderPanel.dom.test.ts`

## Wave 3 — Security, performance, docs (this wave)

### 3A — Security hardening
- Verified `/api/memory-providers/*` and `/api/notes` use `sendRedacted`/`redactOutbound` on all outbound bodies (including 404/error paths)
- `EPISODIC_MEMORY_SEARCH_LIMIT = 6` constant in `server.ts` bounds episodic search for chat context injection
- `docs/security/dependency-audit-2026-06-04.md`: status note that `vitest@4` upgrade remains deferred (2026-06-10)

### 3B — Performance verification
- `getMemoryProvider()` confirmed single-resolve cache per app lifetime (not re-resolving per call)
- `proactiveAgent.startTimer()` and `backgroundHooks.startIdleTimer()` both call `timer.unref?.()` so background timers do not keep the process alive

### 3C — Documentation
- This plan doc
- `docs/plans/concerns-and-vulnerabilities.md`: prune property gap RESOLVED; pluggable memory UI vision partially resolved
- `AGENTS.md`: chunks through 036, updated test baseline

## Verification

```bash
npm test
npm run build
```

## All commits (chronological)

| Hash | Message |
|------|---------|
| `f0d1209` | test(chunk-036): add prune survival invariant property tests |
| `c98cf03` | feat(chunk-036): add memory provider Settings API with secret egress tests |
| `0ba4ec3` | feat(chunk-036): inject memoryContext into LLM prompts and account preprocessor usage |
| `36b7f72` | feat(chunk-036): expose memory provider readiness in setup status and wizard |
| `2de04cc` | feat(chunk-036): add opt-in deep planning toggle for external mode chat |
| `dd8a71f` | feat(chunk-036): add episodic notes quick-capture UI |
| `6e25520` | feat(chunk-036): extend trace drawer with neuro-symbolic phases and proactive badge |
| `a22c6e7` | feat(chunk-036): add memory provider configuration panel in settings UI |
| `65812d4` | feat(chunk-036): add memory entries list API and browser panel |
| `7ed68bd` | feat(chunk-036): update index meta for cloud-capable product framing |
| `7a40467` | chore(chunk-036): security hardening for memory API and prompt size guards |
| `35dd1cc` | perf(chunk-036): verify memory provider caching and bound context injection |
| *(latest)* | docs(chunk-036): add chunk plan and update concerns register |

## Verification (Wave 3 close)

```
npm test   → 211 files / 1355 tests passing
npm run build → clean
```

## Deferred / follow-on

- Live Mem0/Chroma/TiDB integration tests against real services (stack credits)
- Event-driven ponder/proactive triggers vs fixed idle timers
- Durable-store prune parity property tests (sqlite/tidb paths)
- `vitest@4` major upgrade (maintainer approval required per dependency audit)