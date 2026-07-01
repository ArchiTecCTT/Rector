# Rector Agent Guide

## Project Vision

Rector is Apache-2.0 open-source software: a chat-first self-healing AI engineering orchestration system.

User experience goal: user interacts like Claude/ChatGPT in a **hassle-free** way. The app is designed to be configurable entirely through the web UI — users select and configure their own providers for LLMs, memory databases (SQLite, Mem0, TiDB Cloud, and others), sandbox, telemetry, etc., without editing files or environment variables. Hidden beneath chat, Rector runs deterministic orchestration: triage, context building, planning, skeptic review, crucible arbitration, DAG compilation, execution, validation, healing, and synthesis. Users should not manage agents, model routing, retries, validation, or repair loops manually.

The product is **configured orchestration**, not a provider-free demo. Fresh installs start **unconfigured** with mandatory first-run onboarding until readiness passes. There is no fake chat presented as the product.

## Current Branch / Worktree

- Active branch: `zai-evidence-live-integration` (merge target: `rector-0.3.0`)
- Worktree path: `/home/ornyx-opifex/projects/rector/.worktrees/zai-evidence-integration`
- Primary goal: Z.ai live evidence + fake-purge hardening (`.rector/evidence`, `verify:zai-live`); **Z.ai finalist** `glm-4-32b-0414-128k` gate PASS @ 2026-07-01 (`75f4233`); matrix/other models and Regolo remain unverified.

## Source of Truth

Read these before planning or implementing:

1. `docs/architecture/configured-product-architecture.md` — **canonical** product model (unconfigured vs configured, runtime settings, onboarding, single orchestration path, spy-only CI).
2. `.kiro/specs/cloud-capable-transition/` (requirements.md, design.md, tasks.md) — active implementation spec aligned to the configured-product architecture.
3. `docs/plans/rector-master-roadmap.md` — roadmap including v0.3.0 configured-product milestone.
4. `docs/plans/chunks/*.md` for completed/current chunk plans (pre-v0.3.0 chunk plans carry stale banners).
5. `docs/plans/concerns-and-vulnerabilities.md` for deferred risks.
6. `docs/plans/chunks/002-migration-map.md` before touching old task-MVP modules.

Stale/quarantined docs have warning banners. If stale docs conflict with source-of-truth docs, source-of-truth wins. `docs/architecture/current-rector-byok-architecture.md` and `docs/architecture/rector-0.1.0-architecture.md` are retained for reference but are no longer authoritative.

## Product Rules (v0.3.0+)

- **Product = configured orchestration.** Chat is gated until `orchestrationProfile` is `configured` and readiness passes.
- **Source of truth = `.rector/runtime-settings.json`**, written by the UI. Not `ORCHESTRATOR_MODE` env for normal use.
- **Single orchestration path:** `runOrchestratedChatRun` — no parallel fake-chat product path.
- **Deterministic doubles = test-only.** `SpyLLMProvider` and in-memory stores are for `npm test` / CI, not end-user defaults.
- **`ORCHESTRATOR_MODE` is deprecated** — advanced override / migration only; primary configuration is UI setup.

## Build / Test Commands

