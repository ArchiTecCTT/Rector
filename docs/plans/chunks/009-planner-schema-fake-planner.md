# Chunk 9: Planner Schema and Fake Planner

## Scope

- Add deterministic planner module after triage/context building.
- Define validated planner input/output schemas.
- Enforce validation coverage and approval gates for unsafe/destructive plans.
- Emit planner output in fake chat run `PLANNING` event while keeping placeholder assistant response.

## TDD Plan

1. Add planner tests for valid output, missing validation rejection, unsafe action approval gate enforcement, route-specific deterministic outputs, and chat planning event payload.
2. Implement `src/orchestration/planner.ts` with zod schemas, types, `createFakePlan`, and `validatePlannerOutput`.
3. Export planner module from orchestration barrel.
4. Integrate fake planner into chat run transition payload for `PLANNING`.
5. Update concerns register if placeholder limitations should remain visible.
6. Run `npm test` and `npm run build`.
