---
name: rector-cartographer-graph-builder
description: "MUST USE for Rector Cartographer work, repository inventory, structural code graph expansion, symbol/import/call/test/route extraction, SQLite graph persistence, and Capability-SLM query surfaces. Enforces Phase 1 graph facts before SLM fabric work. Triggers: 'Cartographer', 'code graph', 'file inventory', 'symbols', 'imports', 'calls', 'capability graph'."
compatibility: opencode
metadata:
  project: rector
  subsystem: cartographer
---

# rector-cartographer-graph-builder

Use this skill for Phase 1 Cartographer work: turning repository file inventory into typed structural graph facts.

## Current baseline

Cartographer already covers:

- schemas;
- ignore policy using `.gitignore`, `.rectorignore`, and built-in ignores;
- file classifier;
- file hasher;
- in-memory inventory store;
- SQLite inventory store;
- full repo scan;
- incremental changed-file scan;
- scan summary builder.

It is currently file-inventory level. It does not yet fully persist symbols, imports, calls, tests, routes, skills, rules, capability nodes, or impact edges.

## Phase 1 direction

Build typed repository facts before building Capability-SLM behavior.

Preferred order:

1. Extend Zod schemas for structural facts.
2. Add extraction/parsing with explicit unsupported/unknown states.
3. Persist facts in SQLite and in-memory stores.
4. Preserve full and incremental scan behavior.
5. Expose query APIs for later Capability-SLM evidence retrieval.
6. Add tests for schema, extraction, persistence, ignores, and incremental updates.

## Fact families to model deliberately

- `SymbolNode`: exported/internal symbols with file, range, kind, and language.
- `ImportEdge`: source file to imported module/path/symbol.
- `CallEdge`: caller to callee when statically knowable.
- `TestEdge`: test file/case to implementation target when inferable.
- `RouteNode`: HTTP/API/UI routes when inferable.
- `SkillNode`: project skills and their trigger domains.
- `RuleNode`: architecture/policy rules extracted from source-of-truth docs.
- `ImpactEdge`: dependency/blast-radius relations.

## Anti-fake-confidence rules

- Unknown is a valid extraction result; do not invent graph facts.
- Parser failure must be represented as a scan/extraction error, not silently ignored.
- Dynamic or ambiguous calls must be marked ambiguous or unresolved.
- Capability queries must return grounded paths/ranges where available.

## Verification targets

Use targeted tests around:

- ignored files staying ignored;
- changed files updating only affected facts;
- deleted files removing stale graph facts;
- SQLite and in-memory stores producing equivalent query results;
- unsupported languages producing explicit unsupported facts or errors.
