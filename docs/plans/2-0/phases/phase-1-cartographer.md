# Phase 1 — Cartographer Test, Harden, and Expand Plan

**Repository:** `ArchiTecCTT/Rector`  
**Base branch:** `rector-0.3.0`  
**Source state:** after merged PR #17 / merge commit `14b2aeda544f010e79b300c87d34fd16de4dea01`  
**Status:** implementation plan  
**Phase:** 1 — Cartographer test, harden, then expand

## Decision

Phase 1 is **not** "build Cartographer from zero." The current source already has a deterministic Cartographer file-inventory slice. Phase 1 should now be:

```text
Phase 1A - Close and harden the existing file inventory layer.
Phase 1B - Add deterministic Rector self-scan artifacts and gates.
Phase 1C - Expand from file inventory to structural code graph.
Phase 1D - Register tools/capabilities as graph nodes and expose Cartographer queries.
```

This preserves the production plan's requirement that Cartographer is tested, hardened, and expanded before later typed facts, Memory OS, Capability-SLM Fabric, rules, planner/skeptic, and DAG phases are built on top of it.

## Current source-grounded baseline

The repository is currently `rector` version `0.3.0-alpha.1`, and `package.json` already exposes `./cartographer` as a public package export.

The merged Phase 0 / 0.5 foundation added or confirmed these scripts:

```text
npm run check
npm test
npm run verify:phase0
npm run verify:phase0.5
npm run verify:foundation
npm run audit:no-fakes
npm run eval:capabilities:gate
npm run test:global
npm run test:systems
```

The current Cartographer public barrel exports:

```text
schemas
ignore policy
file classifier
file hasher
in-memory inventory store
SQLite inventory store
full repository scan
incremental changed-file scan
scan summary builder
```

The core data model is still file-inventory level:

```text
FileNode
RepoSnapshot
ScanResult
ScanError
IgnoredFileRef
CartographerScanEvent
CartographerInventoryStore
```

The SQLite store currently persists only:

```text
cartographer_snapshots
cartographer_files
cartographer_scan_errors
```

The existing Cartographer slice explicitly does **not** yet include AST parsing, graph construction, LLM integration, UI integration, planner coupling, or full structural code graph behavior.

## Non-negotiable Phase 1 boundaries

Do **not** implement these in Phase 1:

```text
RegoloAIProvider
Capability-SLM manager
planner/skeptic ensembles
typed fact blackboard
rule engine / Crucible gates
validation-aware DAG executor
Memory OS
pondering daemon swarm
production fake purge
neural summaries inside Cartographer
live provider scenarios as required CI
```

Phase 1 must remain deterministic, provider-free, and testable in local CI.

---

# Phase 1A — File inventory hardening and test closure

## Goal

Make the existing file-inventory Cartographer trustworthy enough to become the substrate for structural graph work.

The required hardening surface is:

```text
deterministic sorted output
.gitignore / .rectorignore precedence
binary detection
generated/vendor/lockfile classification
hash changes
deleted files
symlinks
path normalization
large-file ignores
recoverable read errors
SQLite/in-memory parity
scan event order
snapshot immutability
```

## Current source state

A substantial part of Phase 1A already exists after PR #17:

```text
tests/cartographer/repoScanner.test.ts
tests/cartographer/ignorePolicy.test.ts
tests/cartographer/fileClassifier.test.ts
tests/cartographer/fileHasher.test.ts
tests/cartographer/inventoryStore.inMemory.test.ts
tests/cartographer/inventoryStore.sqlite.test.ts
tests/cartographer/incrementalIndex.test.ts
tests/cartographer/publicApi.test.ts
tests/cartographer/types.test.ts
tests/cartographer/cartographer.integration.test.ts
```

Existing coverage already includes deterministic fixture scans, ignored env files, symlink skipping, sorted outputs, event ordering, no-read safety for `.env.production`, in-memory and SQLite incremental store parity, added/modified/deleted file detection, became-ignored deletion semantics, and retained prior inventory on recoverable hash failure.

