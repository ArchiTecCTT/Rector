---
name: rector-phase-chunk-planner
description: "MUST USE before planning or implementing Rector work: 2.0 phases, tickets, or legacy chunks. Enforces source-of-truth reads, bounded scope, phase plans, concerns tracking, worktree discipline, and verification gates."
metadata:
  project: rector
  workflow: phase-discipline
---

# rector-phase-chunk-planner

Use for Rector phase/ticket planning and implementation discipline.

## Read first

1. `docs/architecture/configured-product-architecture.md`
2. `docs/plans/2-0/rector_capability_slm_fabric_production_plan_package/rector_capability_slm_fabric_production_plan.md`
3. Active phase plan under `docs/plans/2-0/phases/` (for current substrate work: `phase-2-typed-facts.md`)
4. `docs/plans/concerns-and-vulnerabilities.md`
5. `docs/plans/rector-master-roadmap.md` when aligning milestones
6. `docs/plans/chunks/*.md` only when a task explicitly names a chunk
7. `.kiro/specs/**` only if present in the current branch/worktree

Before touching old task-MVP modules, read `docs/plans/chunks/002-migration-map.md`.

## Phase/ticket discipline

- Keep each slice bounded and evidence-backed.
- For multi-feature phases, decompose into low-overlap tickets with one short-lived branch/worktree per ticket.
- Use a phase integration branch as the convergence point; merge in dependency order and run full gates there.
- Use stacked branches/PRs for dependent tickets.
- Record new risks or deferrals in `docs/plans/concerns-and-vulnerabilities.md`.
- Keep `AGENTS.md` compact; phase status belongs in phase docs, roadmap, and evidence artifacts.

## Verification

Before claiming complete:

```bash
npm test
npm run build
npm audit
```

Run phase gates when relevant: `verify:foundation`, `eval:capabilities:gate`, `test:global:gate`, `test:systems`, `audit:no-fakes`, `cartographer:self-scan:check`.
