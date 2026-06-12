# Chunk 042c — Neuro-Symbolic Hardening

> Created: 2026-06-12
> Phase: 3 of 6
> Components: Deep Planner, Ponder Swarm, Task Decomposer

## Goal

Turn the alpha neuro-symbolic features into useful, bounded, observable systems
that improve real runs without destabilizing local/provider-free behavior.

## Scope

### In Scope

- `src/orchestration/deepPlanner.ts`
- `src/orchestration/ponderSwarm.ts`
- `src/orchestration/taskDecomposer.ts`
- `src/orchestration/backgroundHooks.ts`
- module toggles in `src/modules/builtin/neuro-*`
- tests for neuro feature safety and usefulness

### Out of Scope

- Core planner/reviewer schema hardening — Chunk 042a
- Memory provider durability — Chunk 042d
- Production background worker infra — later chunk unless needed for tests

## Design Principles

1. **Opt-in or mode-gated.** Neuro features must not alter local deterministic baseline unless explicitly enabled in test/local config.
2. **Budget-bounded.** Reflection/deep planning cannot run without cost/runtime limits.
3. **Observable.** Every neuro action must emit traceable decisions/results.
4. **Useful before clever.** Prefer simple candidate scoring and concrete memory lessons over complex untestable algorithms.

## Work Items

### 1. Deep Planner Hardening

Current state:

- Not real MCTS.
- Runs base live planner plus fake alternatives.
- Symbolically prunes unsafe write paths.

Planned work:

- Replace vague MCTS language with a bounded `MultiCandidatePlanner` abstraction.
- Candidate generation sources:
  - base live plan
  - risk-minimized variant
  - test-first variant
  - user-speed variant when safe
- Add scoring function:
  - validation coverage
  - dependency simplicity
  - approval burden
  - risk level
  - symbolic rule violations
  - estimated cost/runtime
- Add explicit `pathsExplored` trace with scores and rejection reasons.
- Add tests:
  - unsafe candidate pruned
  - best score selected deterministically
  - provider failure returns base/fallback plan
  - deep planning off => current behavior preserved

### 2. Ponder Swarm Hardening

Current state:

- Reflects on up to 5 episodic entries.
- Uses live synthesizer to produce lesson.
- Background hooks use fixed timer/fire-and-forget.

Planned work:

- Add `PonderTriggerPolicy`:
  - on run completed with enough new episodic memory
  - on contradiction signal
  - on idle interval
  - max runs per time window
- Add deduplication:
  - no duplicate lesson content/hash
  - ignore low-information memories
- Add contradiction detection with confidence:
  - deterministic contradictions first
  - optional LLM classification external only
- Add write policy:
  - lessons write to core memory only if confidence threshold met
  - all lessons redacted
  - include provenance of source memory IDs
- Add tests:
  - no memory => no provider call
  - duplicate lessons suppressed
  - budget denial => no background provider call
  - contradiction output redacted

### 3. Task Decomposer Hardening

Current state:

- Splits text on punctuation.
- Max 4 sub-goals.
- Executes no-op LLM nodes through sandbox bridge.

Planned work:

- Add deterministic semantic-ish decomposition:
  - parse bullets/numbered lists first
  - detect independent vs dependent sub-goals
  - preserve user intent/order
  - cap sub-goals by risk/config
- Add optional live decomposition external mode:
  - schema-validated sub-goal graph
  - bounded repair/fallback
- Add `SubGoalGraph`:
  - sub-goals
  - dependencies
  - expected artifacts
  - validation per sub-goal
- Add bounded concurrency:
  - only independent sub-goals parallelize
  - dependent sub-goals execute after prerequisites
  - partial failures stitched with status
- Add tests:
  - bullets decompose correctly
  - dependent goals not parallelized
  - max concurrency honored
  - failed sub-goal does not hide successful sub-goals

## Tests

Run:

```bash
npm test
npm run build
npm audit
```

Target tests:

- `tests/deepPlannerHardening.test.ts`
- `tests/ponderSwarmHardening.test.ts`
- `tests/taskDecomposerHardening.test.ts`
- `tests/neuroLocalModeInvariant.property.test.ts`

## Acceptance Criteria

- Deep planning is honestly named and traceably scored.
- Ponder runs are bounded, deduplicated, budget-gated, and observable.
- Task decomposition produces dependency-aware sub-goals and safe stitched results.
- Local/provider-free deterministic behavior remains unchanged by default.
- `npm test`, `npm run build`, and `npm audit` pass.

## Commit

Suggested commit:

```text
feat(chunk-042c): harden neuro-symbolic orchestration
```