## Phase 1A coverage checklist

This checklist maps every required Phase 1A hardening case (the list under "The required hardening surface is") to its coverage status. Status values are used exactly as: `covered by existing test`, `covered by new test`, `intentionally deferred with reason`. No row claims completion unless backed by a concrete test path and short behavior description. Cases whose focused coverage is explicitly assigned to a later todo are deferred here.

- deterministic sorted output: covered by existing test — `tests/cartographer/repoScanner.test.ts:25` ("indexes, ignores, sorts, emits, and remains deterministic for the fixture repo") asserts `isSortedUtf16` on files/changedFiles/ignoredFiles and exact fixture order.
- .gitignore / .rectorignore precedence: covered by existing test — `tests/cartographer/ignorePolicy.test.ts:69` ("respects gitignore before rectorignore and supports trailing slash directory patterns") exercises root gitignore winning overlaps and rectorignore filling gaps.
- binary detection: covered by existing test — `tests/cartographer/fileClassifier.test.ts:39` ("classifies NUL-containing head buffers as binary") and `ignorePolicy.test.ts:92` (binaryDecision source "binary").
- generated/vendor/lockfile classification: covered by existing test — `tests/cartographer/fileClassifier.test.ts:16` ("classifies required source, test, config, doc, asset, lockfile, generated, and unknown cases") and priority-order test at :50 covering vendor/generated/lockfile.
- hash changes: covered by existing test — `tests/cartographer/incrementalIndex.test.ts:49` ("detects added files and byte modifications by hash") and :71 ("detects same-size byte edits even when mtime is restored").
- deleted files: covered by existing test — `tests/cartographer/incrementalIndex.test.ts:33` (deletedFiles expectations, became-ignored deletion semantics) plus plan baseline "added/modified/deleted file detection".
- symlinks: covered by existing test — `tests/cartographer/repoScanner.test.ts:54` (fixture creates symlink; ignored ref has source "symlink"; descendants not emitted or read).
- path normalization: covered by existing test — `tests/cartographer/repoScanner.test.ts:74` ("normalizes backslash paths and caps head-sniff reads") plus harness `normalizedFromRoot`.
- large-file ignores: covered by new test — `tests/cartographer/repoScanner.test.ts:153` ("ignores files above DEFAULT_MAX_FILE_SIZE_BYTES before calling readAll and records them exactly once with source size_limit") plus harness `writeOversizedFile`; `ignorePolicy.test.ts:99` asserts `size_limit` source. Scanner-level contract (no readAll, single ignored ref) is exercised and locked by Todo 4.
- recoverable read errors: covered by existing test — `tests/cartographer/repoScanner.test.ts:99` (hash/read/walk/emit recoverable failures; "retained prior inventory on recoverable hash failure") and `ignorePolicy.test.ts:123` (oversized root gitignore treated as absent with recoverable error).
- SQLite/in-memory parity: covered by existing test — `tests/cartographer/incrementalIndex.test.ts:31` (identical expectations exercised for both "in-memory" and "sqlite" stores); dedicated `inventoryStore.sqlite.test.ts` / `inventoryStore.inMemory.test.ts` cover snapshot/file/error roundtrips.
- scan event order: covered by existing test — `tests/cartographer/repoScanner.test.ts:69` (events.map(labelForEvent) equals expectedFixtureEvents); `cartographer.integration.test.ts` confirms sorted per-entry event ordering.
- snapshot immutability: covered by existing test — `tests/cartographer/repoScanner.test.ts:71` (identical scans produce identical snapshot.id); `incrementalIndex.test.ts:66` (content change yields new id); stores derive deterministic id from payload (see `inventoryStore.*.test.ts` createSnapshot).

## Required work

### 1. Add a Phase 1A coverage checklist

Create or maintain this document as the canonical checklist:

```text
docs/plans/2-0/phases/phase-1-cartographer.md
```

