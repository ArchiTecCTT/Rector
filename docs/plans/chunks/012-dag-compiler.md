# Chunk 12 — DAG Compiler

## Goal

Add a deterministic DAG compiler that turns an ACCEPTED Crucible plan into a validated JSON DAG for the alpha brainstem.

## Scope

- Add `src/orchestration/dagCompiler.ts`.
- Reuse existing planner, Crucible, and protocol DAG schemas where possible.
- Compile task nodes, dependency edges, validation nodes, budget metadata, safe tool policy metadata, retry policy, timeout metadata, and planner-task-to-DAG-node mapping.
- Reject non-ACCEPTED Crucible decisions.
- Export validation helpers for duplicate IDs, dangling dependencies, cycle detection, validation coverage, and unsafe shell default-deny checks.
- Lightly integrate fake chat run so `DAG_COMPILATION` events carry `compiledDag` when accepted or a skipped reason otherwise.

## TDD Plan

1. Add DAG compiler unit tests for accepted CODE_EDIT and PLAN_ONLY plans.
2. Add tests for validation node linking, non-ACCEPTED rejection, duplicate IDs, dangling dependencies, cycle validation, and unsafe shell denial.
3. Add chat API test asserting `DAG_COMPILATION` event includes `compiledDag` for accepted fake flow.
4. Implement compiler and integration.
5. Run `npm test` and `npm run build`.

## Constraints

- Pure deterministic compile only.
- No filesystem scans.
- No provider calls.
- Keep local/provider-free mode as default.
