# Rector — Chat-First Self-Healing AI for Software Engineering

> Open-source Apache-2.0 software that gives users a normal, **hassle-free** chat experience. Configure providers, memory databases (local, Mem0, TiDB Cloud, etc.), sandbox, and more entirely through the web UI — no file or environment editing required for normal use. Hidden deterministic orchestration, validation, and self-healing loops handle the engineering work underneath. Local mode remains a perfect regression baseline.

[![Status](https://img.shields.io/badge/status-cloud--capable--transition-blue?style=flat-square)](#)
[![License](https://img.shields.io/badge/license-Apache--2.0-green?style=flat-square)](#)

---

## What Is Rector?

Rector is a chat-first AI engineering system designed to be usable daily on a VPS or cloud. Users interact with it like Claude or ChatGPT: open chat, describe the work, watch concise progress, and receive useful output. The app is configurable via the web UI for LLM providers, memory backends (pluggable: local in-memory/SQLite, Mem0, TiDB Cloud, and others), sandbox execution, telemetry, etc. Users should not need to operate model routing, subagents, retries, validation, or repair loops manually, nor edit config files.

Most AI coding agents are brilliant but unreliable. They hallucinate APIs, get stuck in infinite loops, and cost a fortune because they use a frontier model for every single step.

Rector solves this by applying a fundamental principle from manufacturing: **separate planning from execution**, combined with a non-rigid, pluggable architecture for real usability.

Behind the chat interface, Rector uses:

1. **A deterministic control plane** — a run state machine that programmatically drives every phase transition, retry, and healing decision, so routing is auditable rather than LLM-guessed
2. **A tiered intelligence pipeline** — cheap SLMs for mechanical work (including preprocessing and reflection); flagship models reserved for deep reasoning and synthesis. Routing and backends (including memory) are configurable via UI.
3. **A bounded self-healing loop** — generated work is validated, and recoverable failures trigger a capped, deterministic repair loop before they cascade
4. **Neuro-symbolic enhancements** (memory with notes/pruning/time-awareness, proactive "alive" behavior, symbolic rules, optional deep exploration, pondering, decomposition) to make the system remember context, reflect, and feel alive for long-running coding work.

The result: a system that thinks before it acts, debates before it executes, heals itself when things break, and can be configured hassle-free for your environment — at a fraction of the cost of monolithic LLM approaches.

> **Current direction:** Cloud-capable transition toward a usable VPS/cloud product. The full pipeline supports external BYOK providers, durable storage options, and real sandbox execution behind adapters. Local/provider-free mode is always available as an identical regression baseline (no keys or network required for tests and safe development). See the active spec in `.kiro/specs/cloud-capable-transition/` and [Status and Current Plan](#status-and-current-plan).

---

## Core Philosophy

### Economic Asymmetry
Use tiny, fast, cheap Small Language Models (SLMs) for 90% of mechanical data processing. Reserve expensive Flagship models strictly for final synthesis and deep reasoning.

### Deterministic Guardrails
LLMs do not orchestrate tasks. A programmatic router manages all routing, retries, and execution loops. The system is auditable, predictable, and free of probabilistic steering.

### Pre-Execution Cognitive Alignment
Before any code is touched, the system forces the plan through a rigorous refinement phase — establishing the "What" and the "Why" so the "How" is grounded in reality.

### Self-Healing Execution
Validation failure is not terminal. Recoverable errors are classified and routed into a bounded, deterministic repair loop without involving the Flagship layer. Unsafe or unrecoverable cases escalate to a concise human decision. (Real isolated sandbox execution is contract-defined but deferred past the alpha — see the roadmap.)

---

## Architecture Overview

Rector runs every chat request through a deterministic sequence of run phases. The control plane drives the transitions; models (when enabled) only propose content at specific steps.

```text
User message
    │
    ▼
CHAT_RECEIVED ──► TRIAGE ──► CONTEXT_BUILDING
    │                              │
    │   (classify route +          │  (compact context pack:
    │    complexity)               │   intent, repo state, docs,
    │                              │   memory hits, risk flags)
    ▼                              ▼
PLANNING ──► SKEPTIC_REVIEW ──► CRUCIBLE
    │         (adversarial         │  (deterministic arbiter,
    │          read-only review)   │   max 2 rounds)
    ▼                              ▼
DAG_COMPILATION ──► EXECUTING ──► VALIDATING
                                   │
                        ┌──────────┴───────────┐
                        │ pass                  │ fail (and safe)
                        ▼                       ▼
                  SYNTHESIZING            HEALING ──► VALIDATING
                        │                  (bounded repair loop)
                        ▼
        DONE  /  NEEDS_DECISION  /  FAILED
```

`NEEDS_DECISION` is a first-class outcome (ambiguous intent, budget cap, retry cap, risky side effect, or missing credential), not an error. The canonical phase enum and the rationale for each stage live in [`docs/architecture/rector-0.1.0-architecture.md`](docs/architecture/rector-0.1.0-architecture.md).

---

## Key Features

- **Multi-phase cognitive pipeline** — triage, context building, planner, skeptic review, crucible arbitration, DAG compilation, execution, validation/healing, and synthesis
- **Deterministic control plane** — every phase transition is rule-based, committed through a run state machine with an append-only event log
- **Evidence-based debate** — plans are stress-tested by an adversarial skeptic, then arbitrated by a deterministic crucible (max two rounds)
- **Bounded self-healing** — recoverable validation failures trigger a capped repair loop; unsafe cases escalate to a human decision
- **Tiered model routing** — provider adapters route SLM vs. flagship work behind budget gates (alpha runs on fake/local providers, no keys required)
- **JSON DAG execution** — the planner output compiles into a strict execution graph that the executor runs programmatically

---

## Tech Stack

| Layer | Technology |
|---|---|
| **SLM Assembly Line** | Cloudflare Workers AI, Groq |
| **Flagship Layer** | Azure OpenAI (GPT-5.x) |
| **Event Bus / State** | BullMQ + Redis Streams |
| **Vector Memory** | Chroma |
| **Code Sandbox** | E2B, Depot |
| **Observability** | Middleware.io, DataDog, Sentry, PostHog |
| **Frontend** | Bubble.io |

*Note: The listed providers above represent the target production integration and adapter landscape. For local development and testing, Rector runs entirely using built-in, in-memory fake adapters, requiring no external provider API keys or active accounts.*

---

## Quick Start

```bash
# Prerequisites
node >= 22.5.0
npm >= 10

# Install dependencies
npm install

# Build TypeScript
npm run build

# Run in local development mode (no API keys required)
npm run dev

# Open the local chat UI
open http://localhost:3000
```

Local mode runs with in-memory adapters. Set real provider credentials in `.env` to activate live integrations.

For a provider-free setup path, see [`docs/getting-started/provider-free-quickstart.md`](docs/getting-started/provider-free-quickstart.md).

---

## Environment Setup

Copy `.env.example` to `.env` and configure the providers you want to activate:

```bash
cp .env.example .env
```

Key variables:

| Variable | Purpose |
|---|---|
| `NODE_ENV` | `development` for local mode, `production` for live providers |
| `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` | Cloudflare Workers AI (SLM layer) |
| `AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_API_KEY` | Azure OpenAI (Flagship layer) |
| `REDIS_URL` | Redis connection (for BullMQ + event bus) |
| `CHROMA_URL` | Chroma vector database |
| `TOGETHER_API_KEY` | Together AI (model fine-tuning — pending) |

For full variable documentation, see [`.env.example`](.env.example).

---

## CI / Verification Gates

Run the same gates locally that CI enforces on every push and pull request:

```bash
npm test        # vitest run
npm run build   # tsc + dist ESM import fixups
npm run check   # tsc --noEmit type check
node scripts/generate-roadmap-issues.js --check   # issue-catalog drift check
```

Tests cover: state transitions, schemas, event bus, repository immutability, happy path, healing loop, abort path, and API controls.

Continuous integration runs in GitHub Actions via [`.github/workflows/ci.yml`](.github/workflows/ci.yml):

- The four gates above run on a Node version matrix (Node 22 and Node 24).
- Dependencies install deterministically with `npm ci`; the run is provider-free and requires no secrets or API keys.
- `npm audit` runs as a **non-blocking** step. It surfaces the deferred Vitest/Vite dev-tooling advisories without failing the build, pending a maintainer-approved upgrade.
- The workflow performs no release side effects (no publish, tag, or push). Release tagging stays a manual, maintainer-gated action.

---

## Contributing and Security

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — local setup, chunk workflow, adapter notes, and DCO sign-off.
- [`SECURITY.md`](SECURITY.md) — responsible disclosure and agentic/sandbox safety examples.
- [`TRADEMARKS.md`](TRADEMARKS.md) — Rector name/logo usage policy.
- [`docs/contributing/adapters.md`](docs/contributing/adapters.md) — adapter contribution guide skeleton.
- [`docs/extensions/public-contracts.md`](docs/extensions/public-contracts.md) — alpha extension manifest, compatibility, and typed contracts.

---

## Project Structure

```text
src/
  orchestration/   # run state machine + cognitive modules (triage, contextBuilder,
                   #   planner, skeptic, crucible, dagCompiler, executorSimulator,
                   #   validationHealing, synthesizer)
  protocol/        # canonical phases, envelope, DAG, event, and shared schemas
  store/           # in-memory Rector store + store schemas (atomic run/event commit)
  api/             # Express API server (chat, runs, operator, setup endpoints)
  public/          # local chat UI assets (HTML, CSS, JS)
  providers/       # LLM provider contracts + model router (fake/local by default)
  memory/          # local truth library + memory adapters (Chroma/Algolia stubs)
  observability/   # trace IDs, spans, phase timing, no-op telemetry adapters
  security/        # budget evaluator + redaction utilities
  sandbox/         # safe local code-execution contracts (no real isolation yet)
  extensions/      # public extension contracts (rector.extensions.v1alpha1)
  workflows/       # external workflow contracts/stubs (Linear, Make, etc.)
  deployment/      # deployment env parsing, config redaction, readiness report
  bin/server.ts    # runtime bootstrap (keeps src/index.ts side-effect free)
  index.ts         # package entry point
```

> Migration note: some older local-MVP folders (`adapters/`, `domain/`, `thalamus/`,
> `workers/`) remain in `src/` and are being retired incrementally as the chat/run
> architecture replaces them. New code depends on the `protocol/`, `orchestration/`,
> and `store/` interfaces, not the old task-specific types.

---

## Status and Current Plan

Rector 0.1.0 is actively migrating from the old local task-MVP toward the current product direction: an Apache-2.0 open-source, chat-first engineering assistant with hidden deterministic orchestration, validation, and self-healing underneath.

Current source-of-truth docs:

- [`docs/architecture/rector-0.1.0-architecture.md`](docs/architecture/rector-0.1.0-architecture.md) — authoritative architecture and product direction.
- [`docs/plans/rector-master-roadmap.md`](docs/plans/rector-master-roadmap.md) — authoritative roadmap and chunk order.
- [`docs/README.md`](docs/README.md) — docs index explaining current vs. stale documents.

Older local-MVP and cloud-heavy planning docs are preserved for research only and are marked stale/quarantined. If they conflict with the source-of-truth docs above, the source-of-truth docs win.

---