Map every required Phase 1A case to one of:

```text
covered by existing test
covered by new test
intentionally deferred with reason
```

No implementation PR should claim Phase 1A complete without this checklist.

### 2. Add explicit large-file ignore coverage if not already isolated

The source supports a default 5 MiB max file size. If large-file ignore behavior is not already tested directly, add a focused test in:

```text
tests/cartographer/ignorePolicy.test.ts
```

Acceptance criteria:

```text
files above DEFAULT_MAX_FILE_SIZE_BYTES are ignored
ignored source is size_limit
scanner does not call readAll for ignored oversized files
scan result records the ignored file exactly once
```

### 3. Add explicit nested `.gitignore` limitation coverage

Current behavior loads only root `.gitignore` and root `.rectorignore`; nested `.gitignore` support is deferred.

Add a test that locks this as intentional behavior so contributors do not assume nested ignore semantics are supported.

Acceptance criteria:

```text
root .gitignore is applied
root .rectorignore is applied
nested .gitignore is not applied
behavior is documented as deferred, not accidental
```

### 4. Add SQLite persistence atomicity expectations

`scanChangedFiles` persists snapshot/errors/files/deletions after diffing. Before graph tables are added, define the persistence boundary clearly.

Either:

```text
implement explicit SQLite transaction handling
```

or:

```text
document the current non-transactional boundary and test it honestly
```

No fake atomicity claim is allowed.

### 5. Keep tests provider-free

Phase 1A must not require:

```text
Regolo
OpenAI
MCP servers
live network access
external credentials
```

## Exit criteria

Phase 1A is complete only when these pass:

```text
npm run check
npm test -- tests/cartographer
npm run verify:foundation
```

---

# Phase 1B — Deterministic Rector self-scan

## Goal

Run Cartographer on the Rector repository itself and produce auditable artifacts.

Required outputs:

```text
.rector/cartographer/latest-snapshot.json
.rector/cartographer/latest-files.json
.rector/cartographer/scan-report.md
```

## Required implementation

Add:

```text
scripts/cartographer/run-self-scan.ts
scripts/cartographer/check-self-scan.ts
src/cartographer/selfScanReport.ts
tests/cartographer/selfScanReport.test.ts
tests/cartographer/liveRepo.test.ts
```

Add package scripts:

```json
{
  "cartographer:self-scan": "tsx scripts/cartographer/run-self-scan.ts",
  "cartographer:self-scan:check": "tsx scripts/cartographer/check-self-scan.ts"
}
```

## Self-scan report schema

Initial report contract:

```ts
type CartographerSelfScanReport = {
  schemaVersion: "rector.cartographer.selfScan.v1";
  repoRoot: string;
  snapshotId: string;
  generatedAt: string;
  indexedFileCount: number;
  ignoredFileCount: number;
  deletedFileCount: number;
  changedFileCount: number;
  scanErrorCount: number;
  expectedPathChecks: Array<{ path: string; present: boolean }>;
  forbiddenPathChecks: Array<{ pathPattern: string; matched: boolean }>;
  gitComparison: {
    gitTrackedCount: number;
    cartographerIndexedCount: number;
    ignoredTrackedCount: number;
    unexplainedMissing: string[];
    unexpectedIndexed: string[];
  };
};
```

## Strict checks

The self-scan checker must fail if:

```text
src/cartographer is absent from indexed or expected path evidence
src/orchestration is absent
src/providers is absent
src/tools is absent
tests is absent
any .env or .env.* file except .env.example is indexed
node_modules, dist, build, coverage, .git, .worktrees, or .omo are indexed
scan errors are nonzero and not explicitly allowlisted with a reason
two self-scans on the same tree produce different normalized file lists after timestamp stripping
```

## Rules

The self-scan must use the real scanner, not mocked success.

Use real filesystem fixtures or the real repository tree. Compare outputs to deterministic filesystem or Git oracles. Do not mock scanner success.

## Exit criteria

Phase 1B is complete only when these pass:

