---
name: rector-phase-chunk-planner
description: "MUST USE before planning or implementing Rector work: Rector 2.0 phases, tickets, or legacy chunks. Enforces source-of-truth reading, bounded scope, phase plans under docs/plans/2-0/phases/, concerns tracking, and verification gates. Triggers: 'phase', 'chunk', 'plan', 'roadmap', 'start work', 'implement next', 'typed facts'."
compatibility: opencode
metadata:
  project: rector
  workflow: phase-discipline
---

# rector-phase-chunk-planner

Keeps Rector work bounded, evidence-backed, and aligned with the **Rector 2.0** production map — not ad-hoc refactors.

## Load when

- Starting or continuing a **phase slice** (primary) or **ticket**
- Translating production-plan items into implementation
- Updating `docs/plans/2-0/phases/*.md` or legacy `docs/plans/chunks/*.md`
- A task spans docs, UI, orchestration, providers, and tests at once

## Required source reads

Read before writing or executing a plan:

1. `docs/architecture/configured-product-architecture.md`
2. `docs/plans/2-0/rector_capability_slm_fabric_production_plan_package/rector_capability_slm_fabric_production_plan.md` — phase map and boundaries
3. **Active phase plan:** `docs/plans/2-0/phases/<phase>.md` (e.g. `phase-2-typed-facts.md` for current substrate work)
4. `docs/plans/concerns-and-vulnerabilities.md`
5. `docs/plans/rector-master-roadmap.md` — when aligning milestones
6. `docs/plans/chunks/*.md` — **only** when the task explicitly references a chunk id
7. `.kiro/specs/cloud-capable-transition/*` — **only if present** in the current branch/worktree

Before touching old task-MVP modules: `docs/plans/chunks/002-migration-map.md`.

## Plan shape (phase-first)

Phase plans under `docs/plans/2-0/phases/` are authoritative for Rector 2.0. When adding a **legacy chunk** plan under `docs/plans/chunks/`, include:

- chunk number/title and **which phase** it supports (if any)
- source-of-truth docs consulted
- scope and non-goals
- affected modules
- steps, tests, QA
- risks → concerns register
- completion evidence (commands + pass/fail)

## Worktree / ticket discipline

- One coherent slice per commit series (phase sub-slice A–G, ticket, or legacy chunk).
- For multi-feature phases, decompose into a dependency graph and assign one short-lived branch/worktree per low-overlap ticket.
- Use a phase integration branch as the convergence point; merge feature PRs in dependency order, then run full gates and fix integration fallout before merging onward.
- Use stacked branches/PRs for dependent tickets instead of parallel edits to the same files.
- Record worktree or branch in the plan when not on `main`.
- Do not broaden into unrelated legacy cleanup.
- Discoveries → fix in-scope or log in `docs/plans/concerns-and-vulnerabilities.md`.

## Verification contract

Before claiming a slice complete:

```bash
npm test
npm run build
npm audit
```

Run **phase-documented gates** when they prove the slice, for example:

```bash
npm run verify:foundation
npm run eval:capabilities:gate
npm run test:global:gate
npm run test:systems
npm run audit:no-fakes
npm run cartographer:self-scan:check
```

Targeted gates do not imply unrelated phases are complete.

## Complementary skills

Load when the slice touches:

- `rector-configured-product-guardian` — product/chat/runtime settings
- `rector-cartographer-graph-builder` — Cartographer phases
- `rector-evidence-gatekeeper` — evals, validators, typed facts
- `rector-fake-purge-auditor` — spy/fake boundaries
- `rector-docs-replacement-surgeon` — user-facing doc edits in the same slice