- Install: `npm install`
- Test: `npm test`
- Build: `npm run build`
- Dependency audit: `npm audit`
- Dev server: `npm run dev`
- Capability evals (offline, no model): `npm run eval:capabilities` (and `npm run eval:capabilities:report`) — runs the committed eval corpus and writes `.rector/evidence/capabilities/eval-report.{json,md}` (legacy `.omo/evidence` is read/migrated for compatibility only)
- Fake-seam audit: `npm run audit:no-fakes` (report-only, non-blocking) and `npm run audit:no-fakes:check` (strict, fails on unallowed seams); Z.ai hardening targets 0 unallowed (20 allowlisted compatibility seams until Phase 3/13 purge)
- Global reliability harness (offline, one scorecard per scenario): `npm run test:global` — runs the committed scenarios against the fixture workspace and writes `.rector/evidence/global/global-report.{json,md}`; live scenarios are SKIPPED when no credentials are present
- Typed fact evals (offline): `npm run eval:facts` → `.rector/evidence/phase2/fact-report.{json,md}`; opt-in live shadow: `RECTOR_LIVE_PROVIDER=zai npm run eval:facts:live` (`LIVE_FACT_EVALS=1`) → `.rector/evidence/phase2/live-fact-shadow-*` (exits nonzero without a live provider); Phase 2 gate: `npm run verify:phase2`
- Evidence paths: `npm run evidence:verify-paths`, optional `npm run evidence:migrate-local` (legacy `.omo/evidence` → `.rector/evidence`)
- Z.ai live verification (opt-in, credentials, not default CI): **single-model** `npm run verify:zai-live` chains `verify:phase2`, live fact shadow, `test:live:zai:provider`, `test:live:zai:harness`, `evidence:zai-live:gate` (may update manifest on PASS); **multi-model compare** `npm run verify:zai-live:matrix` repeats the live chain per `ZAI_MODELS` entry, writes `matrix-summary.*` only, gate uses `--no-manifest-update` — see `docs/operations/zai-live-verification.md`; env prefers `ZAI_API_KEY` / `ZAI_BASE_URL` / `ZAI_MODEL` (shell-safe) with `OPENAI_COMPATIBLE_*` fallback — do **not** use `Z.AI_API_KEY` in shell exports; do **not** export `RECTOR_LIVE_HARNESS_*_MAX_OUTPUT_TOKENS` in the verify shell (pollutes `verify:phase2` unit tests); finalist `glm-4-32b-0414-128k` gate PASS documented — other models still need single-model gate PASS for live claims
- Specialist contract validation: `npm run test:systems` — validates committed specialist profiles against the contract schema (no execution)
- Azure daily ritual (dev VM, opt-in): `npm run azure:daily-touch` — Key Vault list + Blob uploads + App Insights heartbeat
- Harness Blob sync: `npm run evidence:sync` — when `RECTOR_EVIDENCE_SYNC=azure-blob`
- Cartographer Blob sync: `npm run cartographer:sync` — uploads `.rector/cartographer/*` after `npm run cartographer:self-scan`

## Azure Daily Ritual (Grok Build + Founders Hub)

**Goal:** Touch **5 Azure services** daily while developing Rector — VM, Foundry, Blob, Key Vault, App Insights — for Microsoft for Startups Founders Hub eligibility.

| # | Service | Resource | Daily touch |
|---|---|---|---|
| 1 | VM | `ornyx-1` | Grok Build sessions (automatic) |
| 2 | Foundry | Azure OpenAI deployments | Model calls in Grok Build (automatic) |
| 3 | Blob Storage | `stgrectordev` | `npm run azure:daily-touch` or `npm run evidence:sync` |
| 4 | Key Vault | `kv-rector-dev` | `npm run azure:daily-touch`; `RECTOR_SECRET_STORE=azure-key-vault` on `npm run dev` |
| 5 | App Insights | `appi-rector-dev` | `npm run azure:daily-touch`; `npm run dev` + harness scripts |

**Auth:** `az login` user credentials on the dev VM (no VM managed identity). Config lives in `.envrc` (gitignored) — see `.env.example` for variable names.

### Session start (every Grok Build day)

```bash
az account show >/dev/null 2>&1 || az login
direnv allow                    # loads .envrc Azure vars
npm run azure:daily-touch       # KV + Blob + App Insights in one command
```

### After harness / cartographer work

```bash
npm run eval:capabilities       # optional
npm run test:global             # optional
npm run evidence:sync           # harness reports → harness-evidence container

npm run cartographer:self-scan  # if graph stale
npm run cartographer:sync       # cartographer container on stgrectordev
```

### Azure MCP (Grok Build)

MCP server `azure` (`@azure/mcp`) is configured in `~/.grok/config.toml`. Restart Grok Build after config changes. Use namespaces: `storage`, `keyvault`, `monitor`, `foundry`.

### Grok skill

Load `.grok/skills/rector-azure-daily-ritual/SKILL.md` at session start when Azure usage is the goal (restart session after adding the skill).

### Implemented helpers (Chunk 052+)

1. **`npm run azure:daily-touch`** — one-shot morning ritual (KV list, harness Blob upload if reports exist, cartographer Blob upload if artifacts exist, App Insights `rector.azure.daily_touch` event).
2. **`rector-azure-daily-ritual` skill** — agent checklist for session start + MCP prompts.
3. **`npm run cartographer:sync`** — uploads `latest-snapshot.json`, `latest-files.json`, `scan-report.md` from `.rector/cartographer/`.

**Not in CI:** Azure env vars unset in `npm test` / GitHub Actions — local dev VM only.

Phase 0 added these measurement surfaces: `src/capabilities/eval/*` (eval schemas, 8-metric scorer, raw artifact store), `scripts/evals/*` (offline runner + report formatter), `scripts/audit/*` (fake-seam scanner), and `tests/fixtures/eval-corpus/` (committed real `rg`/`tsc`/`git` artifacts + oracles).