```text
npm run cartographer:self-scan
npm run cartographer:self-scan:check
npm run check
npm test -- tests/cartographer
```

The generated report must show no secret/env leakage.

---

# Phase 1C — Structural graph expansion

## Goal

Move from file inventory to a deterministic code graph.

Minimum node kinds:

```text
Project
Package
Directory
File
Symbol
Function
Class
Interface
TypeAlias
Enum
Route
Test
Config
EnvironmentVariable
Doc
Tool
Capability
Skill
Rule
RunTrace
```

Minimum edge kinds:

`CALLS` is **schema-reserved** in Phase 1 (listed in `GraphEdgeKindSchema`) but **not extracted** by the deterministic Phase 1C builder; no `CALLS` edges are emitted until a later call-graph phase.

```text
CONTAINS
DEFINES
IMPORTS
EXPORTS
CALLS
REFERENCES
TESTS
HANDLES
CONFIGURES
READS
WRITES
OWNS
VIOLATES
FIXED_BY
VALIDATED_BY
DEPENDS_ON
PROVIDED_BY
WRAPPED_BY
```

## Non-negotiable constraint

Do not introduce neural summaries, SLM interpretation, or planner coupling in Phase 1C. Phase 1C should add deterministic graph extraction only.

## Required files

Add:

```text
src/cartographer/graphSchemas.ts
src/cartographer/graphTypes.ts
src/cartographer/graphIds.ts
src/cartographer/graphStore.ts
src/cartographer/inMemoryGraphStore.ts
src/cartographer/sqliteGraphStore.ts
src/cartographer/graphBuilder.ts
src/cartographer/tsSymbolExtractor.ts
src/cartographer/importExtractor.ts
src/cartographer/testLinker.ts
src/cartographer/queryService.ts
src/cartographer/graphSnapshot.ts
```

Export the new public surface from:

```text
src/cartographer/index.ts
```

All exports must be additive. Do not break the existing `./cartographer` package export.

## Graph schema

Use Zod-first schemas, matching the current strict schema style used by `src/cartographer/schemas.ts`.

Minimum schema:

```ts
export const GraphNodeKindSchema = z.enum([
  "Project",
  "Package",
  "Directory",
  "File",
  "Symbol",
  "Function",
  "Class",
  "Interface",
  "TypeAlias",
  "Enum",
  "Route",
  "Test",
  "Config",
  "EnvironmentVariable",
  "Doc",
  "Tool",
  "Capability",
  "Skill",
  "Rule",
  "RunTrace"
]);

export const GraphEdgeKindSchema = z.enum([
  "CONTAINS",
  "DEFINES",
  "IMPORTS",
  "EXPORTS",
  "CALLS",
  "REFERENCES",
  "TESTS",
  "HANDLES",
  "CONFIGURES",
  "READS",
  "WRITES",
  "OWNS",
  "VIOLATES",
  "FIXED_BY",
  "VALIDATED_BY",
  "DEPENDS_ON",
  "PROVIDED_BY",
  "WRAPPED_BY"
]);
```

Node contract:

```ts
type CartographerGraphNode = {
  id: string;
  snapshotId: string;
  kind: GraphNodeKind;
  label: string;
  path?: string;
  normalizedPath?: string;
  symbolName?: string;
  symbolKind?: "function" | "class" | "interface" | "typeAlias" | "enum" | "variable" | "export";
  language?: LanguageId;
  fileHash?: string;
  startLine?: number;
  endLine?: number;
  properties: Record<string, unknown>;
};
```

Edge contract:

```ts
type CartographerGraphEdge = {
  id: string;
  snapshotId: string;
  kind: GraphEdgeKind;
  fromNodeId: string;
  toNodeId: string;
  path?: string;
  evidence?: {
    path?: string;
    startLine?: number;
    endLine?: number;
    text?: string;
  };
  properties: Record<string, unknown>;
};
```

## Graph ID rules

IDs must be deterministic and content-addressable enough to survive repeated scans:

