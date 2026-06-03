# Chunk 013 — Executor Simulator

## Goal

Add a deterministic, in-memory fake DAG executor for the v0.1.0-alpha brainstem. It must prove compiled DAGs can advance through an execution phase without shell/provider calls.

## Scope

- Add execution schemas and exported types for DAG and node execution results.
- Add structured execution errors with stable codes.
- Execute compiled DAG nodes in dependency/topological order.
- Enforce dependency blocking, retry bounds, deterministic timeout metadata, and unsafe shell denial.
- Emit structured in-memory execution events/results only.
- Lightly wire fake chat runs so the `EXECUTING` phase includes an execution result when a compiled DAG exists, or a skipped reason otherwise.
- Add tests for success ordering, retry/failure, downstream skip, timeout, unsafe shell denial, and chat execution event payload.

## Non-goals

- No real shell, filesystem, provider, or sandbox execution.
- No real sleeps or long delays.
- No validation/healing loop implementation; that remains Chunk 14.
- No provider-backed planner/executor routing.

## Test plan

1. Write focused executor simulator unit tests first.
2. Add chat API assertion for `EXECUTING` payload.
3. Implement the minimal simulator and chat integration until tests pass.
4. Run `npm test` and `npm run build`.

## Risks / follow-up

The simulator enforces only deterministic metadata policies. Real sandboxing, filesystem permissions, provider/tool boundary enforcement, and runtime isolation remain production-hardening work for later chunks.
