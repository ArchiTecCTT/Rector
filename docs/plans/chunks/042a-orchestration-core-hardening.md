# Chunk 042a — Orchestration Core Hardening

> Created: 2026-06-12
> Phase: 1 of 6
> Components: Triage, Context Builder, Planner, Skeptic, Crucible, DAG Compiler

## Goal

Harden the front half of the Rector orchestration pipeline so requests are routed,
contextualized, planned, reviewed, arbitrated, and compiled into DAGs with strong
schema guarantees, better evidence, and production-grade fallback behavior.

## Scope

### In Scope

- `src/orchestration/triage.ts`
- `src/orchestration/contextBuilder.ts`
- `src/orchestration/planner.ts`
- `src/orchestration/skeptic.ts`
- `src/orchestration/crucible.ts`
- `src/orchestration/dagCompiler.ts`
- related prompt builders in `src/orchestration/prompts.ts`
- related tests under `tests/`
- concerns register updates

### Out of Scope

- Real execution/sandbox hardening — Chunk 042b/042e
- Memory adapter hardening — Chunk 042d
- Ponder/deep planning/task decomposition — Chunk 042c

## Design Principles

1. **Local mode remains deterministic.** No provider calls or network in local mode.
2. **External mode may be live, but never brittle.** Every LLM-backed step has schema validation, bounded repair, redaction, and deterministic fallback.
3. **Evidence first.** Each decision needs machine-readable reasons/evidence.
4. **Governance in graph.** Approval, budget, risk, and validation gates are first-class outputs, not side-channel comments.
5. **No silent downgrade.** If live planner/reviewer fails, fallback must emit traceable fallback reason.

## Work Items

### 1. Triage Hardening

- Add `TriageSignals` helper with explicit scores for route candidates.
- Preserve regex local classifier.
- Add optional external-mode `runLiveTriage` behind provider + budget gate.
- Add confidence calibration rules:
  - low confidence + high-risk action => `NEEDS_CLARIFICATION`
  - destructive terms => risk flag + approval required downstream
  - conflicting intents (`plan only` + `edit`) => clarification
- Add tests:
  - deterministic local route invariants
  - ambiguous prompt property tests
  - destructive prompt always carries risk flag
  - no provider call in local mode

### 2. Context Builder Hardening

- Add bounded context budget object:
  - max inline chars
  - max memory entries
  - max artifact handles
  - max provider/tool notes
- Add scoring/ranking for memory/docs:
  - direct term match
  - recency boost
  - trusted provenance boost
  - rejected/stale penalty
- Ensure `memoryContext` is consistently injected into planner/skeptic/synth prompts.
- Add artifact provenance/citation fields where available.
- Add tests:
  - context never exceeds configured caps
  - large artifacts become handles, not inline blobs
  - memory ranking is deterministic with injected clock
  - redaction before inline context

### 3. Planner Hardening

- Strengthen `PlannerOutputSchema` refinements:
  - task IDs unique
  - dependencies reference existing task IDs
  - approval gates reference existing task IDs
  - destructive/high risk tasks require approval
  - every task has validation
- Harden `runLivePlanner`:
  - strict JSON object prompt
  - schema parse
  - bounded repair prompt on parse failure
  - deterministic fallback with `fallbackReason`
- Add plan normalization:
  - stable task IDs
  - deduplicated assumptions/checks
  - sorted dependencies
- Add tests:
  - invalid dependencies rejected
  - destructive task forces approval gate
  - live planner malformed output repairs or falls back
  - local fake planner unchanged

### 4. Skeptic Hardening

- Split deterministic findings into named rule functions.
- Add finding deduplication.
- Add severity policy:
  - `BLOCKER` blocks compilation
  - `MAJOR` requires crucible revision/escalation depending risk
  - `MINOR` can pass with warning
- Add optional live semantic reviewer for external mode:
  - must produce schema-valid findings
  - cannot erase deterministic blockers
  - output redacted
- Add tests:
  - deterministic blocker cannot be suppressed by live reviewer
  - duplicate findings collapsed
  - unsafe low-risk plan flagged

### 5. Crucible Hardening

- Make arbitration policy explicit:
  - accepted only if no blockers
  - revision only if repairable findings and round < max
  - escalation when approval/human decision needed
  - blocked when max rounds or unrecoverable policy violation
- Attach targeted findings to revision requests.
- Add typed `CrucibleDecisionTrace` with reason codes.
- Add tests:
  - blocker => blocked/escalated, never accepted
  - major finding => revision on round 1
  - max rounds => escalated/blocked
  - accepted decision always includes accepted plan

### 6. DAG Compiler Hardening

- Add stronger DAG policies:
  - node IDs unique
  - topological order guaranteed
  - all dependencies have edges
  - validation nodes exist for every task node
  - unsafe permissions denied by default
- Add executable policy metadata:
  - command/file permissions per node
  - validation contract per validation node
  - rollback/cleanup hint per risky node
  - timeout policy per node
- Add tests:
  - cyclic plan dependencies fail before compilation
  - missing validation fails
  - denied permissions stripped/blocked
  - generated DAG validates under protocol schema

## Tests

Run after implementation:

```bash
npm test
npm run build
npm audit
```

Target new/updated test files:

- `tests/triageHardening.test.ts`
- `tests/contextBuilderHardening.test.ts`
- `tests/plannerHardening.test.ts`
- `tests/skepticHardening.test.ts`
- `tests/crucibleHardening.test.ts`
- `tests/dagCompilerHardening.test.ts`
- property tests where invariants benefit from fast-check

## Acceptance Criteria

- Local chat brainstem output unchanged except additive trace fields.
- External-mode live planner/reviewer failures do not crash runs.
- DAG compiler rejects invalid or unsafe accepted plans.
- All new findings/decisions are redacted and traceable.
- `npm test`, `npm run build`, and `npm audit` pass.

## Commit

Suggested commit:

```text
feat(chunk-042a): harden orchestration core
```