```text
Project node id:      project:<repo-root-hash>
File node id:         file:<repo-root-hash>:<normalized-path>
Directory node id:    dir:<repo-root-hash>:<normalized-path>
Symbol node id:       symbol:<repo-root-hash>:<normalized-path>:<export/local>:<name>:<line>
Import edge id:       edge:IMPORTS:<from-file-id>:<target-specifier>
Defines edge id:      edge:DEFINES:<file-id>:<symbol-id>
```

Never use random UUIDs for graph entities.

## Extraction scope

Implement TypeScript/JavaScript first.

Do not add a tree-sitter fallback in Phase 1 unless a separate PR justifies the dependency and test burden. For non-TS files in Phase 1C, create only file-level nodes such as `File`, `Doc`, `Config`, and `Test`.

Required deterministic extraction:

```text
Project node from repo root
Package node from package.json
Directory nodes from normalized paths
File nodes from existing FileNode inventory
Symbol nodes for TS/JS declarations
DEFINES edges from file to symbol
IMPORTS edges from source file to import specifier and resolved file when resolvable
EXPORTS edges for exported declarations and export statements
TESTS edges from *.test.ts / *.spec.ts files to likely source files by basename and import relation
DEPENDS_ON edges from files to resolved imported files
```

## SQLite graph store

Extend SQLite persistence beyond the current inventory tables.

Add:

```sql
CREATE TABLE IF NOT EXISTS cartographer_graph_nodes (
  id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  repo_root TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  path TEXT,
  normalized_path TEXT,
  symbol_name TEXT,
  symbol_kind TEXT,
  language TEXT,
  file_hash TEXT,
  start_line INTEGER,
  end_line INTEGER,
  properties_json TEXT NOT NULL,
  PRIMARY KEY(snapshot_id, id)
);

CREATE TABLE IF NOT EXISTS cartographer_graph_edges (
  id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  repo_root TEXT NOT NULL,
  kind TEXT NOT NULL,
  from_node_id TEXT NOT NULL,
  to_node_id TEXT NOT NULL,
  path TEXT,
  evidence_json TEXT,
  properties_json TEXT NOT NULL,
  PRIMARY KEY(snapshot_id, id)
);
```

Add indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_cartographer_graph_nodes_repo_kind
  ON cartographer_graph_nodes(repo_root, kind);

CREATE INDEX IF NOT EXISTS idx_cartographer_graph_nodes_repo_path
  ON cartographer_graph_nodes(repo_root, normalized_path);

CREATE INDEX IF NOT EXISTS idx_cartographer_graph_edges_repo_kind_from
  ON cartographer_graph_edges(repo_root, kind, from_node_id);

CREATE INDEX IF NOT EXISTS idx_cartographer_graph_edges_repo_kind_to
  ON cartographer_graph_edges(repo_root, kind, to_node_id);
```

## Query service

Implement the MVP query API:

```text
getFile(path)
getSymbol(name | id)
getDependencies(file | symbol)
getDependents(file | symbol)
getRelevantContext(intent)
getImpact(changeSet)
findTests(target)
checkArchitecture(changeSet)
listCapabilities()
getCapability(id)
```

Initial strict behavior:

```text
getFile(path)
  - Must return FileNode + graph File node + direct symbols + imports.
  - Must reject absolute paths and path traversal.

getSymbol(name | id)
  - Exact ID lookup first.
  - Name lookup must return all matches, not guess one.

getDependencies(file | symbol)
  - For file: IMPORTS / DEPENDS_ON outgoing edges.
  - For symbol: containing file dependencies first; symbol-level calls can be partial.

getDependents(file | symbol)
  - Reverse DEPENDS_ON / IMPORTS edges.
  - Must sort deterministic by normalized path.

getRelevantContext(intent)
  - Phase 1 deterministic only.
  - Accept explicit path/symbol hints.
  - No embedding/vector/LLM ranking yet.

