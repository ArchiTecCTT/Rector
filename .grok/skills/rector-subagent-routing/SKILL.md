---
name: rector-subagent-routing
description: "MUST USE when spawning subagents in the Rector repo. Routes implementation to rector-generalCoder-fast or rector-generalCoder-deep instead of general-purpose; runs rector-librarian after verified implementation. Enforces max 2 concurrent deep coders (Cloudflare GLM rate limits). Triggers: spawn subagent, implement, fix, chunk work, delegate coding."
metadata:
  project: rector
  workflow: subagent-routing
---

# rector-subagent-routing

When working in the Rector repository, the parent orchestrator **must not** spawn `general-purpose` for implementation work. Use the project coder agents instead.

## Coder routing

| Task difficulty | `subagent_type` | Default model |
|---|---|---|
| Low–mid: single/few files, clear scope, straightforward fix or test | `rector-generalCoder-fast` | `grok-composer-2.5-fast` |
| Hard: cross-cutting, orchestration, multi-module, subtle bugs, high blast radius | `rector-generalCoder-deep` | `cf-glm-5-2` |

### Fast coder signals

- Chunk plan exists and scope is bounded
- One subsystem or ≤3 files likely touched
- Bug with localized root cause
- Test additions for existing behavior

### Deep coder signals

- Touches `runOrchestratedChatRun`, onboarding, runtime settings, or product gating
- Orchestration + UI + providers in one task
- Refactor with unclear caller impact
- Review-fix round after architectural findings

When unsure, start **fast**; escalate to **deep** on the next spawn if the fast coder reports blockers.

## Deep coder concurrency limit (mandatory)

`rector-generalCoder-deep` uses Cloudflare Workers AI (`cf-glm-5-2`), which is rate-limited.

**Never have more than 2 `rector-generalCoder-deep` subagents active at the same time.**

Before spawning a third deep coder:

1. Wait for an in-flight deep coder to complete (`get_command_or_subagent_output`), or
2. Queue the work sequentially, or
3. Downgrade to `rector-generalCoder-fast` if scope allows

Track active deep spawns in the orchestrator todo list. Fast coders have no such cap.

## Non-implementation agents (unchanged)

| Job | `subagent_type` |
|---|---|
| Codebase search / map only | `explore` |
| Implementation plan before coding | `plan` |
| Post-implementation doc sync | `rector-librarian` |

Do **not** use `general-purpose` for Rector implementation unless the user explicitly overrides.

## Standard chunk workflow

```
1. plan (optional)           → subagent_type: plan
2. implement               → rector-generalCoder-fast OR rector-generalCoder-deep
3. verify                  → parent runs npm test + npm run build (or coder reports)
4. librarian (mandatory)   → rector-librarian with diff summary + chunk id
5. commit                  → parent, with correct git identity per AGENTS.md
```

Spawn `rector-librarian` **after** implementation is verified and **before** claiming the chunk complete or committing — unless the task was docs-only (then librarian may be the primary agent).

## Spawn examples

```
# Fast implementation
spawn_subagent({
  subagent_type: "rector-generalCoder-fast",
  description: "[coder-fast] Fix cartographer dedupe in test linker",
  prompt: "..."
})

# Hard implementation (check: <2 deep coders already running)
spawn_subagent({
  subagent_type: "rector-generalCoder-deep",
  description: "[coder-deep] Consolidate chat dispatch to runOrchestratedChatRun",
  prompt: "..."
})

# Post-task doc sync
spawn_subagent({
  subagent_type: "rector-librarian",
  description: "[librarian] Sync chunk 051 docs after cartographer cleanup",
  prompt: "Implementation summary: ...\nFiles changed: ...\nUpdate chunk plan, concerns, AGENTS.md if needed."
})
```

## Agent definitions

Project agents live in `.grok/agents/`:

- `rector-generalCoder-fast.md`
- `rector-generalCoder-deep.md`
- `rector-librarian.md`

Model defaults are in `~/.grok/config.toml` under `[subagents.models]`.