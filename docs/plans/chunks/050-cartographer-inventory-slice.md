# Chunk 050 — Cartographer Inventory Slice

> **Created:** 2026-06-20
> **Phase:** Configured Product Cartographer Foundation
> **Depends on:** Chunk 049 (security vulnerability resolution)
> **Branch:** `rector-0.3.0-cartographer`
> **Worktree:** `.worktrees/rector-0.3.0-cartographer`

## Goal

Ship the deterministic Cartographer repository inventory slice: a public API that scans a repository into stable file inventory data, applies safety-first ignore rules, supports full and incremental scans, emits optional progress events without coupling callers to the emitter, and persists inventory through in-memory or SQLite stores.

## What Was Implemented

- **T0 — foundation:** Added Cartographer schemas, types, and the `ignore` npm dependency for `.gitignore` / `.rectorignore` matching.
- **T1 — data model:** Added `FileNode`, `RepoSnapshot`, `ScanResult`, `IgnoredFileRef`, `ScanError`, scan event, and inventory-store contracts.
- **T2 — ignore policy:** Added built-in ignores, env-file protection, size cap, binary/generated detection, symlink skipping, root `.gitignore`, and root `.rectorignore` support.
- **T3 — classifier:** Added deterministic file-kind and language classification for source, test, config, docs, generated, fixture, asset, binary, lockfile, vendor, and unknown files.
- **T4 — hasher:** Added SHA-256 hashing helpers for files, buffers, strings, and scanner `FileReader` hashing.
- **T5 — repo scanner:** Added `scanRepository` full scans with deterministic path ordering, ignored-directory pruning, stable snapshot fingerprints, optional emitter events, and recoverable error collection.
- **T6 — in-memory inventory store:** Added `InMemoryCartographerInventoryStore` for deterministic tests and local inventory persistence.
- **T7 — SQLite inventory store:** Added `SqliteCartographerInventoryStore` backed by the existing SQLite driver with snapshot, file, and error tables.
- **T8 — incremental indexer:** Added `scanChangedFiles` with hash-first changed-file detection, hard-delete detection, became-ignored deletion semantics, optional `fastPrecheck`, store persistence, and deterministic emitter ordering.
- **T9 — finalization:** Confirmed the public barrel is complete, confirmed emitter error isolation and event ordering, added public API and integration determinism tests, and documented limitations in the concerns register.

## Public API

`src/cartographer/index.ts` exports the complete Cartographer surface:

### Schemas

- `FileKindSchema`
- `LanguageIdSchema`
- `IgnoreSourceSchema`
- `ScanStageSchema`
- `IgnoreDecisionSchema`
- `FileNodeSchema`
- `RepoSnapshotSchema`
- `ScanErrorSchema`
- `IgnoredFileRefSchema`
- `ScanResultSchema`
- `ScanSummarySchema`
- `CartographerScanEventSchema`

### Constants and Types

- `DEFAULT_HEAD_SNIFF_BYTES`
- `DEFAULT_MAX_FILE_SIZE_BYTES`
- `isCurrentlyIgnored`
- `CartographerInventoryStore`
- `CartographerScanEmitter`
- `CartographerScanEvent`
- `ClassifyFileInput`
- `CreateSnapshotInput`
- `FileKind`
- `FileNode`
- `FileReader`
- `IgnoreDecision`
- `IgnoreFileInput`
- `IgnoreMatcher`
- `IgnoredFileRef`
- `IgnoreSource`
- `LanguageId`
- `LoadIgnoreMatchersResult`
- `RepoSnapshot`
- `ScanChangedFilesInput`
- `ScanError`
- `ScanRepositoryInput`
- `ScanResult`
- `ScanStage`
- `ScanSummary`

### Ignore, Classification, Hashing, Stores, and Scans

- `MAX_IGNORE_FILE_BYTES`
- `loadIgnoreMatchers`
- `shouldIgnoreFile`
- `classifyFile`
- `hashFile`
- `hashBuffer`
- `hashString`
- `hashViaReader`
- `InMemoryCartographerInventoryStore`
- `InMemoryCartographerInventoryStoreOptions`
- `SqliteCartographerInventoryStore`
- `SqliteCartographerInventoryStoreOptions`
- `scanRepository`
- `scanChangedFiles`
- `buildScanSummary`

## Data Structures

- **`FileNode`:** Normalized repository-relative file record with stable id, `path` / `normalizedPath`, SHA-256 hash, size, optional mtime, language, kind, ignored flag, optional ignore reason, and `lastIndexedAt`.
- **`RepoSnapshot`:** Stable snapshot summary with id, repo root, creation timestamp, total file count, indexed/ignored counts, deleted count, and changed count.
- **`ScanResult`:** Full scanner output containing the snapshot, indexed files, changed files, deleted paths, ignored references, and recoverable/non-recoverable scan errors.
- **`IgnoredFileRef`:** Repository-relative ignored path with reason, source, and `isDirectory` so descendant inventory can be treated as ignored/deleted.
- **`ScanError`:** Recoverable or fatal scanner error with path, stage (`walk`, `read`, `hash`, `classify`, `store`), and message.
- **`CartographerInventoryStore`:** Persistence interface for listing snapshots/files/errors, upserting files, removing files, creating snapshots, and recording scan errors.