getImpact(changeSet)
  - Accept changed normalized paths.
  - Return changed files, dependents, probable tests.
  - Mark confidence as structural, not semantic.

findTests(target)
  - Import-based matches first.
  - Basename convention matches second.
  - Return empty evidence if no tests found; do not invent tests.

checkArchitecture(changeSet)
  - Stub only with deterministic known rules if no architecture rules exist.
  - Must return not_configured, not fake pass.

listCapabilities() / getCapability(id)
  - Implement in Phase 1D after capability graph nodes exist.
```

## Tests

Add:

```text
tests/cartographer/graphSchemas.test.ts
tests/cartographer/graphIds.test.ts
tests/cartographer/tsSymbolExtractor.test.ts
tests/cartographer/importExtractor.test.ts
tests/cartographer/graphBuilder.test.ts
tests/cartographer/graphStore.inMemory.test.ts
tests/cartographer/graphStore.sqlite.test.ts
tests/cartographer/queryService.test.ts
tests/cartographer/impact.test.ts
tests/cartographer/findTests.test.ts
```

Fixture repo:

```text
tests/fixtures/repos/cartographer-structural-mini/
  package.json
  tsconfig.json
  src/index.ts
  src/app.ts
  src/app.test.ts
  src/routes/userRoute.ts
  src/config/env.ts
  docs/architecture.md
