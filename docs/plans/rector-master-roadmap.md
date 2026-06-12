# Rector Master Roadmap

> **For agentic workers:** This is the master roadmap, not a per-task execution plan. Each chunk must get its own strict implementation plan before code changes. Use superpowers:writing-plans for each chunk and superpowers:subagent-driven-development or superpowers:executing-plans to execute it.
> Review status: updated after GLM plan reviews on 2026-06-03.
> License target: Apache-2.0.

**Goal:** Build Rector as an open-source, chat-first, self-healing neuro-symbolic orchestration system.

**Architecture:** Users interact with a normal chat UI. Hidden beneath it, Rector runs a deterministic orchestration pipeline: triage, context building, planning, skeptic review, crucible arbitration, DAG compilation, execution, validation, healing, and synthesis. The product is **configured orchestration** — fresh installs require guided setup (mandatory onboarding) before chat unlocks. Providers are adapter-based BYOK; CI uses `SpyLLMProvider` test doubles only.

**Tech Stack:** TypeScript/Node, Express initially, custom chat UI, Retool operator console later, local executor first, then BullMQ/Redis, MongoDB, Chroma, Algolia, Together AI, Cloudflare Workers AI, Azure OpenAI, Perplexity, E2B/Depot, PostHog, Sentry, Middleware/DataDog/New Relic, Linear, Make, Doppler.

---

## Source-of-Truth Docs

- Architecture: `docs/architecture/configured-product-architecture.md` (canonical v0.3.0+)
- Implementation spec: `.kiro/specs/cloud-capable-transition/`
- Master roadmap: `docs/plans/rector-master-roadmap.md`
- Per-chunk plans: `docs/plans/chunks/*.md`
- Reviews: `reviews/*.md`

## Open-Source Rule

Rector must be usable by contributors without maintainer-only credits.

Required baseline:

- Apache-2.0 license.
- Configured-product onboarding (unconfigured → configured via UI).
- `SpyLLMProvider` test doubles for CI (`npm test`); no fake chat as product.
- SQLite/local persistence for real installs; in-memory for tests.
- No required cloud services for tests.
- Optional adapters for premium services (BYOK).
- Contributor docs and contract tests for extension points.

## Current Repo Reality

The current code is the old local task MVP. The roadmap must migrate it into the new chat/run architecture. Any chunk that touches old `Task` concepts must either adapt them behind new `Run` interfaces or explicitly retire them.

## Chunking Rule

Do not build all at once. For every chunk:

1. Write exact implementation plan.
2. Get approval or confirm scope.
3. Implement only that chunk.
4. Run focused tests.
5. Run full baseline tests/build.
6. Commit.
7. Move to next chunk.

## Global Acceptance Gates

Every implementation chunk must preserve:

- `npm test` passes (spy doubles; zero real network).
- `npm run build` passes.
- Configured-product architecture invariants (see `configured-product-architecture.md`).
- No secret values in docs, logs, traces, test snapshots, or UI.
- New run phases match the symbolic brainstem in `configured-product-architecture.md`.
- Any old docs touched must be marked current/stale/archive explicitly.

---

# Implementation Chunks

## Chunk 0 — Source-of-Truth Docs and Stale Doc Quarantine

Mark the new architecture and roadmap as authoritative. Add `docs/README.md`. Banner or archive old local-MVP/cloud-heavy docs so agents do not follow stale plans. Update root README status.

## Chunk 1 — Open-Source Foundation and Apache-2.0 Setup

