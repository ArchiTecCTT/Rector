# Chunk 8 — Triage and Context Builder

## Scope

Implement local deterministic triage and a bounded context-pack builder for the chat shell. No provider calls, no full planner, no durable persistence changes.

## TDD Plan

1. Add unit tests for heuristic routing:
   - direct answer
   - plan only
   - code edit
   - research
   - long running
   - needs clarification
2. Add unit tests for artifact handle behavior:
   - small content can be inline
   - oversized content is stored as an artifact record and represented only by handle/summary/hash/size in the context pack.
3. Add chat API regression test proving run route/complexity are set from triage and triage/context events are emitted.
4. Implement schemas and helpers.
5. Wire chat endpoint lightly into existing fake run path.
6. Run test/build and update concerns register.

## Constraints

- Deterministic only.
- No real provider calls.
- Keep fake assistant response.
- Artifact handles must not include raw oversized content.
- Avoid full planner/orchestration changes.
