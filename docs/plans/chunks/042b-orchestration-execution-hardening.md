# Chunk 042b — Orchestration Execution Hardening

> Created: 2026-06-12
> Phase: 2 of 6
> Components: Executor Simulator, Sandbox Executor, Validation/Healing, Synthesizer

## Goal

Harden the execution half of the orchestration pipeline: simulated execution,
real sandbox bridging, validation/healing, and final user-facing synthesis.

## Scope

### In Scope

- `src/orchestration/executorSimulator.ts`
- `src/orchestration/sandboxExecutor.ts`
- `src/orchestration/validationHealing.ts`
- `src/orchestration/synthesizer.ts`
- relevant sandbox interfaces only where needed
- execution/validation/synthesis tests

### Out of Scope

- Full sandbox security redesign — Chunk 042e
- Planner/reviewer/core DAG policy — Chunk 042a
- Memory provider hardening — Chunk 042d

## Design Principles

1. **Simulator and sandbox traces must align.** Local fake execution and real sandbox execution should produce comparable event/result shapes.
2. **Validation must be concrete.** Validation nodes must inspect artifacts/results, not just assume success.
3. **Healing is bounded.** No infinite retry or blind patch loop.
4. **Synthesis should be useful.** User gets a clear summary, evidence, changed artifacts, validation, and remaining risks.

## Work Items

### 1. Fix Current Failing Property Test

Current failing test:

- `tests/e2bStreamCaptureTruncation.property21.test.ts`
- Timeout: 5s property test too slow after rolldown fix.

Planned fix:

- Profile the test case count and async delay source.
- Reduce generated payload sizes or `numRuns` if excessive.
- Or add explicit test timeout if the property is intentionally heavier.
- Preserve Property 21 invariant: stdout/stderr captured, truncated to cap, truncation flag iff original exceeded cap.

### 2. Executor Simulator Hardening

- Add explicit `ExecutionPolicy`:
  - max attempts
  - retryable error codes
  - per-node timeout
  - dependency failure strategy
- Add validation-node semantics:
  - validation nodes inspect upstream task output
  - validation failure classifies as `VALIDATION`
- Improve event model:
  - every node started/completed/skipped exactly once
  - retry events preserve attempt count
  - DAG completed event always last
- Add tests:
  - retryable vs non-retryable errors
  - dependency failure propagation
  - validation node failure causes DAG failure/partial
  - event sequence invariants

### 3. Sandbox Executor Hardening

- Strengthen node-to-operation mapping:
  - explicit support for file read/write/patch/command/validation
  - reject ambiguous operations
  - require approval metadata for writes/destructive ops
- Add operation result normalization:
  - stdout/stderr truncation
  - redacted artifact previews
  - timeout/cancel classification
  - operation ID correlation with DAG node ID
- Add tests:
  - unsafe node maps to denied operation
  - artifacts are redacted and length-bounded
  - command stderr/stdout truncation invariant
  - partial sandbox failure produces valid DAG result

### 4. Validation/Healing Hardening

- Add failure classifier table:
  - timeout => retry if policy allows
  - permission => needs decision
  - dependency => mark downstream skipped
  - validation => propose targeted repair or fail
  - unknown => bounded retry then fail/escalate
- Add targeted patch repair path:
  - only for safe file operations
  - patch artifact must require approval unless pre-approved policy says otherwise
  - revalidate only affected subgraph where possible
- Add tests:
  - timeout retry then success
  - permission failure => `NEEDS_DECISION`
  - validation failure => targeted repair attempt
  - max attempts => `FAILED`
  - no secret leak in failure messages

### 5. Synthesizer Hardening

- Keep deterministic local synthesis.
- Improve live external synthesis:
  - produce natural answer with sections: summary, actions, validation, risks, next steps
  - cite evidence from trace/artifacts
  - never expose secrets/raw provider errors
  - fallback to deterministic response with explicit reason
- Add tests:
  - local output deterministic
  - live malformed response falls back
  - evidence/citations are preserved
  - residual risks included when failures/partial

## Tests

Run:

```bash
npm test
npm run build
npm audit
```

Target tests:

- `tests/e2bStreamCaptureTruncation.property21.test.ts`
- `tests/executorSimulatorHardening.test.ts`
- `tests/sandboxExecutorHardening.test.ts`
- `tests/validationHealingHardening.test.ts`
- `tests/synthesizerHardening.test.ts`

## Acceptance Criteria

- Current single failing test is fixed without weakening the invariant.
- Simulator and sandbox result shapes remain schema-valid and comparable.
- Healing never loops unbounded.
- External synthesis improves user-facing answer quality while preserving deterministic local fallback.
- `npm test`, `npm run build`, and `npm audit` pass.

## Commit

Suggested commit:

```text
feat(chunk-042b): harden orchestration execution
```
