---
name: rector-subagent-routing
description: "MUST USE when spawning subagents in the Rector repo. Routes implementation to rector-generalCoder-fast or rector-generalCoder-deep instead of general-purpose; runs rector-librarian after verified implementation. Triggers: spawn subagent, implement, fix, phase work, delegate coding."
metadata:
  project: rector
  workflow: subagent-routing
---

# rector-subagent-routing

The parent orchestrator **must not** spawn `general-purpose` for Rector implementation. Use project coders in `.grok/agents/`.

## Coder routing

| Task difficulty | `subagent_type` | Default model |
|---|---|---|
| Low–mid: single/few files, clear scope, straightforward fix or test | `rector-generalCoder-fast` | `grok-composer-2.5-fast` |
| Hard: cross-cutting, orchestration, multi-module, subtle bugs, high blast radius | `rector-generalCoder-deep` | `azure-gpt-5-5` |

### Fast coder signals

- Phase or ticket plan exists with bounded scope
- One subsystem or ≤3 files likely touched
- Localized bug or test additions

### Deep coder signals

- `runOrchestratedChatRun`, onboarding, runtime settings, product gating
- Orchestration + UI + providers in one task
- Phase 2+ substrate (typed facts, graph adapters, eval integration) with wide blast radius
- Review-fix after architectural findings

When unsure, start **fast**; escalate to **deep** if blockers are cross-cutting.

## Non-implementation agents

| Job | `subagent_type` |
|---|---|
| Codebase search / map only | `explore` |
| Plan before coding | `plan` |
| Post-implementation doc sync | `rector-librarian` |

## Standard workflow (phase / ticket / chunk)

Primary planning lives under **`docs/plans/2-0/phases/`** and the production plan package. Legacy **`docs/plans/chunks/`** applies only when the task names a chunk.

```
1. plan/decompose      → active phase plan + ticket dependency graph
2. assign worktree     → one short-lived branch/worktree per low-overlap ticket
3. implement           → rector-generalCoder-fast OR rector-generalCoder-deep
4. verify              → parent: npm test + npm run build + phase gates from plan
5. librarian           → rector-librarian (phase doc, concerns, minimal AGENTS.md)
6. integrate           → merge to phase integration branch, run full gates, fix fallout
7. commit/merge onward → parent, git identity per AGENTS.md
```

Use stacked branches/PRs for dependent tickets. Spawn **librarian after verify** and before claiming complete/commit — unless docs-only (librarian may be primary).

## Spawn prompt hygiene

Include in coder/librarian prompts:

- Active phase file (e.g. `docs/plans/2-0/phases/phase-2-typed-facts.md`) or explicit chunk id
- Worktree path if not repo root
- Non-goals from the plan

Do not require `.kiro/specs/` unless that directory exists in the worktree.

## Agent definitions

- `.grok/agents/rector-generalCoder-fast.md`
- `.grok/agents/rector-generalCoder-deep.md`
- `.grok/agents/rector-librarian.md`

Models: `~/.grok/config.toml` → `[subagents.models]`.