# Rector Agent Guide

## Project Vision

Rector is Apache-2.0 open-source software: a chat-first self-healing AI engineering orchestration system.

User experience goal: user interacts like Claude/ChatGPT. Hidden beneath chat, Rector runs deterministic orchestration: triage, context building, planning, skeptic review, crucible arbitration, DAG compilation, execution, validation, healing, and synthesis. Users should not manage agents, model routing, retries, validation, or repair loops manually.

## Current Branch / Worktree

- Active branch: `rector-0.1.0`
- Worktree path: `C:/Users/MharSky/Dev/Projects/Rector/.worktrees/rector-0.1.0`
- Target first public release: `v0.1.0-alpha` local developer preview, not production SaaS.

## Source of Truth

Read these before planning or implementing:

1. `docs/architecture/rector-0.1.0-architecture.md`
2. `docs/plans/rector-master-roadmap.md`
3. `docs/plans/chunks/*.md` for completed/current chunk plans
4. `docs/plans/concerns-and-vulnerabilities.md` for deferred risks
5. `docs/plans/chunks/002-migration-map.md` before touching old task-MVP modules

Stale/quarantined docs have warning banners. If stale docs conflict with source-of-truth docs, source-of-truth wins.

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

Completed through Chunk 10:

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

Current test baseline after Chunk 10:

- `npm test`: 13 files / 130 tests passing
- `npm run build`: passing

## Active Development Goal

User approved continuing Alpha Build development through the final roadmap chunk. Optimize for fast, responsive, light system design; credits are available but local/provider-free mode must remain default. Every new feature must be extensively tested. If unsure about architecture/library choices, use web_search and choose the most logical option, not merely the most token-cheap option. At end, run multiple `google-vertex/gemini-3.5-flash` review agents over the full worktree to document only valid bugs/vulnerabilities/issues, including undocumented ones; reviewers must validate findings with code/tests where possible. Keep `docs/plans/concerns-and-vulnerabilities.md` complete.

## Next Chunks Needed for v0.1.0-alpha

Minimum release-critical chunks still needed:

11. Crucible arbitration
12. DAG compiler
13. Executor simulator
14. Validation and healing loop
15. End-to-end chat brainstem test
16. Observability baseline

Additional release-prep items:

- clean local UI demo
- CI
- dependency audit triage
- screenshots/GIF
- docs for strangers
- release tag

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
