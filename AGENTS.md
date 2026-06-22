# Rector Agent Guide

## Project Vision

Rector is Apache-2.0 open-source software: a chat-first self-healing AI engineering orchestration system.

User experience goal: user interacts like Claude/ChatGPT in a **hassle-free** way. The app is designed to be configurable entirely through the web UI — users select and configure their own providers for LLMs, memory databases (SQLite, Mem0, TiDB Cloud, and others), sandbox, telemetry, etc., without editing files or environment variables. Hidden beneath chat, Rector runs deterministic orchestration: triage, context building, planning, skeptic review, crucible arbitration, DAG compilation, execution, validation, healing, and synthesis. Users should not manage agents, model routing, retries, validation, or repair loops manually.

The product is **configured orchestration**, not a provider-free demo. Fresh installs start **unconfigured** with mandatory first-run onboarding until readiness passes. There is no fake chat presented as the product.

## Current Branch / Worktree

- Active branch: `rector-0.3.0-configured-product`
- Worktree path: `C:/Users/MharSky/Dev/Projects/Rector/.worktrees/rector-0.2.0`
- Primary goal: Kill local mode as default product. Ship v0.3.0 as a configured-only commercial product with UI-persisted `runtime-settings.json`, mandatory onboarding, and a single orchestration path (`runOrchestratedChatRun`).

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
- Dev server: `npm run dev`

Before claiming completion, run fresh:

```bash
npm test
npm run build
```

## Implementation Workflow

- Work one chunk at a time.
- Each chunk gets its own plan under `docs/plans/chunks/` before code.
- Commit each completed chunk separately.
- Keep `docs/plans/concerns-and-vulnerabilities.md` updated with concerns, vulnerabilities, limitations, and deferred fixes.
- No background/async subagents; foreground only. Background subagents caused stale-run failures.
- Preferred model routing for this project:
  - Implementors/workers: `azure-openai-responses/gpt-5.5`
  - Reviewers: `vultr/zai-org/GLM-5.1-FP8-normalize:high`
  - Debug/fix workers: `google-vertex/gemini-3.5-flash`
- Parent orchestrator remains in charge: worker -> GLM review -> Gemini fixes if needed -> verify -> commit -> next chunk.

## Current Implemented Chunks

Completed through Chunk 37 (see `docs/plans/chunks/037-vitest-auth-live-memory.md`). Foundation chunks 0–25:

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

Current test baseline after Chunk 37:

- `npm test`: 213 files / 1369 tests passing (4 skipped live-memory; 1 skipped file)
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

Phase 1 (docs): full documentation replacement per configured-product architecture.

Phase 2+ (code): implement onboarding gate, `runOrchestratedChatRun` consolidation, remove fake-chat product path, migrate benchmarks to `configured_spy_pipeline` naming.

See `.kiro/specs/cloud-capable-transition/tasks.md` for detailed implementation items.

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

Known current open item: `npm audit` reported 5 vulnerabilities (4 moderate, 1 critical). Triage before public release; do not run `npm audit fix --force` blindly.
