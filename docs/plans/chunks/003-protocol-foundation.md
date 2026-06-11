# Chunk 3 — Protocol Foundation Plan

## Scope

Add new protocol contracts only. Do not modify legacy `src/domain/states.ts`, legacy transitions, providers, API, UI, or runtime behavior.

## Files

- `src/protocol/phases.ts` — canonical run phase list, Zod phase schema, type, and user-facing status labels.
- `src/protocol/envelope.ts` — protocol envelope Zod schema/type for versioned messages between components.
- `src/protocol/events.ts` — run event type constants plus `RunEvent` schema/type.
- `src/protocol/dag.ts` — DAG/node/retry schemas, node type constants, and deterministic DAG validation.
- `src/protocol/schemas.ts` — barrel re-exports for protocol schemas.
- `tests/protocol.test.ts` — contract tests for phases, envelopes, and DAG validation.

## TDD tests

1. Phase list exactly matches `rector-0.1.0-architecture.md`.
2. Envelope accepts a valid message and rejects bad phase/missing required fields.
3. DAG validator accepts a simple valid DAG.
4. DAG validator rejects duplicate node IDs.
5. DAG validator rejects missing dependencies.
6. DAG validator rejects cycles.
7. DAG validator rejects invalid retry policy and timeout values.

## Acceptance

- New protocol modules are additive under `src/protocol`.
- Legacy task state modules remain unchanged.
- No provider, UI, or runtime behavior changes.
- `npm test` passes.
- `npm run build` passes.
