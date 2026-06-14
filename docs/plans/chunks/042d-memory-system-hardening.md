# Chunk 042d — Memory System Hardening

> Created: 2026-06-12
> Phase: 4 of 6
> Components: TiDB, Mem0, Chroma, Truth Library

## Goal

Make Rector's memory subsystem reliable across local, durable SQL, and optional
external memory providers while preserving zero-config local mode.

## Scope

### In Scope

- `src/store/sqlRectorStore.ts`
- `src/store/tidbRectorStore.ts`
- `src/store/index.ts`
- `src/memory/tidbMemoryAdapter.ts`
- `src/memory/mem0Adapter.ts`
- `src/memory/chromaMemoryAdapter.ts`
- `src/memory/truthLibrary.ts`
- provider config / memory bridge as needed
- live smoke tests behind env flags

### Out of Scope

- Full UI redesign of memory provider panel
- Billing/quota enforcement beyond existing memory budget hooks
- Production vector DB migration tooling beyond adapter contract

## Design Principles

1. **Local default never requires network.** In-memory/SQLite stays zero-config.
2. **Adapters share one contract.** Mem0, Chroma, TiDB, and local providers must pass common contract tests.
3. **Optional dependencies remain optional.** Build/tests pass without `mem0ai`, `chromadb`, or MySQL client packages unless live tests are explicitly enabled.
4. **Redaction before persistence.** No secret/PII leaks into memory or adapter errors.
5. **Durable parity.** SQL/TiDB must support the same advanced memory methods as in-memory.

## Work Items

### 1. SQL/TiDB Advanced Memory Parity

- Verify and complete `RectorStore` advanced memory methods in `SqlRectorStore`:
  - `createMemoryEntry`
  - `getMemoryEntry`
  - `listMemoryEntries`
  - `updateMemoryEntry`
  - `deleteMemoryEntry`
  - `searchMemory`
  - `pruneMemory`
- Ensure TiDB driver path inherits same methods through `SqlRectorStore`.
- Add migration/table verification for memory tables.
- Add tests:
  - in-memory and SQL store pass same memory contract
  - TiDB driver double passes same contract
  - prune behavior deterministic with injected clock

### 2. Startup Migration Wiring

Existing concern: `runStartupMigration` exists but may not be invoked on live boot.

- Wire startup migration before server listens when persistence driver is SQL/TiDB.
- Ensure migration failure:
  - halts boot
  - redacts secrets
  - classifies timeout/config/driver errors
- Add tests:
  - `bin/server.ts` boot path invokes migration
  - bad TiDB config halts before listen
  - memory driver skips migration

### 3. Memory Provider Contract Test Suite

Create a shared contract suite for any `MemoryProvider`:

- create/get/list/update/delete roundtrip
- search by content/query/layer
- metadata preservation
- pruning semantics
- redaction behavior
- error classification
- no network in local provider

Apply to:

- local in-memory provider
- local SQL provider/delegate
- TiDB provider with injected delegate
- Mem0 adapter with fake client
- Chroma adapter with fake collection/client

### 4. Mem0 Hardening

- Validate config/secret errors early and redacted.
- Normalize multiple SDK result shapes.
- Preserve metadata and layer fields.
- Add budget checks around every write/search if costed.
- Add optional live smoke:
  - env-gated
  - creates test memory
  - searches
  - deletes/cleans up
  - skipped by default

### 5. Chroma Hardening

- Validate collection naming and base URL.
- Normalize query result distances and metadata.
- Enforce result limits.
- Add metadata filter tests.
- Add optional live smoke skipped by default.

### 6. Truth Library Hardening

- Add hybrid scoring:
  - exact title/tag match
  - token overlap
  - recency
  - trusted provenance boost
  - rejected/stale penalty
- Add citation/provenance validation helpers.
- Add adapter-neutral `TruthRetriever` interface for future vector backend.
- Add tests:
  - rejected excluded by default
  - trusted citation outranks unverified
  - stale docs penalized
  - deterministic ranking

## Tests

Run:

```bash
npm test
npm run build
npm audit
```

Optional live tests only when env configured:

```bash
npm run smoke:memory
npm run smoke:tidb
```

Target tests:

- `tests/memoryProviderContract.test.ts`
- `tests/sqlMemoryParity.test.ts`
- `tests/tidbStartupMigrationBoot.test.ts`
- `tests/mem0AdapterHardening.test.ts`
- `tests/chromaAdapterHardening.test.ts`
- `tests/truthLibraryHardening.test.ts`

## Acceptance Criteria

- SQL/TiDB memory reaches parity with in-memory memory methods.
- Startup migration is invoked before server listen for SQL/TiDB persistence.
- Mem0/Chroma/TiDB adapter contract tests pass with fakes.
- Optional live tests remain skipped unless explicitly configured.
- Truth library ranking improves without adding external dependency.
- `npm test`, `npm run build`, and `npm audit` pass.

## Commit

Suggested commit:

```text
feat(chunk-042d): harden memory providers
```
