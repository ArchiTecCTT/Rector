# Chunk 27 — Advanced Memory System (Neuro-Symbolic Step 2)

## Goal
Implement the foundational advanced memory layer for Rector as a personal neuro-symbolic second brain. This enables time-aware, hierarchical, self-improving memory that feeds into the preprocessor, context, and future pondering/reflection. Start with core store extensions, pruning, quick-capture notes, and time-awareness. Full ponder swarm and subconscious daemon deferred to Step 6.

## Scope (Step 2 core)
- Define and implement `MemoryStore` interface (extend `RectorStore` or compose).
- Hierarchical memory layers in `InMemoryRectorStore` (and compatible with other stores):
  - Working memory (short-term, recent context).
  - Episodic memory (events, user notes, run outcomes with timestamps).
  - Core/Semantic memory (consolidated, high-value facts, summaries).
- `selfPruneMemory()`: scoring based on recency + usage frequency + symbolic rules + (future vector similarity). Drop or summarize low-value items. Runs on demand or periodically.
- Quick-capture notes: `POST /api/notes` endpoint (simple, authenticated in local mode) that writes to episodic layer with metadata.
- Time-awareness: Every memory entry has `timestamp`, `lastMentioned`, `accessCount`. Inject natural language time context into `ContextPack` and preprocessor input (e.g., "3 days ago you noted...").
- Integration points:
  - Enrich `ContextPack` with recent/relevant memory summaries (time-aware).
  - Pass richer memory signals to `runSLMPreprocessor` (for Step 1 integration).
  - Ponder results (basic for now) write back via existing `transitionRun` + redaction.
- Local/in-memory first, provider-free baseline preserved. Stubs for Chroma (using existing adapters) and future Mem0.
- Unit + property tests. Update concerns register.
- Commit as separate chunk.

## Non-goals (this chunk)
- Full ponder/dreaming swarm + subconscious daemon (Step 6).
- Vector embeddings / real Chroma usage (keep stubs + in-memory keyword for now; leverage existing truthLibrary).
- Durable persistence for new memory entities (use existing Artifact/RunEvent where possible; durable in later chunks).
- Proactive layer, MCTS, decomposition, or concurrent execution (later steps).
- Changes to local fake chat run path or any provider-free determinism.
- UI for notes (just the API endpoint; UI can follow).
- Production auth for /api/notes (local-only for alpha).

## Background / Rationale
Chunk 19 delivered basic Truth Library (keyword + provenance). Architecture roadmap places rich episodic/semantic/procedural memory in 0.4.x, but the neuro-symbolic vision accelerates it for the "self-improving over time" goal while keeping symbolic control in charge.

The provided stack credits (Chroma $5K, Mem0 3 months pro, Together AI for SLMs, Azure/Cloudflare, TiDB/Mongo, etc.) enable optional real backends later. Local mode (`ORCHESTRATOR_MODE=local`) and all budget/redaction/sandbox rules remain the default, zero-cost baseline.

Memory will make the system "know context from days ago", support quick capture, and feed better `distilledContext` to the Step 1 preprocessor.

## Implementation Plan (incremental, testable)
1. Extend schemas (src/store/schemas.ts) with `MemoryEntry` (or reuse/extend Artifact + add fields). Add types for layers, timestamps, scores.
2. Define `MemoryStore` interface (in src/store/index.ts or new src/memory/store.ts). Methods: upsertMemory, searchMemory, pruneMemory, getRecentEpisodic, etc.
3. Extend `InMemoryRectorStore` (and update `RectorStore` interface) with memory collections (maps for working/episodic/core). Implement basic CRUD + `selfPruneMemory()`.
   - Scoring: recency (decay), accessCount, symbolic (e.g., user notes > run events > low-value), future hook for similarity.
   - Prune: remove low-score items or summarize into core layer (simple text summary for alpha).
4. Add time-awareness helpers: functions to format "X days ago", update lastMentioned on access.
5. Implement quick-capture: `POST /api/notes` in src/api/server.ts. Accepts { content, tags? }, writes to episodic layer via store, returns the entry. Redact content. Local-only for now.
6. Update `buildContextPack` (src/orchestration/contextBuilder.ts): Add optional memory context injection. Pull recent episodic + high-value core, add time phrases. Expose via `relevantMemory` or new `memoryContext` field (keep backward compat).
7. Wire into chat flow (src/api/server.ts around message POST): After building basic contextPack, enrich with memory before passing to `runChat` / preprocessor.
8. Light integration with preprocessor: Pass memory summaries in the preprocessor input so distilledContext can reference "you previously noted...".
9. Add tests: 
   - Unit tests for store memory ops, pruning logic, time formatting.
   - Property tests (fast-check) for pruning invariants (e.g., high-score items never dropped, time fields always present).
   - API test for /api/notes (redaction, storage).
   - Update existing context builder / chat tests if behavior changes (should be additive).
10. Update `docs/plans/concerns-and-vulnerabilities.md` with new entries (e.g., memory growth, pruning correctness, note capture as new attack surface for redaction).
11. Run `npm test` + `npm run build` (or equivalent in env). Commit as Chunk 27.

## Acceptance Criteria
- New/updated plan: `docs/plans/chunks/027-advanced-memory-system.md`.
- `MemoryStore` interface + impl in InMemoryRectorStore (hierarchical layers, prune, time fields).
- `POST /api/notes` works, writes to episodic, respects redaction.
- ContextPack and preprocessor receive time-aware memory signals (visible in traces/payloads).
- selfPruneMemory() implemented and testable (can be called manually or on note write).
- Tests pass (unit + at least one new property test for memory invariants).
- `npm test` and `npm run build` succeed (local mode unchanged).
- Concerns register updated.
- Clean commit for the chunk (no unrelated files).

## Risks / Follow-ups (track in concerns)
- In-memory only for alpha → growth limits; durable (Mongo/TiDB/Chroma/Mem0) later.
- Pruning quality: symbolic rules + simple scoring first; vector similarity when Chroma/Mem0 integrated.
- Notes as user input → must be redacted at every boundary (reuse existing redaction).
- Time context in prompts: keep concise to avoid bloat (preprocessor will help distill).
- Backward compat for existing ContextPack / stores.

## Integration Note for Later Steps
This chunk sets up the memory substrate for:
- Step 3 (Proactive): Read open runs + memory for check-ins.
- Step 6 (Ponder): Use episodic + notes for reflection swarm.
- Step 1 preprocessor: Richer input for better distillation.
- Future: Mem0/Chroma adapters (using existing stub pattern), vector search in prune/search.

All under symbolic control: memory writes go through redaction + store, reads are filtered for relevance + recency, no bypass of budget or sandbox.

## Verification Commands
```bash
npm test
npm run build
```

## References
- User neuro-symbolic prompt (Step 2 spec).
- Chunk 19 (Truth Library baseline).
- src/memory/*, src/store/*, src/api/server.ts, src/orchestration/contextBuilder.ts, src/orchestration/chatRunner.ts (preprocessor integration).
- Architecture: small models first, evidence, self-healing, local provider-free default.
- Stack credits: Chroma, Mem0, Together (SLM), Azure/Cloudflare, TiDB/Mongo for future durable memory.