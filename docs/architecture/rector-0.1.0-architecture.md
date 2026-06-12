# Rector 0.1.0 Architecture (HISTORICAL)

> **STATUS: HISTORICAL — v0.1.0-alpha local prototype vision.**
> This document describes the original lightweight local developer preview / "brainstem" prototype goals.
> **It is no longer the active architecture.**
> 
> See instead:
> - **`docs/architecture/configured-product-architecture.md`** (canonical v0.3.0+ product architecture)
> - `.kiro/specs/cloud-capable-transition/` (active implementation spec)
> - `docs/architecture/current-rector-byok-architecture.md` (stale pre-v0.3.0 BYOK reference)
> - `docs/plans/chunks/033-...` and later for transition work
> - AGENTS.md and docs/README.md (updated vision: non-rigid, pluggable, web-UI configuration for providers including memory DBs like local/Mem0/TiDB Cloud)
>
> **Superseded:** v0.3.0 uses the configured-product model. See `configured-product-architecture.md`.
>
> Original status (kept for reference):
> Status: Reviewed draft v2 for branch `rector-0.1.0`.
> Product target: best achievable prototype now, scalable later.
> Review inputs: GLM product/architecture, implementation/testability, and stack/ops/security reviews on 2026-06-03.

## 1. Product Vision

Rector is a normal chat interface with a hidden self-healing neuro-symbolic execution engine underneath.

The user should experience Rector like Claude or ChatGPT:

1. Open chat.
2. Type a request.
3. Receive useful progress and final output.
4. Never manage model routing, subagents, retries, validation, or repair loops manually.

Internally, Rector routes work through deterministic protocols, small/large model calls, memory retrieval, validation, sandbox execution, and healing loops. When something breaks, Rector diagnoses and repairs automatically when safe, or escalates with a concise human decision request when unsafe.

## 2. Current Repo Reality

The repository now contains the completed provider-free `v0.1.0-alpha` brainstem:

- chat-first Express API and local browser UI
- deterministic orchestration through triage, context building, planning, skeptic review, crucible arbitration, DAG compilation, executor simulation, validation, healing, and synthesis
- local in-memory adapters and provider-free defaults
- generated roadmap issue catalogs and Linear export metadata
- tests covering the alpha contracts and pipeline

The next product migration is from deterministic provider-free alpha to a real BYOK alpha with live model adapters, persistence, streaming progress, and safe workspace execution.

### Migration Principle

Keep the provider-free local mode as the regression baseline while adding live BYOK modes behind explicit configuration flags.

## 3. Product Principles

1. **Chat first, orchestration hidden.** The UI is not an agent dashboard. It is a chat surface with optional expandable trace details.
2. **Deterministic control plane.** LLMs propose. Rector validates, routes, retries, and commits state deterministically.
3. **Self-healing by default.** Validation failure is not terminal. It creates a bounded repair loop.
4. **Evidence over vibes.** Every plan, patch, retrieval, and answer carries evidence pointers: files, tests, commands, sources, traces.
5. **Small models first.** Use SLMs for triage, formatting, extraction, small edits, summarization, and cheap parallel work. Use flagship models only for hard synthesis, architecture, and unresolved conflicts.
6. **Artifact handles, not context dumps.** Large files, logs, repo snapshots, transcripts, and traces become stored artifacts. Models receive handles and focused summaries.
7. **Provider-agnostic from day one.** Credits are used aggressively, but all external systems sit behind adapters.
8. **Scale path without rewrite.** Local/dev mode and production mode share the same contracts.
9. **Budgets are safety controls.** Every run has token, cost, retry, timeout, and provider limits before live calls occur.
10. **Privacy is default.** User messages may contain secrets or PII. Logs, traces, artifacts, and provider calls must use redaction and retention policies.

## 4. Open-Source Strategy

Rector is Apache-2.0 open-source software.

Apache-2.0 is the best fit for Rector because it maximizes adoption, allows commercial and enterprise use, includes an explicit patent grant, and is familiar to infrastructure contributors. Rector's business model should rely on hosted cloud, enterprise support, premium operations, and brand/trademark trust rather than copyleft restrictions.

Tradeoff: Apache-2.0 allows closed commercial forks. Rector should mitigate this with strong execution, community, hosted reliability, trademark policy, and optional enterprise services rather than license friction.

Open-source design requirements:

