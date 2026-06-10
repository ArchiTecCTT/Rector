# Chunk 34 — UI-Configurable Pluggable Memory Providers (Cloud-Capable Transition, adapted for hassle-free vision)

## Goal
Extend the cloud-capable transition so memory database providers are fully configurable via the web UI in a hassle-free way (no file/env edits for normal users). Support pluggable backends: local (in-memory, SQLite, file-based), Mem0, TiDB Cloud, and future options. Keep architecture non-rigid. Local mode remains unaffected (uses simple local defaults).

This adapts the existing cloud-capable-transition spec (which already has excellent UI-managed provider config for LLMs) and the neuro-symbolic memory work (Chunk 27) to the user's explicit requirement.

## Scope
- Define a "Memory Provider" config pattern mirroring Provider_Config_Store + Secret_Store (non-secret records + encrypted secrets).
- Create MemoryProvider interface / registry (local implementations + stubs for Mem0, TiDB-backed memory).
- Update/create UI/Settings_API surfaces for selecting and configuring memory provider (similar to /api/providers).
- Wire the existing advanced memory (hierarchical layers, notes, prune, time-awareness from 27) behind the pluggable provider.
- Ensure local mode always uses a zero-config local default and never touches external memory providers or network.
- Add tests (property-based for config roundtrip, local isolation).
- Update docs, AGENTS, concerns.
- Integrate with broader persistence (RECTOR_PERSISTENCE can influence default memory provider).
- Run verification.

Non-goals: Full Mem0 or TiDB client implementation in this chunk (stubs + interfaces first; use credits later). Complete E2B or other unrelated cloud items (those in parallel or follow-on chunks).

## Implementation Plan
1. Extend config model (src/providers/config.ts or new memory config) with MemoryProviderRecord (kind: 'local-inmemory' | 'local-sqlite' | 'mem0' | 'tidb-memory' etc., label, options, secretRef).
2. Create Secret handling for memory credentials (e.g. Mem0 API key, TiDB creds for memory use).
3. Define MemoryProvider interface (in src/memory/) with methods matching current needs (upsert, search, list, prune, etc.).
4. Implement local adapters (reuse/extend existing InMemory + truth library logic).
5. Stub external (Mem0, TiDB) following the pattern of E2B stub / discovery adapters (dynamic require, clear error if missing dep).
6. Add Settings_API endpoints for memory providers (list, create/update, test, select active).
7. Update store creation and memory initialization to use the configured provider (in createRectorStore or a new MemoryProviderStore bridge).
8. Ensure Chunk 27 memory code (hierarchical, notes endpoint, context injection) works transparently behind the provider.
9. Add local-mode guards and property tests (no external calls, deterministic).
10. Update .env.example, quickstarts, concerns, and any relevant docs.
11. Verification + commit as 34.

## Acceptance Criteria
- Memory provider (including type and config) selectable/configurable via UI (or API equivalent for now).
- Local mode uses simple local default, zero network, identical behavior.
- Pluggable: easy to add new kinds without core changes.
- Neuro memory features (27) continue to work.
- Tests pass, build green.
- Aligns with non-rigid, hassle-free vision.

## Risks / Concerns
- See updated entry in concerns-and-vulnerabilities.md (pluggable memory via UI).
- Data migration when switching providers.
- Cost/security for cloud memory backends (redaction, access control).
- Performance for different backends in context/preprocessor injection.

## References
- .kiro/specs/cloud-capable-transition/ (UI config pattern for providers)
- Chunk 27 (advanced memory)
- User's requirements: hassle-free web UI config for memory DB providers (local/Mem0/TiDB cloud), non-rigid architecture.
- Stack credits: Mem0, TiDB, Chroma for adapters.

This chunk makes the "configure your own agent memory database provider" vision real while advancing the overall cloud-capable transition.