```

## Exit criteria

Phase 1C is complete only when:

```text
structural graph builds from the existing file inventory
graph output is deterministic across two runs after timestamp stripping
SQLite and in-memory graph stores return identical sorted nodes/edges
getFile, getSymbol, getDependencies, getDependents, getImpact, and findTests have fixture-backed tests
checkArchitecture returns configured findings or explicit not_configured, never fake success
no neural/SLM summaries are persisted in graph nodes
```

---

# Phase 1D — Cartographer as capability substrate

## Goal

Make Cartographer able to answer what tools and capabilities exist, without yet building the Capability-SLM runtime.

Phase 1D registers tools and capabilities as graph nodes, including examples like:

```text
Tool node: rg
Capability node: rg.search
Capability WRAPPED_BY Tool
Capability VALIDATED_BY EvalSuite
Capability PROVIDED_BY ModelAssignment, only when model assignment exists
```

## Current source state

The tool registry already has typed tool definitions with:

```text
name
description
inputSchema
risk
requiresApproval
requiresSandbox
```

It also supports registration, listing, snapshots, availability checks, and dispatch.

Phase 1D should reuse ToolRegistry metadata. Do not duplicate it.

## Required implementation

Add:

```text
src/cartographer/toolGraphAdapter.ts
src/cartographer/capabilityGraphAdapter.ts
src/cartographer/evalSuiteGraphAdapter.ts
tests/cartographer/toolGraphAdapter.test.ts
tests/cartographer/capabilityGraphAdapter.test.ts
```

The adapter should consume:

```ts
ToolRegistry.list()
```

and emit:

```text
Tool nodes
Capability nodes, where available from Phase 0 capability eval metadata
WRAPPED_BY edges
VALIDATED_BY edges to eval suite refs
PROVIDED_BY edges only if a model assignment exists
```

## Strict rule

Do not implement the full Capability Contract system in Phase 1D. Phase 2.4 / 2.5 owns the complete capability-contract and Capability-SLM runtime story.

Phase 1D should create only the minimum graph-facing representation:

```ts
type CapabilityGraphRecord = {
  id: string;
  title: string;
  source: "phase0_eval" | "tool_registry" | "manual_fixture";
  risk: "low" | "medium" | "high" | "destructive";
  toolNames: string[];
  evalSuiteRefs: string[];
};
```

## Exit criteria

Phase 1D is complete only when:

```text
Cartographer can answer listCapabilities()
Cartographer can answer getCapability(id)
tool registry metadata appears as Tool nodes
capability-to-tool edges are deterministic
capability-to-eval-suite edges are backed by existing Phase 0 eval metadata
missing capability metadata returns not_configured, not fake success
no runtime SLM calls are introduced
```

---

# Phase 1 acceptance gate

**Status: COMPLETE (gate passed 2026-06-26 on branch `rector-0.3.0-phase-1`)**

Phase 1 is complete for Phase 1 scope only when all of these pass (executed in `.worktrees/rector-0.3.0-phase-1`):

```text
npm run check
npm test -- tests/cartographer
npm run cartographer:self-scan
npm run cartographer:self-scan:check
npm run build
npm run verify:foundation
npm run test:global
npm run test:systems
```

Gate results (concise):
- `npm run check`: clean
- `npm test -- tests/cartographer`: 25 files / 191 tests passed
- `npm run cartographer:self-scan`: indexed=855, ignored=52, errors=0; artifacts written
- `npm run cartographer:self-scan:check`: PASS
- `npm run build`: clean
- `npm run verify:foundation`: PASS
- `npm run test:global`: 33 scenarios (offline, no model); passed 19/33; fake-path report-only
- `npm run test:systems`: PASS (1/1 profiles valid)

Required inspection artifacts (generated-only, local-only, not committed):

```text
.rector/cartographer/latest-snapshot.json
.rector/cartographer/latest-files.json
.rector/cartographer/scan-report.md
docs/plans/2-0/phases/phase-1-cartographer.md
```

**Scope boundary (honest):** Phase 1 complete for inventory hardening, deterministic self-scan + checker, structural graph (symbols/imports/tests; `CALLS` is schema-reserved only — no `CALLS` edges emitted), query service, and Tool/Capability graph adapters using explicit metadata. No live specialist execution, no provider routing, no Capability-SLM fabric, no Memory OS, and no fake-purge completion are claimed or implemented. SQLite experimental warning surfaces in test output. Generated artifacts are inspection-only.

The global harness continues to run provider-free.

Failure QA performed: tamper probe on a temp copy of `.rector/cartographer/*` (remove one artifact) proves the checker fails; temp copy deleted; real artifacts untouched.

---

# Recommended PR decomposition

## PR 18 — Phase 1A inventory closure

```text
Add phase-1-cartographer.md checklist.
Fill missing large-file / nested-ignore / SQLite atomicity coverage.
Keep tests provider-free.
```

## PR 19 — Phase 1B self-scan

```text
Add self-scan runner and checker.
Emit .rector/cartographer artifacts.
Add deterministic report tests.
Add package scripts.
```

## PR 20 — Phase 1C graph schemas and stores

```text
Add graph schemas/types/IDs.
Add in-memory and SQLite graph stores.
Add deterministic graph store parity tests.
```

## PR 21 — Phase 1C TypeScript graph extraction

```text
Add TS/JS symbol and import extraction.
Add File/Directory/Package/Project graph building.
Add DEFINES, IMPORTS, EXPORTS, DEPENDS_ON edges.
```

## PR 22 — Phase 1C query service

```text
Add getFile, getSymbol, getDependencies, getDependents.
Add getImpact, findTests, checkArchitecture with strict not_configured behavior.
```

## PR 23 — Phase 1D capability substrate

```text
Add Tool and Capability graph adapters.
Add listCapabilities and getCapability.
Wire ToolRegistry metadata into graph nodes.
Add tests proving no fake capability success.
```

This decomposition keeps each PR reviewable and prevents a risky Cartographer rewrite. It also lets the repository remain in a better, tested state after every PR.

---

# Source files inspected for this plan

```text
package.json
src/cartographer/index.ts
src/cartographer/types.ts
src/cartographer/schemas.ts
src/cartographer/repoScanner.ts
src/cartographer/incrementalIndex.ts
src/cartographer/sqliteInventoryStore.ts
src/tools/types.ts
src/tools/registry.ts
tests/cartographer/repoScanner.test.ts
tests/cartographer/incrementalIndex.test.ts
docs/plans/chunks/050-cartographer-inventory-slice.md
```