Add Apache-2.0 licensing and contributor scaffolding: `LICENSE`, `NOTICE`, `TRADEMARKS.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, GitHub issue templates, PR template, local provider-free quickstart, and adapter contribution guide skeleton.

## Chunk 2 — Repo Migration Map and Compatibility Strategy

Map old task-MVP files to the new chat/run architecture. Decide which modules are wrapped, renamed, retired, or temporarily preserved. Inventory tests to preserve or replace.

## Chunk 3 — Protocol Foundation

Create canonical protocol contracts: phases, envelopes, events, DAG schemas, node types, retry policies, validation policies, and schema tests. No providers or UI changes.

## Chunk 4 — Core Data Model and Local Store

Introduce `Conversation`, `Message`, `Run`, `Artifact`, `RunEvent`, and `Budget` types plus an in-memory local store. This becomes the provider-free contributor baseline.

## Chunk 5 — Run State Machine and Event Log

Implement the hidden run lifecycle using unified phases. Every transition emits append-only events. Invalid transitions are rejected. `NEEDS_DECISION` becomes a first-class resumable state.

## Chunk 6 — Chat API Vertical Shell

Replace task-first API/UX with chat-first endpoints and minimal UI. User can create/open a conversation, send a message, see assistant output, status pill, and optional trace/events.

## Chunk 7 — Budget, Security, and Redaction Baseline

Add cost/token/runtime budgets, redaction utilities, setup-checklist secret safety, CORS config, dev-only auth bypass, and budget-denial flow before real provider integrations exist.

## Chunk 8 — Triage and Context Builder

Implement deterministic triage routes and context-pack generation. Add artifact handles so large docs/logs/repos are referenced by handle instead of dumped into model context.

## Chunk 9 — Planner Schema and Fake Planner

Define structured planner input/output contracts and a deterministic fake planner for local tests. Plans include goal, assumptions, tasks, dependencies, validation, risk, and approval gates.

## Chunk 10 — Skeptic Review

Add adversarial plan review as a separate testable module. The Skeptic flags missing validation, unsafe assumptions, non-existent files/APIs, risk underestimates, and unsupported claims.

## Chunk 11 — Crucible Arbitration

Implement deterministic acceptance/revision/escalation rules. The Crucible resolves Planner vs Skeptic outputs without LLM judgment, with max two rounds and clear blocker handling.

## Chunk 12 — DAG Compiler

Compile accepted plans into validated JSON DAGs. DAGs include nodes, dependencies, validation nodes, budget policy, tool permissions, retry policies, and timeout metadata.

## Chunk 13 — Executor Simulator

Run DAGs locally with fake providers and safe node types. Enforce dependency order, retry policy, timeouts, structured node errors, and no unsafe shell by default.

## Chunk 14 — Validation and Healing Loop

Implement bounded self-healing. Validation failures are classified, minimal repairs are proposed/applied when safe, validation reruns, and unresolved issues escalate to `NEEDS_DECISION` or `FAILED`.

## Chunk 15 — End-to-End Chat Brainstem Test

Create the first full proof: chat message → triage → context → plan → skeptic/crucible → DAG → execution → validation failure → healing → final chat answer with trace evidence.

## Chunk 16 — Observability Baseline

Add trace IDs, latency, model-call count, estimated cost, fake actual costs, structured provider failure events, Sentry/PostHog adapter shapes, and Middleware/OpenTelemetry-style LLM span interface.

## Chunk 17 — Provider Adapter Layer Phase 1

Add LLM provider interface, model router, provider capability metadata, fake provider contract tests, and Together AI adapter behind env and budget gates.

## Chunk 18 — Provider Adapter Layer Phase 2

Add Cloudflare Workers AI, Azure OpenAI, and Perplexity research adapters. Implement route-based model assignment for cheap/fast/flagship/research calls.

## Chunk 19 — Memory, Search, and Truth Library

Add Chroma semantic memory, Algolia keyword/artifact search, and Truth Library statuses: `TRUSTED`, `UNVERIFIED`, `REJECTED`. Require provenance and citation handling.

## Chunk 20 — Public Extension Contracts

Document and test adapter extension points for open-source contributors: LLM, memory, sandbox, telemetry, search, issue tracker, validator, and UI client contracts.

## Chunk 21 — Retool Operator Console API

Expose admin/operator endpoints for run inspection, failures, approvals, costs, retries, aborts, artifact viewing, and Linear issue creation. Retool is an optional maintainer/operator UI, not the user product.

## Chunk 22 — Safe Code Execution

Add sandbox adapter, hardened safe local executor, patch artifacts, file-write approval gates, and E2B/Depot integration path for real test/build execution.

## Chunk 23 — External Workflow Integrations

Integrate Linear and Make for escalation tickets, notifications, reports, and approval workflows. Add Requestly and BrowserStack plans once API/UI behavior stabilizes.

## Chunk 24 — Deployment Prototype

Deploy a credible open-source demo/alpha: Heroku backend, optional Cloudflare frontend/proxy, MongoDB/Redis/Chroma config, Sentry/PostHog setup, graceful shutdown, deployment docs.

## Chunk 25 — Contributor Issue Breakdown

Convert roadmap chunks into GitHub issues with labels, acceptance criteria, test commands, difficulty levels, and `good first issue` candidates. Add project board/Linear sync guidance.

---

# Recommended Execution Order

1. Chunk 0 — Source-of-Truth Docs and Stale Doc Quarantine
2. Chunk 1 — Open-Source Foundation and Apache-2.0 Setup
3. Chunk 2 — Repo Migration Map and Compatibility Strategy
4. Chunk 3 — Protocol Foundation
5. Chunk 4 — Core Data Model and Local Store
6. Chunk 5 — Run State Machine and Event Log
7. Chunk 6 — Chat API Vertical Shell
8. Chunk 7 — Budget, Security, and Redaction Baseline
9. Chunk 8 — Triage and Context Builder
10. Chunk 9 — Planner Schema and Fake Planner
11. Chunk 10 — Skeptic Review
12. Chunk 11 — Crucible Arbitration
13. Chunk 12 — DAG Compiler
14. Chunk 13 — Executor Simulator
15. Chunk 14 — Validation and Healing Loop
16. Chunk 15 — End-to-End Chat Brainstem Test
17. Chunk 16 — Observability Baseline
18. Chunk 17 — Provider Adapter Layer Phase 1
19. Chunk 18 — Provider Adapter Layer Phase 2
20. Chunk 19 — Memory, Search, and Truth Library
21. Chunk 20 — Public Extension Contracts
22. Chunk 21 — Retool Operator Console API
23. Chunk 22 — Safe Code Execution
24. Chunk 23 — External Workflow Integrations
25. Chunk 24 — Deployment Prototype
26. Chunk 25 — Contributor Issue Breakdown

## Why This Order

- Docs/migration first prevents agents from following stale plans.
- Open-source scaffolding early makes the project contributor-ready before architecture churn grows.
- Protocol before providers prevents vendor-shaped architecture.
- Data model before state machine avoids building transitions over missing types.
- Budget/security before real providers prevents cost and privacy mistakes.
- Chat shell early keeps product vision honest.
- Planner/Skeptic/Crucible split makes each cognitive module testable.
- Healing loop before real providers proves Rector's core claim.
- Observability before live model spend prevents cost blindness.
- Public extension contracts make open-source contributions safe and consistent.
- Retool/admin after core events exist avoids dashboards over unstable data.

## Current Stack Optimization Summary

Use credits to maximize prototype power without making them required for contributors:

- **Together AI + Cloudflare + Azure**: optional model routing pyramid.
- **Perplexity**: optional research-grade external context.
- **Chroma + Algolia**: optional semantic + keyword memory/search.
- **Retool + Make + Linear**: optional operator workflows.
- **PostHog + Sentry + Middleware first; DataDog/New Relic at deploy**: product, errors, LLM, infra observability without early over-instrumentation.
- **Depot + E2B path**: optional fast validation and safe execution.
- **Doppler**: optional secrets for maintainers/deployments.
- **Heroku + Cloudflare**: simplest credible deployment path.

## Deferred Stack

- Bubble: defer unless public demo/landing page is needed.
- Mixpanel/Amplitude: defer while PostHog is primary.
- Confluent/Kafka: defer; Redis/BullMQ is enough.
- AWS: defer until credits are confirmed and a specific service is chosen.
- DeepGram/AssemblyAI: defer until voice/audio is in scope.
- BrowserStack: use once UI stabilizes.

## v0.3.0 Milestone — Configured Product

Kill local mode as default product. Deliverables:

- `docs/architecture/configured-product-architecture.md` as canonical architecture
- UI-persisted `.rector/runtime-settings.json` as source of truth
- Mandatory uncloseable first-run onboarding overlay until readiness passes
- Single orchestration path: `runOrchestratedChatRun` (no fake chat as product)
- `SpyLLMProvider` for CI only; deprecate `ORCHESTRATOR_MODE` env knob
- User docs: `docs/getting-started/first-run-setup.md`

Branch: `rector-0.3.0-configured-product`

## First Chunk to Plan Next

Configured-product transition phases follow `.kiro/specs/cloud-capable-transition/tasks.md` and new chunk plans under `docs/plans/chunks/`.