Phase 0.5 added the Global Reliability Harness surfaces: `src/evals/*` (global scenario schema, 8-dimension scorecards, offline global runner) and `src/systems/*` (specialist contract/task/result schemas, SystemRegistry validation stub, `specialistProfiles/coding.profile.json`), plus `scripts/evals/{run-global-harness,run-specialist-system-contracts}.ts`, `tests/global/` scenarios, and the `tests/fixtures/repos/rector-mini-fix/` fixture repo. These are CONTRACTS + HARNESS only — specialist execution / routing is Phase 11/12 and not yet built.

**Phase 0 / Phase 0.5 status — DONE — gates passed on 2026-06-24 at 65f6557d8c57a9bf8489e5d6bd881e300afefb80:** All six gates passed (`eval:capabilities:gate`, `baseline:phase0`, `verify:phase0`, `test:global:gate`, `verify:phase0.5`, `verify:foundation`). 10 eval cases (2 efficiencyRelevant cases meet >=10x compression / >=0.80 raw_token_reduction; aggregate efficiency is honestly not all-green but the gate uses designated-case efficiency). Global: 28 scenarios, 21 strict-pass, 8 intentional regressions, all actual==expected. The ExecutiveRouter and real specialist execution are NOT implemented (deferred to Phase 11/12); the harness emits dry-run task packets/traces only, never specialist-driven repository mutation. The fake-system purge is deferred (Phase 3 / fake-purge workstream); `npm run audit:no-fakes` remains report-only (non-blocking, never CI-failing) until Phase 13.

