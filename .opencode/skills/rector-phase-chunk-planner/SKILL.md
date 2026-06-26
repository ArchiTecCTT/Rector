---
name: rector-phase-chunk-planner
description: "MUST USE before planning or implementing a Rector chunk, especially Phase 1 docs and v0.3.0 configured-product work. Enforces source-of-truth reading, one-chunk scope, docs/plans/chunks plan files, concerns tracking, verification gates, and no broad refactor drift. Triggers: 'chunk', 'phase', 'plan', 'roadmap', 'start work', 'implement next'."
compatibility: opencode
metadata:
  project: rector
  workflow: chunk-discipline
---

# rector-phase-chunk-planner

Use this skill to keep Rector implementation work bounded, evidence-backed, and aligned with the roadmap.

## Load when

- Starting a new Rector phase/chunk.
- Translating roadmap/spec items into implementation work.
- Updating `docs/plans/chunks/*.md`.
- A task risks spanning docs, UI, orchestration, providers, tests, and migration at once.

## Required source reads

Read these before writing a chunk plan:

1. `docs/architecture/configured-product-architecture.md`
2. `.kiro/specs/cloud-capable-transition/requirements.md`
3. `.kiro/specs/cloud-capable-transition/design.md`
4. `.kiro/specs/cloud-capable-transition/tasks.md`
5. `docs/plans/rector-master-roadmap.md`
6. Latest relevant `docs/plans/chunks/*.md`
7. `docs/plans/concerns-and-vulnerabilities.md`

Read `docs/plans/chunks/002-migration-map.md` before touching old task-MVP modules.

## Chunk plan shape

Each new chunk plan under `docs/plans/chunks/` should state:

- chunk number and title;
- source-of-truth docs consulted;
- scope and non-goals;
- affected files/modules;
- implementation steps;
- tests and manual QA surface;
- risks, deferred work, and concerns-doc updates;
- completion evidence expected before commit.

## Scope discipline

- Work one chunk at a time.
- Prefer one coherent vertical slice over scattered cleanup.
- Do not refactor unrelated legacy modules while implementing a chunk.
- If a risk or stale architecture issue is discovered, either fix it in-scope or record it in `docs/plans/concerns-and-vulnerabilities.md`.

## Verification contract

Before claiming a chunk complete:

```bash
npm test
npm run build
```

Also run any targeted test/eval/audit directly tied to the chunk, such as:

```bash
npm run audit:no-fakes
npm run eval:capabilities
npm run test:global
npm run test:systems
```

Use targeted gates when they prove the chunk's surface; do not claim full project completion from targeted gates alone.