- Rector must run locally without maintainer-only credits.
- Fake/local providers must be first-class and deterministic.
- Premium providers must be optional adapters.
- Contributor docs must explain architecture, adapter contracts, tests, and safety rules.
- CI must validate protocol contracts and local fake-provider flows.
- Issues must be decomposed into independently grabbable chunks.
- Security policy must explain safe disclosure for agentic execution bugs.

Required community files:

- `LICENSE` with Apache-2.0 text.
- `CONTRIBUTING.md`.
- `SECURITY.md`.
- `CODE_OF_CONDUCT.md`.
- `.github/ISSUE_TEMPLATE/*`.
- `.github/pull_request_template.md`.
- local provider-free quickstart in `README.md`.

## 5. User Experience

### 4.1 Default Chat Flow

```text
User message
  -> Rector acknowledges intent
  -> hidden triage + context retrieval
  -> hidden planning / execution / validation
  -> streamed progress summaries when useful
  -> final answer with optional trace drawer
```

### 4.2 0.1.0 Chat UI Requirements

0.1.0 must include a minimal but real chat experience:

- conversation list or single default conversation
- message composer
- streamed or polling assistant response
- status pill: `Thinking`, `Planning`, `Executing`, `Validating`, `Repairing`, `Done`, `Needs decision`, `Failed`
- optional trace drawer/API with:
  - plan summary
  - phase transitions
  - model/provider calls, if enabled
  - validation checks
  - repair attempts
  - estimated cost/latency

### 4.3 Human Decision Flow

`NEEDS_DECISION` is a first-class flow, not an error.

Rector enters `NEEDS_DECISION` when:

- user intent is ambiguous and changes execution semantics
- budget cap would be exceeded
- retry/healing cap is reached
- external side effect needs approval
- risky file write or destructive command is requested
- secret/credential is missing

The user sees a concise decision card:

- what Rector tried
- why it stopped
- options
- recommended option
- consequences

## 6. Unified Run Phases

All docs and implementation plans must use this phase enum.

```text
CHAT_RECEIVED
TRIAGE
CONTEXT_BUILDING
PLANNING
SKEPTIC_REVIEW
CRUCIBLE
DAG_COMPILATION
EXECUTING
VALIDATING
HEALING
SYNTHESIZING
DONE
NEEDS_DECISION
FAILED
ABORTED
```

Status labels are user-facing summaries derived from phases. They are not separate state-machine values.

## 7. Cognitive Pipeline

Rector 0.1.0 should implement one complete vertical slice of the final brain:

```text
CHAT_RECEIVED
  -> TRIAGE
  -> CONTEXT_BUILDING
  -> PLANNING
  -> SKEPTIC_REVIEW
  -> CRUCIBLE
  -> DAG_COMPILATION
  -> EXECUTING
  -> VALIDATING
  -> HEALING when validation fails and repair is safe
  -> VALIDATING after repair
  -> SYNTHESIZING
  -> DONE or NEEDS_DECISION or FAILED
```

### 6.1 TRIAGE

Classifies complexity and route:

- `DIRECT_ANSWER`
- `PLAN_ONLY`
- `CODE_EDIT`
- `RESEARCH`
- `LONG_RUNNING`
- `NEEDS_CLARIFICATION`

Triage starts with deterministic heuristics and can call a cheap SLM only when needed.

### 6.2 CONTEXT_BUILDING

Builds a compact context pack:

- user intent
- conversation history summary
- repo state
- relevant docs
- memory hits
- constraints
- available tools/providers
- risk flags
- artifact handles

### 6.3 PLANNING

Creates a structured plan:

- goal
- assumptions
- tasks
- dependencies
- expected artifacts
- validation checks
- risk level
- human approval gates

### 6.4 SKEPTIC_REVIEW

Adversarial read-only reviewer. Checks whether the plan assumes non-existent files/APIs, skips validation, violates constraints, or underestimates risk.

### 6.5 CRUCIBLE

Deterministic debate arbiter. It does not invent content. It checks whether Skeptic findings were answered, accepted, or need escalation.

0.1.0 deterministic rules:

- If no `BLOCKER` or `MAJOR` findings exist, accept plan.
- If planner accepts a finding and revises all impacted tasks, accept revised plan.
- If planner rejects a finding without evidence, escalate to `NEEDS_DECISION` or `FAILED` depending on risk.
- If any `BLOCKER` remains unresolved after two rounds, stop execution.
- Max debate rounds: 2.

### 6.6 DAG_COMPILATION

Converts accepted plan into a JSON DAG:

