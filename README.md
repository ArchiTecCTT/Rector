# Rector — Chat-First Self-Healing AI for Software Engineering

> Open-source Apache-2.0 software that gives users a normal chat experience while hidden deterministic orchestration, validation, and self-healing loops handle the engineering work underneath.

[![Status](https://img.shields.io/badge/status-0.1.0%20planning-blue?style=flat-square)](#)
[![License](https://img.shields.io/badge/license-Apache--2.0-green?style=flat-square)](#)

---

## What Is Rector?

Rector is a chat-first AI engineering system. Users should interact with it like Claude or ChatGPT: open chat, describe the work, watch concise progress, and receive useful output. They should not need to operate model routing, subagents, retries, validation, or repair loops manually.

Most AI coding agents are brilliant but unreliable. They hallucinate APIs, get stuck in infinite loops, and cost a fortune because they use a frontier model for every single step.

Rector solves this by applying a fundamental principle from manufacturing: **separate planning from execution**.

Behind the chat interface, Rector uses:

1. **A deterministic state machine** — the Thalamus Router — that programmatically controls every routing decision
2. **A tiered intelligence pipeline** — cheap SLMs handle the mechanical work; expensive flagship models are reserved strictly for deep reasoning and final synthesis
3. **A self-healing sandbox** — generated code executes in isolated environments; failures are caught, parsed, and routed back for localized fixes before they cascade

The result: a system that thinks before it acts, debates before it executes, and heals itself when things break — at a fraction of the cost of monolithic LLM approaches.

---

## Core Philosophy

### Economic Asymmetry
Use tiny, fast, cheap Small Language Models (SLMs) for 90% of mechanical data processing. Reserve expensive Flagship models strictly for final synthesis and deep reasoning.

### Deterministic Guardrails
LLMs do not orchestrate tasks. A programmatic router manages all routing, retries, and execution loops. The system is auditable, predictable, and free of probabilistic steering.

### Pre-Execution Cognitive Alignment
Before any code is touched, the system forces the plan through a rigorous refinement phase — establishing the "What" and the "Why" so the "How" is grounded in reality.

### Self-Healing Execution
Generated outputs execute in isolated sandboxes. Errors are parsed deterministically and routed back for localized fixes without involving the Flagship layer.

---

## Architecture Overview

```
User Prompt
    │
    ▼
Intake Triage Router ── (trivial) ──► Flash LLM ──► Output
    │
    │ (complex)
    ▼
Phase 1: Schema & Encoding
    ├─ Prompt Improver ── searches repo + memory
    └─ Context Anchor ── asks "why does this matter?"
    │
    ▼
Phase 2: Task Decomposition
    └─ Thalamus Router 1 ── Tree of Thoughts breakdown
    │
    ▼
Phase 3: Metacognitive Monitoring
    ├─ The Skeptic ── evidence-based stress-testing
    └─ The Crucible ── max 2-round debate (deterministic)
    │
    ▼
Phase 4: Compilation + Execution
    ├─ Main Brain ── assigns models, compiles JSON DAG
    └─ Thalamus Engine ── deterministic execution
    │
    ▼
Output / Human Handoff
```

---

## Key Features

- **Multi-phase cognitive pipeline** — Prompt Improver, dual Thalamus Routers, Skeptic red-teaming, Main Brain compiler
- **Deterministic state machine** — every transition is rule-based, not LLM-guessed
- **Evidence-based debate** — plans are stress-tested with read-only tools before execution
- **Self-healing sandbox** — localized error fixes without re-running the full pipeline
- **Tiered model routing** — SLMs for mechanical work, Flagship for synthesis only
- **JSON DAG execution** — the Main Brain outputs a strict execution graph; the engine executes it programmatically

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
node >= 20
npm >= 10

# Install dependencies
npm install

# Build TypeScript
npm run build

# Run in local development mode (no API keys required)
npm run dev

# Open the dashboard
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

## Running Tests

```bash
npm test
```

Tests cover: state transitions, schemas, event bus, repository immutability, happy path, healing loop, abort path, and API controls.

---

## Contributing and Security

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — local setup, chunk workflow, adapter notes, and DCO sign-off.
- [`SECURITY.md`](SECURITY.md) — responsible disclosure and agentic/sandbox safety examples.
- [`TRADEMARKS.md`](TRADEMARKS.md) — Rector name/logo usage policy.
- [`docs/contributing/adapters.md`](docs/contributing/adapters.md) — adapter contribution guide skeleton.

---

## Project Structure

```
src/
  adapters/       # Provider integrations (event bus, LLM, task store)
  api/            # Express API server + REST routes
  domain/         # State machine schemas, transitions, state definitions
  public/         # Frontend assets (HTML, CSS, JS)
  thalamus/       # Thalamus router engine
  workers/        # Agent worker executors
  index.ts        # Entry point
```

---

## Status and Current Plan

Rector 0.1.0 is actively migrating from the old local task-MVP toward the current product direction: an Apache-2.0 open-source, chat-first engineering assistant with hidden deterministic orchestration, validation, and self-healing underneath.

Current source-of-truth docs:

- [`docs/architecture/rector-0.1.0-architecture.md`](docs/architecture/rector-0.1.0-architecture.md) — authoritative architecture and product direction.
- [`docs/plans/rector-master-roadmap.md`](docs/plans/rector-master-roadmap.md) — authoritative roadmap and chunk order.
- [`docs/README.md`](docs/README.md) — docs index explaining current vs. stale documents.

Older local-MVP and cloud-heavy planning docs are preserved for research only and are marked stale/quarantined. If they conflict with the source-of-truth docs above, the source-of-truth docs win.

---
