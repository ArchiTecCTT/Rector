# Chunk 29 — Pluggable Deterministic / Expert Systems Layer (Neuro-Symbolic Step 4)

## Goal
Add a hybrid symbolic layer (lean pure-TS rule engine + decision tables) that can be used by preprocessor (tool validation), healing, subconscious checks, and as callable tools. Registry pattern for pluggability. Optional heavy solver (z3) deferred.

## Scope
- New `src/symbolic/` module with `SymbolicEngine` interface and `symbolicRegistry`.
- Simple forward-chaining IF-THEN rule engine + priority decision tables in pure TypeScript.
- Basic rules for tool arg validation, contradiction detection, repair suggestions.
- Integration hooks in preprocessor (from Step 1) and healing (existing).
- Tests and concerns update.
- Commit as 29.

## Implementation
- Define Rule, Fact, EvaluationResult.
- Tiny engine: match conditions, execute actions with priorities.
- Registry for "default" engine.
- Use in preprocessor for proposedToolCalls validation (beyond allowlist).
- Keep all local mode safe.

## Acceptance
- Plan, impl, tests, no breakage to existing 272+ tests, commit.