- nodes
- dependencies
- provider assignments
- tool permissions
- retry policy
- timeout
- expected outputs
- validation nodes

### 6.7 EXECUTING

Runs the DAG through adapters:

- fake/local LLM provider initially
- safe local commands only in early chunks
- real providers only behind budget and env gates

### 6.8 VALIDATING

Runs deterministic checks:

- schema validation
- unit tests
- type checks
- lint/build
- output contract checks
- user-flow smoke tests when available

### 6.9 HEALING

On failure:

1. classify failure
2. retrieve relevant evidence
3. propose minimal repair
4. execute repair if safe
5. rerun validator
6. cap retries
7. escalate if unresolved

0.1.0 healing limits:

- default max repair attempts per run: 1
- hard max repair attempts per run: 3
- default max validation reruns per node: 2
- healing cannot bypass budget, permission, or approval gates

### 6.10 SYNTHESIZING

Creates the final chat response:

- answer/result
- what changed
- evidence
- validation status
- unresolved risks
- next suggested action

## 8. Core Domains and Modules

Target TypeScript layout after migration:

```text
src/
  app/                         # app bootstrap
  chat/                        # conversation/message domain
  core/                        # IDs, time, result, errors, redaction
  protocol/                    # phases, envelope, DAG, events, schemas
  orchestration/               # run state machine + cognitive modules
  providers/                   # provider interfaces
  adapters/                    # local + external provider implementations
  api/                         # HTTP routes and streams
  ui/                          # chat frontend assets or future app
  tests/                       # test helpers if kept under src later
```

Migration will be incremental. Existing folders can remain until replaced, but new code must depend on protocol/chat/run interfaces rather than old task-specific types.

## 9. Data Model

### 8.1 Conversation

- `id`
- `title`
- `workspaceId`
- `createdAt`
- `updatedAt`
- `retentionPolicy`

### 8.2 Message

- `id`
- `conversationId`
- `role`
- `content`
- `status`
- `runId?`
- `redactionState`
- `createdAt`

### 8.3 Run

- `id`
- `conversationId`
- `userMessageId`
- `status`
- `phase`
- `route`
- `complexity`
- `budget`
- `costEstimate`
- `actualCost?`
- `tokenEstimate`
- `actualTokens?`
- `traceId`
- `dagId?`
- `attempts`
- `healingAttempts`
- `validationAttempts`
- `lastError?`
- `decisionRequest?`
- `createdAt`
- `updatedAt`

### 8.4 Budget

- `maxUsd`
- `maxInputTokens`
- `maxOutputTokens`
- `maxModelCalls`
- `maxRuntimeMs`
- `maxHealingAttempts`
- `allowedProviders`
- `approvalRequiredAboveUsd`

### 8.5 Artifact

- `id`
- `kind`
- `uri`
- `summary`
- `hash`
- `sizeBytes`
- `piiState`
- `retentionPolicy`
- `metadata`
- `createdAt`

### 8.6 Event

- `id`
- `runId`
- `type`
- `phase`
- `payload`
- `traceId`
- `redactionState`
- `createdAt`

### 8.7 DAG

- `id`
- `runId`
- `version`
- `nodes[]`
- `edges[]`
- `validationPolicy`
- `budgetPolicy`
- `createdAt`

## 10. Stack Strategy

### 9.1 Prototype Stack

Use credits to build a serious prototype without committing to expensive permanent dependencies.

| Layer | Prototype choice | Why |
|---|---|---|
| Chat frontend | simple custom chat first; Retool for operator console | avoids Retool-shaped user UX |
| Internal operator UI | Retool | fast run/failure/approval console |
| API/backend | Node/TypeScript on Heroku first | matches repo and simplest deploy |
| Queue/workflows | in-process executor first, then BullMQ + Redis | avoid Redis dependency before DAG contracts stabilize |
| State DB | local adapter first, MongoDB adapter after run model stabilizes | credits useful, but avoid early lock-in |
| Memory | Chroma dev/prototype | credits exist; easy semantic memory |
| Search | Algolia after artifacts/messages exist | useful for UX and operator search |
| SLM provider | Together AI first, Cloudflare Workers AI second | credits + model breadth |
| Flagship | Azure OpenAI | deep reasoning budget |
| Research | Perplexity Enterprise Pro | cited external research mode |
| Sandbox | local safe executor first, E2B later, Depot for builds/CI | safe incremental path |
| Observability | Sentry + PostHog first; Middleware for LLM spans; DataDog/New Relic at deploy | avoid over-instrumentation early |
| Issue/project | Linear | human escalation |
| CI/build | GitHub Actions + CodeCov + CodeScene; Depot later | quality gates |
| Secrets | `.env` local + Doppler when real providers start | simple now, scalable later |

