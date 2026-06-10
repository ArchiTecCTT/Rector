# Rector Agent Guide

## Project Vision

Rector is Apache-2.0 open-source software: a chat-first self-healing AI engineering orchestration system.

User experience goal: user interacts like Claude/ChatGPT in a **hassle-free** way. The app is designed to be configurable entirely through the web UI — users select and configure their own providers for LLMs, memory databases (local in-memory/SQLite, Mem0, TiDB Cloud, and others), sandbox, telemetry, etc., without editing files or environment variables. Hidden beneath chat, Rector runs deterministic orchestration: triage, context building, planning, skeptic review, crucible arbitration, DAG compilation, execution, validation, healing, and synthesis. Users should not manage agents, model routing, retries, validation, or repair loops manually.

The system supports a non-rigid, pluggable architecture so it can run locally for development or scale to a VPS/cloud deployment as a usable daily coding tool.

## Current Branch / Worktree

- Active branch: `rector-0.1.0`
- Worktree path: `C:/Users/MharSky/Dev/Projects/Rector/.worktrees/rector-0.1.0`
- Primary goal: Cloud-capable, VPS-deployable commercial product with full web-UI configuration for providers and backends (including memory). Local/provider-free mode remains the mandatory perfect regression baseline and contributor-friendly default.

## Source of Truth

Read these before planning or implementing:

1. `.kiro/specs/cloud-capable-transition/` (requirements.md, design.md, tasks.md) — current active spec for transitioning to a hassle-free, UI-configurable cloud-capable system.
2. `docs/architecture/current-rector-byok-architecture.md` — current architecture (local-first BYOK with pluggable providers).
3. `docs/plans/rector-master-roadmap.md` (update in progress for cloud direction).
4. `docs/plans/chunks/*.md` for completed/current chunk plans (including 26-32 neuro-symbolic enhancements for usability, 033-036 for cloud transition + hassle-free UI, and 037+ for follow-on work).
5. `docs/plans/concerns-and-vulnerabilities.md` for deferred risks.
6. `docs/plans/chunks/002-migration-map.md` before touching old task-MVP modules.

Stale/quarantined docs have warning banners. If stale docs conflict with source-of-truth docs, source-of-truth wins. Historical alpha-local docs (e.g. old rector-0.1.0-architecture.md) are retained for reference but are no longer authoritative for the primary product direction.

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

Completed through Chunk 36 (see `docs/plans/chunks/036-hassle-free-ui-neuro-observability.md` for the latest wave summary). Foundation chunks 0–25:

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

Neuro-symbolic + cloud transition chunks (26–36) include SLM preprocessor, advanced memory, proactive layer, symbolic engines, MCTS, ponder swarm, task decomposition, stale-doc cleanup, pluggable memory providers (034), durable memory + neuro wiring (035), and hassle-free UI + neuro observability (036).

Current test baseline after Chunk 36:

- `npm test`: 211 files / 1355 tests passing
- `npm run build`: passing

## Active Development Goal

Shift to a hassle-free, UI-configurable commercial cloud-capable system suitable for VPS deployment and daily coding work. The app must allow users to configure providers and backends (LLMs, memory databases like local/Mem0/TiDB Cloud, sandbox, etc.) entirely through the web UI without file or env edits. Local/provider-free mode must remain the mandatory, identical regression baseline for tests, contributors, and safe development (never broken by cloud features). 

The neuro-symbolic enhancements (chunks 26-32: SLM preprocessing, advanced hierarchical memory with notes/pruning/time-awareness, proactive layer, symbolic engines, MCTS, ponder swarm, task decomposition) are part of making the system actually usable and "alive" for real work.

Every new feature must be extensively tested. Architecture should stay non-rigid and pluggable to support the UI-config vision. Use web_search for choices when unsure. At end of major work, run reviews. Keep `docs/plans/concerns-and-vulnerabilities.md` complete. Follow chunk discipline: plan in `docs/plans/chunks/`, commit separately.

The .kiro/specs/cloud-capable-transition/ spec (adapted for hassle-free UI config and non-rigid design) is the active guide for the transition work.

## Next Work

Roadmap chunks 0–36 (foundation + neuro-symbolic usability + hassle-free memory UI) are implemented. Active focus is follow-on cloud-capable hardening per `.kiro/specs/cloud-capable-transition/` (live adapter integration tests, event-driven proactive/ponder triggers, streaming answer polish), extended with:

- Full web-UI configurability for all providers and backends, including pluggable memory database providers (local options, Mem0, TiDB Cloud, future).
- Non-rigid, pluggable architecture to avoid lock-in.
- Hassle-free experience: minimal or no file/env editing required for normal use.
- Integration of neuro-symbolic features into the configurable cloud product.

See the cloud-capable-transition tasks for detailed items. Create new chunk plans (starting 037+) for phases of this work.

## Release Path

### v0.1.0-alpha — local developer preview

Need complete local brainstem: Crucible, DAG compiler, executor simulator, validation/healing, synthesis, E2E test, clean UI demo, CI, dependency audit triage, screenshots/GIF, docs, tag release.

### Public alpha

Need optional real providers, durable persistence, better UI, observability, basic auth for hosted demo, provider setup docs.

### Beta

Need safe sandbox execution, operator console, memory/search, Linear/Make integrations, deployment docs, deeper security review.

### Production / v1

Need multi-user auth, quotas/billing, durable infra, robust sandboxing, compliance posture, monitoring/SLOs, backup/restore, incident response, stable plugin/provider contracts.

## Stack Credits / Optional Integrations

Credits available for later optional integrations. Do not make these required for local contributor setup.

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

## Confluent Note

Confluent is managed Kafka/event streaming. Treat it as a later scaling option for high-throughput/replayable event streams, not a v0.1.0-alpha dependency. Credits usually apply to Confluent Cloud usage, not arbitrary subscriptions.

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
