# Chunk 10: Skeptic Review

## Goal
Add deterministic skeptic review schema and fake review function, then emit the review in the fake chat run flow.

## TDD Plan
1. Add tests for skeptic review verdicts and finding heuristics.
2. Add chat test coverage for `SKEPTIC_REVIEW` phase event with `skepticReview` payload.
3. Implement `src/orchestration/skeptic.ts` minimally against tests.
4. Wire fake chat run to call skeptic review after planning.
5. Update concerns register.
6. Run `npm test` and `npm run build`.