### 9.2 Deferred or Secondary Credits

- Bubble: defer unless a public landing/demo needs no-code speed.
- Mixpanel/Amplitude: defer while PostHog is primary product analytics.
- Confluent/Kafka: defer; BullMQ/Redis is right-sized.
- AWS: defer until credits confirmed and specific use appears.
- DeepGram/AssemblyAI: defer until voice/audio enters scope.
- BrowserStack: use after UI becomes stable.
- Requestly: use for API mocking/debugging later.

## 11. Security, Privacy, and Operations Baseline

0.1.0 must include basic guardrails even as a prototype:

- no secrets in logs, traces, artifacts, or UI
- redaction utility for event payloads
- CORS allowlist config
- basic rate limiting for chat endpoints when publicly exposed
- local dev auth bypass only when `NODE_ENV=development`
- provider calls disabled unless env flag and budget allow them
- setup checklist must not reveal secret values
- MongoDB/Redis URIs documented as secret refs, not inline credentials
- graceful shutdown for server and workers before deployment chunk

## 12. 0.1.0 Prototype Definition

0.1.0 proves the full hidden architecture through one vertical slice:

```text
A user sends a request in chat.
Rector triages it, builds context, plans, skeptically reviews, compiles a small DAG, executes work through local/fake adapters, validates result, auto-repairs one failure, and returns a polished chat answer with evidence.
```

### 11.1 Required 0.1.0 Capabilities

- Chat API and basic chat UI.
- Conversation and message persistence via local adapter.
- Run state machine and append-only events.
- Budget schema and enforcement with fake/local costs.
- Triage route selection.
- Context pack generation.
- Structured planner output.
- Skeptic review pass.
- Crucible deterministic decision rules.
- DAG schema and validation.
- DAG executor with limited node types.
- Fake/local model provider.
- Validation node support.
- Healing loop with bounded retry.
- Event stream or polling to UI.
- Trace summary.
- Tests for protocol, state, DAG, healing, chat API.

### 11.2 Explicit 0.1.0 Non-Goals

- Full autonomous repo editing across arbitrary projects.
- Multi-user auth/teams billing.
- Mobile app.
- Voice interface.
- Full Retool production console.
- All provider integrations live at once.
- Full swarm execution.
- Marketplace/plugins.
- Production-grade E2B sandbox policy.
- LangGraph parity.
- Kafka/Confluent production deployment.

## 13. Scaling Path

### 12.1 0.1.x: Brainstem

- Stable protocol.
- Reliable run state machine.
- Chat UX.
- One repair loop.
- Strong tests.

### 12.2 0.2.x: Real Providers

- Together/Cloudflare/Azure real LLM routing.
- Chroma memory.
- MongoDB persistence.
- PostHog/Sentry/Middleware tracing.
- Retool operator console.

### 12.3 0.3.x: Safe Code Execution

- E2B sandbox.
- Depot builds.
- repo checkout/indexing.
- patch validation.
- human approval gates.

### 12.4 0.4.x: Learning and Memory

- Library of Truth.
- episodic/semantic/procedural memory split.
- agent reputation.
- run outcome learning.

### 12.5 0.5.x: Production Alpha

- auth/workspaces.
- quotas/budgets.
- Linear integration.
- advanced observability.
- deployment hardening.

## 14. Inspiration Imported from Astra

Adopt:

- deterministic semantic router
- 4-tier routing idea
- BYOK/provider abstraction
- confidence-gated JSON output
- indexed logs and trace IDs
- budget guardrails
- truth library
- skeptic/anti-sycophancy layer
- agent permission matrix
- artifact handle pattern
- baseline contract tests

Avoid:

- roadmap bloat before vertical slice
- LangGraph parity wrapper too early
- MCP adapter before core runtime hardening
- too many cognitive modules in 0.1.0
- UI/dashboard complexity before chat loop works

## 15. Architecture Decision

Rector 0.1.0 is **not** a cloud dashboard MVP and **not** a local toy simulator.

It is a **chat-first vertical slice of the final self-healing orchestration brain**, implemented with final protocol boundaries and fake/local adapters where needed.

This gives the best prototype now and the lowest rewrite risk later.
