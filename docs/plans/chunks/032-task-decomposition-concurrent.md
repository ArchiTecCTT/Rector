# Chunk 32 — Task Decomposition + Concurrent Execution + Stitching (Neuro-Symbolic Step 7)

## Goal
After preprocessor, decompose high-level request into sub-tasks (reuse DAG compiler), execute concurrently through safe WorkspaceSandboxAdapter, final synthesis stitches with citations.

## Scope
- New decompose step.
- Concurrent execution via sandbox (already supports).
- Stitching in synthesizer or new step.
- Tests, commit as 32.

All through existing safe executor.