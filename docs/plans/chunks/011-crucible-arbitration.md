# Chunk 11: Crucible Arbitration

## Goal
Add deterministic Crucible arbitration between planner output and skeptic review, then emit the decision in the fake chat run flow.

## TDD Plan
1. Add unit tests for accepted, blocked, needs-revision, escalated, and max-round behavior.
2. Add chat API coverage for a `CRUCIBLE` phase event carrying `crucibleDecision`.
3. Implement `src/orchestration/crucible.ts` with zod schemas and pure deterministic arbitration.
4. Wire fake chat run to compute Crucible decision after skeptic review and include it only in the `CRUCIBLE` event payload.
5. Export Crucible module from orchestration barrel.
6. Update concerns register with deterministic placeholder limitation.
7. Run `npm test` and `npm run build`.
