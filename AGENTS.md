# Rector Agent Guide

## Project Vision

Rector is Apache-2.0 open-source software: a chat-first self-healing AI engineering orchestration system.

Users interact like Claude/ChatGPT in a **hassle-free** way. The app is configurable through the web UI — providers, memory, sandbox, telemetry, and budgets — without editing files or env for normal use. Beneath chat, Rector runs deterministic orchestration: triage, context, planning, skeptic review, crucible arbitration, DAG execution, validation, healing, and synthesis.

The product is **configured orchestration**, not a provider-free demo. Fresh installs are **unconfigured** until first-run onboarding and readiness pass. There is no fake chat as the product.

## Source of Truth

Read before planning or implementing (deeper paths win on conflict):

| Priority | Document |
|---|---|
| Runtime product model | `docs/architecture/configured-product-architecture.md` |
| Rector 2.0 production map | `docs/plans/2-0/rector_capability_slm_fabric_production_plan_package/rector_capability_slm_fabric_production_plan.md` |
| Active implementation plan | Matching file under `docs/plans/2-0/phases/` (see phase map below) |
| Deferred risks | `docs/plans/concerns-and-vulnerabilities.md` |
| Legacy chunk history | `docs/plans/chunks/*.md` — use only when a task explicitly references a chunk |
| Old task-MVP modules | `docs/plans/chunks/002-migration-map.md` before touching legacy paths |
| Branch-specific specs | `.kiro/specs/**` — **only if present** in the current branch/worktree |

Quarantined docs carry stale banners; canonical architecture and 2.0 phase plans override them.

## Product Rules (configured product)

- Chat is gated until `orchestrationProfile` is `configured` and readiness passes.
- **`.rector/runtime-settings.json`** (UI-written) is product state — not `ORCHESTRATOR_MODE` for normal use.
- **Single chat path:** `runOrchestratedChatRun` — no parallel fake-chat product path.
- **Deterministic doubles are CI/test-only** (`SpyLLMProvider`, in-memory stores).
- **`ORCHESTRATOR_MODE` is deprecated** — migration/advanced override only.

Details: `docs/architecture/configured-product-architecture.md` and skill `rector-configured-product-guardian`.

## Rector 2.0 phase pointers

Do **not** use `AGENTS.md` as a live checklist. Phase status and evidence belong in `docs/plans/2-0/phases/`, `docs/plans/rector-master-roadmap.md`, and `.omo/evidence/*` artifacts.

- Production phase map: `docs/plans/2-0/rector_capability_slm_fabric_production_plan_package/rector_capability_slm_fabric_production_plan.md`
- Phase execution plans: `docs/plans/2-0/phases/*.md`
- Current repo-grounded pointers: Phase 1 Cartographer is complete per `phase-1-cartographer.md`; Phase 2 typed facts is planned in `phase-2-typed-facts.md`.
- Foundation verify (0 + 0.5): `npm run verify:foundation`.

## Build / test commands

```bash
npm install
npm test
npm run build
npm audit          # before claiming completion
```

**Harness / quality (offline unless noted):**

- `npm run eval:capabilities` / `eval:capabilities:gate` — capability eval corpus → `.omo/evidence/eval-report.*`
- `npm run test:global` / `test:global:gate` — global scenarios → `.omo/evidence/global-report.*`
- `npm run test:systems` — specialist profile contract validation (no execution)
- `npm run audit:no-fakes` — fake-seam report (non-blocking)
- `npm run cartographer:self-scan` / `cartographer:self-scan:check` — after Cartographer changes
- `npm run check` — `tsc --noEmit`
- `npm run dev` — local server (`tsx watch`, optional `.env`)

Run fresh `npm test`, `npm run build`, and `npm audit` before claiming implementation complete.

## Azure (opt-in dev touchpoints)

Not required for CI or contributor setup. On the Grok dev VM, optional scripts: `npm run azure:daily-touch`, `evidence:sync`, `cartographer:sync` (see `.env.example`, `.grok/skills/rector-azure-daily-ritual/SKILL.md`). Azure MCP (`azure` in `~/.grok/config.toml`) when working with Azure resources.

## Implementation workflow

Work **one phase slice or ticket** at a time. Prefer plans under `docs/plans/2-0/phases/`; legacy `docs/plans/chunks/` only when explicitly scoped.