**Phase 2 typed facts — OFFLINE DONE / Z.ai FINALIST LIVE VERIFIED — `verify:phase2` @ `45768e5`, live gate @ 2026-07-01:** Fact protocol in `src/facts/**` (PRs #21–#26). Completion report: `docs/plans/2-0/phases/phase-2-completion-report.md`. Label: `phase2-complete-live-verified-zai-finalist` (`glm-4-32b-0414-128k` `verify:zai-live` PASS); Regolo and non-finalist Z.ai models unverified. Next neuro-symbolic work: Phase 2.1 / 2.2 Memory OS, then 2.4 / 2.5.

Before claiming completion, run fresh:

```bash
npm test
npm run build
npm audit
```

## Implementation Workflow

- Work one chunk at a time.
- Each chunk gets its own plan under `docs/plans/chunks/` before code.
- Commit each completed chunk separately.
- Keep `docs/plans/concerns-and-vulnerabilities.md` updated with concerns, vulnerabilities, limitations, and deferred fixes.
- No background/async subagents; foreground only. Background subagents caused stale-run failures.
- Parent orchestrator remains in charge: plan (optional) → coder → verify → librarian → commit → next chunk.

### Subagent routing (do not use `general-purpose` for implementation)

Spawn project agents from `.grok/agents/` — see `.grok/skills/rector-subagent-routing/SKILL.md`:

| Role | `subagent_type` | Model |
|---|---|---|
| Low–mid implementation | `rector-generalCoder-fast` | `grok-composer-2.5-fast` |
| Hard / cross-cutting implementation | `rector-generalCoder-deep` | `cf-glm-5-2` (Cloudflare Workers AI GLM 5.2) |
| Post-verify doc sync | `rector-librarian` | `grok-composer-2.5-fast` |
| Codebase map / search only | `explore` | per `config.toml` |
| Plan before coding | `plan` | per `config.toml` |

**Deep coder rate limit:** never more than **2** concurrent `rector-generalCoder-deep` subagents — Cloudflare Workers AI rate limits `cf-glm-5-2`. Queue or wait for completion before spawning a third.

Coders do not edit docs (unless explicitly asked); **librarian runs after** `npm test` + `npm run build` + `npm audit` pass to sync chunk plans, concerns, and `AGENTS.md` facts.

## Rector Project Skills

Project-scoped OpenCode skills live under `.opencode/skills/<name>/SKILL.md`. They are loaded by OpenCode at session start, so newly added or edited skills require restarting the OpenCode session before they appear in the `skill` tool.

Use these active Rector skills when their domain matches:

- `rector-subagent-routing` — spawn routing for `rector-generalCoder-fast`, `rector-generalCoder-deep`, and `rector-librarian`; deep-coder concurrency cap (max 2).
- `rector-configured-product-guardian` — v0.3.0 configured-product invariants, onboarding/runtime settings, single chat path, fake/spy CI-only boundaries.
- `rector-phase-chunk-planner` — chunk planning discipline, source-of-truth reads, scope boundaries, concerns updates, and verification gates.
- `rector-docs-replacement-surgeon` — Phase 1 documentation replacement, stale local/external/provider-free wording, README/spec/roadmap alignment.
- `rector-cartographer-graph-builder` — Cartographer structural graph expansion beyond file inventory: symbols, imports, calls, tests, routes, skills, rules, impact edges.
- `rector-evidence-gatekeeper` — typed evidence, grounded validation, `insufficient_evidence` instead of guessing, safe memory/skill promotion.
- `rector-fake-purge-auditor` — fake/deterministic double containment, fake seam audits, simulator/tool fallback boundaries, `configured_spy_pipeline` naming.
- `rector-azure-daily-ritual` — Grok Build session-start checklist for 5-service Azure daily usage (Founders Hub); `azure:daily-touch`, evidence/cartographer sync, Azure MCP.

Deferred Rector skills to add when their phases become active:

- `rector-capability-contract-generator` — universal capability contracts for MCP, ToolRegistry, skills, validators, recipes, memory providers, browser tools, APIs, and plugins.
- `rector-capability-slm-fabric` — tool-specific Capability-SLM manager, evidence packet extraction, and cheap-model compression over raw tool exhaust.
- `rector-memory-os-guardian` — MemoryGate, durable memory, contradiction handling, consolidation, pruning, and safe skill promotion.
- `rector-specialist-system-contracts` — ExecutiveRouter and Coding Specialist System contracts once Phase 11/12 specialist execution begins.
- `rector-ui-onboarding-qa` — first-run onboarding overlay, readiness UI, provider setup, chat gate, and browser QA.
- `rector-provider-runtime-settings` — provider setup, ModelRouter configuration, runtime settings schema, env migration, and readiness checks.
- `rector-security-budget-redaction` — budget enforcement, approvals, sandbox policy, redaction, telemetry safety, and raw artifact policy.
- `rector-release-evidence-runner` — pre-commit/release evidence bundle, full gates, targeted evals, fake audit, and final completion summary.

## Commit Identity

All commits (including those made by subagents) must be authored and committed as:

- Name: `Lanz Skyler B. Busa`
- Email: `274020196+ArchiTecCTT@users.noreply.github.com`

The VM's default git identity is `Ubuntu <…@…cloudapp.net>`, which does NOT attribute to the GitHub account. Before committing, set the repo-local identity (`git config user.name` / `git config user.email`) to the values above so contributions attribute to `ArchiTecCTT`. If commits were already made under the VM default and have not been pushed, re-stamp author+committer before pushing.

## Current Implemented Chunks

Completed through Chunk 52 (see `docs/plans/chunks/052-azure-dev-harness-stack.md`). Chunk 51 (`051-inspection-cleanup`) remains in the worktree plan queue. Foundation chunks 0–25:

0. Source-of-truth docs and stale doc quarantine
1. Open-source foundation and Apache-2.0 setup
2. Repo migration map and compatibility strategy
3. Protocol foundation
4. Core data model and local store
5. Run state machine and event log
6. Chat API vertical shell
7. Budget, security, and redaction baseline
8. Triage and context builder
9. Planner schema and fake planner
10. Skeptic review
11. Crucible arbitration
12. DAG compiler
13. Executor simulator
14. Validation and healing loop
15. End-to-end chat brainstem test
16. Observability baseline
17. Provider adapter layer phase 1
18. Provider adapter layer phase 2
19. Memory, search, and truth library
20. Public extension contracts
21. Retool operator console API
22. Safe code execution
23. External workflow integrations
24. Deployment prototype
25. Contributor issue breakdown

Neuro-symbolic + cloud transition chunks (26–37) include SLM preprocessor, advanced memory, proactive layer, symbolic engines, MCTS, ponder swarm, task decomposition, stale-doc cleanup, pluggable memory providers (034), durable memory + neuro wiring (035), hassle-free UI + neuro observability (036), and vitest 4 + live memory tests + opt-in multi-user auth (037).

Current test baseline after Phase 2 offline gate (branch `rector-0.3.0`, commit `45768e5`):

- `npm test`: 410 files passed / 1 skipped; 2829 tests passed / 5 skipped (live-memory skips only: `tests/memoryLive.integration.test.ts`, offline; post harness hardening @ `75f4233`).
- `npm run build`: passing
- `npm audit`: 0 vulnerabilities

## Active Development Goal

**v0.3.0 configured product:** transition from local/external dual-mode to unconfigured/configured product model per `docs/architecture/configured-product-architecture.md`.

Key deliverables:

- UI-persisted `runtime-settings.json` as authoritative product state
- Mandatory uncloseable first-run onboarding overlay until readiness passes
- Consolidate chat dispatch to `runOrchestratedChatRun` (no fake chat as product)
- `SpyLLMProvider` for CI only; remove provider-free path as user-facing default
- Deprecate `ORCHESTRATOR_MODE` env knob; primary path = UI setup
- Full web-UI configurability for providers, memory, sandbox, budgets
- Neuro-symbolic features integrated into configured product (not gated behind a separate local demo)

Every new feature must be extensively tested. Architecture stays non-rigid and pluggable. Use web_search for choices when unsure. At end of major work, run reviews. Keep `docs/plans/concerns-and-vulnerabilities.md` complete. Follow chunk discipline.

## Next Work

- **Neuro-symbolic:** Phase 2.1 / 2.2 Memory OS (consume validation-linked facts); then Phase 2.4 Capability Contract Generator and Phase 2.5 Capability-SLM Fabric — see `docs/plans/2-0/phases/phase-2-completion-report.md` handoff.
- **Configured product (v0.3.0):** onboarding gate, `runOrchestratedChatRun` consolidation, spy-only CI — `.kiro/specs/cloud-capable-transition/tasks.md`.
- **Phase 2 / Z.ai follow-up:** official gate PASS on `glm-4-32b-0414-128k`; repeat `verify:zai-live` per model before new live claims; Regolo `verify:regolo-live` still open (`gemma4-31b` harness timeouts post-hardening).

## Release Path

### v0.3.0 — configured product

Mandatory onboarding, `runtime-settings.json` source of truth, single orchestration path, spy-only CI, deprecated `ORCHESTRATOR_MODE`.

### v0.2.0 / prior — BYOK alpha (historical)

Local/external dual mode, provider-free regression baseline as product default. Superseded by v0.3.0.

### Public alpha

Configured product + optional real providers, durable persistence, observability, basic auth for hosted demo.

### Beta

Safe sandbox execution, operator console, memory/search, Linear/Make integrations, deployment docs, deeper security review.

### Production / v1

Multi-user auth, quotas/billing, durable infra, robust sandboxing, compliance posture, monitoring/SLOs, backup/restore, incident response, stable plugin/provider contracts.

## Stack Credits / Optional Integrations

Credits available for later optional integrations. Do not make these required for contributor setup.

- Perplexity Enterprise Pro: 3 months
- Retool Business: 13 months
- PostHog: $50K
- Chroma: $5K
- Depot: $5K
- Make Teams: 6 months + 240K credits/12 months
- DeepGram: $1.2K+ possibly more
- Linear Business: 6 months
- Algolia: $10K
- Azure: $5K
- AWS: $5K? unconfirmed
- Cloudflare: $10K
- Heroku: $13/month for 2 years
- MongoDB: $3.6K? unconfirmed
- Together AI Build: $15K
- DataDog Pro: 10 servers / 2 years
- New Relic: $300/month / 2 years
- BrowserStack Automate Mobile: 1 parallel, 1 user, 1 year
- CodeScene student private repo analysis
- CodeCov free private/public access
- Sentry: 50K errors, 100K transactions, 1GB attachments, 500 replays, team, 1 year
- Requestly Pro: 1 year
- Serenities: 3 months unclaimed
- VibeFlow: 3 months unclaimed
- Amplitude Scholarship: 1 year
- Confluent: 30-day trial + $4K credits
- Bubble: $2.5K until 2026-11-29
- Mixpanel: $50K startup plan
- Doppler: 3 months
- DigitalOcean Hatch: $1K? unconfirmed
- Middleware: $5K
- AssemblyAI: $500
- OpenAI ChatGPT Business: 1 seat / 2 years
- Miro 1 year Business plan & $1k credits
- Parallel AI $80 credits
- E2B $20.1K credits
- Novita $100 Sandbox Credits
- Webflow CMS Plan 12 Months

## Confluent Note

Confluent is managed Kafka/event streaming. Treat it as a later scaling option for high-throughput/replayable event streams, not a v0.3.0 dependency. Credits usually apply to Confluent Cloud usage, not arbitrary subscriptions.

## Security / Concerns Rule

Always update `docs/plans/concerns-and-vulnerabilities.md` when discovering:

- dependency vulnerabilities
- secret/PII leakage risks
- sandbox risks
- provider/budget risks
- stale docs or confusing architecture
- test gaps
- production-hardening limitations

Current security status: `npm audit` reports 0 vulnerabilities on branch `rector-0.3.0`. The previously-tracked 5-advisory dev-tooling item (4 moderate, 1 critical) was cleared via additive `package.json` `overrides` for `esbuild`/`undici`/`ws` (no `npm audit fix --force`, no runtime dependency change). Keep auditing before public release and do not run `npm audit fix --force` blindly; restore an entry here if new advisories surface.