## Full vs. Incremental Behavior

- **`scanRepository`:** Performs a full walk from the repository root, prunes ignored directories before recursion, hashes every non-ignored file, classifies each indexed file, and returns a deterministic `ScanResult` without writing to an inventory store.
- **`scanChangedFiles`:** Performs the same walk and hash-first file build, compares against the provided `CartographerInventoryStore`, reports only newly added or hash-changed files in `changedFiles`, reports removed or newly ignored prior paths in `deletedFiles`, then persists files, deletions, snapshots, and errors.
- **Default correctness mode:** Incremental scans always hash current non-ignored files and use the hash as the sole change signal.
- **`fastPrecheck` weaker mode:** If `fastPrecheck` is enabled, a prior file with matching size and mtime can skip hashing. This improves speed but can miss same-size content edits that preserve mtime.

## Ignore Rules

- Built-in ignored segments include `.git`, `node_modules`, `dist`, `build`, `coverage`, `.next`, `.turbo`, `.cache`, `out`, `tmp`, `temp`, `.worktrees`, and `.omo`.
- Built-in ignored basenames include `.DS_Store`, `Thumbs.db`, and `desktop.ini`.
- Root `.gitignore` and root `.rectorignore` are loaded through the `ignore` package. Nested `.gitignore` files are deferred.
- Env files matching `.env` and `.env.*` are ignored before any head or full-file read. `.env.example` is explicitly indexed as config.
- Ignored directories are emitted once as directory refs and are not recursed, so descendants such as `node_modules/ignored/index.js`, `dist/generated.js`, and `.git/HEAD` do not appear separately.
- Files above `DEFAULT_MAX_FILE_SIZE_BYTES` (5 MiB) are ignored by default.
- Binary and generated files are detected from head bytes/markers after path-level ignores have already run.

## Emitter Semantics

- `scanRepository` and `scanChangedFiles` accept an optional `emitter`.
- With no emitter, scan results are identical to scans with a no-op emitter when the clock and fixture are pinned.
- The full event set is `CARTOGRAPHER_SCAN_STARTED`, `CARTOGRAPHER_FILE_INDEXED`, `CARTOGRAPHER_FILE_IGNORED`, `CARTOGRAPHER_FILE_DELETED`, `CARTOGRAPHER_SCAN_COMPLETED`, and `CARTOGRAPHER_SCAN_FAILED`.
- Per-entry output events are emitted in deterministic UTF-16 path order. Incremental deletion events are emitted after per-entry events in ascending deleted-path order.
- Emitter errors are isolated by `emitSafely`: thrown or rejected emitter calls are swallowed and appended to `ScanResult.errors` as recoverable `ScanError` records with `stage: "store"` and `message` beginning with `"emitter failed:"`. Emitter failures never alter `files`, `changedFiles`, `deletedFiles`, or `snapshot`.

## Tests

- `tests/cartographer/fileClassifier.test.ts`
- `tests/cartographer/fileHasher.test.ts`
- `tests/cartographer/ignorePolicy.test.ts`
- `tests/cartographer/inventoryStore.inMemory.test.ts`
- `tests/cartographer/inventoryStore.sqlite.test.ts`
- `tests/cartographer/repoScanner.test.ts`
- `tests/cartographer/incrementalIndex.test.ts`
- `tests/cartographer/publicApi.test.ts`
- `tests/cartographer/types.test.ts`
- `tests/cartographer/cartographer.integration.test.ts`

## Limitations and Deferred Work

- **`fastPrecheck` caveat:** `fastPrecheck` can miss a same-size edit that preserves mtime because it skips hashing when size and mtime match. Default mode remains hash-first and correctness-first.
- **Root-only ignore files:** Only repo-root `.gitignore` and `.rectorignore` are loaded in this slice. Nested `.gitignore` files are deferred.
- **Synchronous SQLite:** `SqliteCartographerInventoryStore` uses synchronous `node:sqlite` driver calls, which can block on very large repositories.
- **Size cap:** Files larger than `DEFAULT_MAX_FILE_SIZE_BYTES` (5 MiB) are ignored by default.
- **Limited language set:** `LanguageId` is a fixed extension-to-language mapping; unknown extensions classify as `"unknown"`.
- **No graph coupling yet:** This slice intentionally does not add AST parsing, graph construction, LLM integration, UI integration, or planner coupling.