```
plan (optional) → rector-generalCoder-fast | rector-generalCoder-deep → verify → rector-librarian → commit
```

- Parent orchestrator owns decomposition, worktree assignment, merge order, verification, and final synthesis.
- For phases with many independent features, create one short-lived worktree/branch per feature, merge into a phase integration branch in dependency order, run full gates there, then fix integration fallout before merging onward.
- Use stacked PRs/branches when features depend on each other; parallelize only low-overlap tickets.

### Worktrees and CodeGraph

Rector worktrees live under `.worktrees/` inside the main checkout. The CodeGraph MCP server resolves indexes by walking up to the nearest `.codegraph/` directory. **Each worktree needs its own index** — otherwise queries silently borrow the main-repo index (wrong branch, missing worktree-only symbols). Grok does not auto-init on session start.

**After `git worktree add` (required once per worktree):**

```bash
npm run codegraph:worktree -- .worktrees/<branch-name>
# or, from inside the worktree:
npm run codegraph:worktree
```

**Catch up all existing worktrees (one-time or after many adds):**

```bash
npm run codegraph:worktrees:all
```

**Refresh an existing index after large edits:** `npm run codegraph:worktree -- --sync .worktrees/<name>`

Orchestrators: include CodeGraph init in worktree assignment instructions for every spawned subagent. Subagents should use `codegraph_*` MCP tools only after the worktree-local index exists; if a tool result warns about a "different git worktree", run the init command above before relying on symbol/caller data.
- **Foreground subagents only** unless the user explicitly requests safe background work.
- Coders avoid doc edits unless asked; **librarian** syncs phase docs, concerns, and minimal `AGENTS.md` facts after verify.
- Update `docs/plans/concerns-and-vulnerabilities.md` when discovering risks.

Routing detail: `.grok/skills/rector-subagent-routing/SKILL.md`. Planning/worktree discipline: `.opencode/skills/rector-phase-chunk-planner/SKILL.md`.

### Subagent routing

Do not use `general-purpose` for Rector implementation.

| Role | `subagent_type` | Model |
|---|---|---|
| Low–mid implementation | `rector-generalCoder-fast` | `grok-composer-2.5-fast` |
| Hard / cross-cutting | `rector-generalCoder-deep` | `azure-gpt-5-5` |
| Post-verify doc sync | `rector-librarian` | `grok-composer-2.5-fast` |
| Codebase map only | `explore` | per `config.toml` |
| Plan before coding | `plan` | per `config.toml` |

## Project skills

Grok-native skills live in `.grok/skills/<name>/SKILL.md` and should be preferred in Grok Build. `.opencode/skills/` may mirror compatibility docs for OpenCode; do not treat it as the primary Grok skill surface.

| Skill | Use when |
|---|---|
| `rector-subagent-routing` | Spawning coders/librarian |
| `rector-phase-chunk-planner` | Phase/ticket scope, plans, verification gates |
| `rector-configured-product-guardian` | Onboarding, runtime settings, chat path, spy boundaries |
| `rector-cartographer-graph-builder` | Cartographer / structural graph |
| `rector-evidence-gatekeeper` | Evals, validators, evidence, `insufficient_evidence`, promotion |
| `rector-fake-purge-auditor` | Fake/spy seams, `audit:no-fakes` |
| `rector-docs-replacement-surgeon` | User-facing doc wording (configured-product language) |
| `rector-azure-daily-ritual` | Optional Azure dev VM touchpoints |

Deferred until later phases (see production plan): capability contracts, Capability-SLM fabric, Memory OS, specialist contracts, UI onboarding QA, provider runtime settings, security/budget redaction, release evidence runner — add skills when those phases open; do not invent parallel workflows.

## Commit identity

All commits must use:

- Name: `Lanz Skyler B. Busa`
- Email: `274020196+ArchiTecCTT@users.noreply.github.com`

Set repo-local `git config user.name` / `user.email` before committing (VM default identity does not attribute to GitHub).

## Security / concerns rule

Update `docs/plans/concerns-and-vulnerabilities.md` when you find dependency issues, secret/PII leakage, sandbox gaps, provider/budget risks, stale architecture docs, test gaps, or production hardening limits.

Do not run `npm audit fix --force` blindly. Re-run `npm audit` before release; record new advisories in the concerns register.