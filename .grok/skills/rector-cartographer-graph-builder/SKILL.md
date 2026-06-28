---
name: rector-cartographer-graph-builder
description: "MUST USE for Rector Cartographer work, repository inventory, structural graph facts, symbol/import/test/capability graph extraction, persistence, self-scan, and Cartographer query surfaces."
metadata:
  project: rector
  subsystem: cartographer
---

# rector-cartographer-graph-builder

Use for Cartographer inventory, self-scan, structural graph, tool/capability graph nodes, and query-service work.

## Source docs

- `docs/plans/2-0/phases/phase-1-cartographer.md`
- `docs/plans/2-0/rector_capability_slm_fabric_production_plan_package/rector_capability_slm_fabric_production_plan.md`
- `docs/plans/concerns-and-vulnerabilities.md`

## Current rule

Phase 1 Cartographer is the deterministic graph substrate for later typed facts, Memory OS, Capability-SLM, rules, and planner/skeptic work. Do not add neural summaries or provider calls to Cartographer.

## Anti-fake-confidence rules

- Unknown/unsupported is a valid extraction result.
- Parser failures must be explicit scan/extraction errors.
- Ambiguous/dynamic relations must not be invented.
- Query output must be grounded in paths/ranges/artifacts when available.

## Verification

Use relevant tests and gates: `npm test -- tests/cartographer`, `npm run cartographer:self-scan`, `npm run cartographer:self-scan:check`, `npm run verify:foundation` when the phase plan requires it.
