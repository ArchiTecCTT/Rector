# Rector — Autonomous AI for Software Engineering

> A neuro-symbolic multi-agent orchestration framework that routes AI tasks through a deterministic assembly line — slashing LLM costs by 90% while eliminating hallucinations and infinite loops.

[![Status](https://img.shields.io/badge/status-stealth-blue?style=flat-square)](#)
[![License](https://img.shields.io/badge/license-Proprietary-red?style=flat-square)](#)

---

## What Is Rector?

Most AI coding agents are brilliant but unreliable. They hallucinate APIs, get stuck in infinite loops, and cost a fortune because they use a frontier model for every single step.

Rector solves this by applying a fundamental principle from manufacturing: **separate planning from execution**.

Instead of letting a massive LLM steer the entire process, Rector uses:

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

## Status

Rector is actively under development. The cognitive architecture, protocol design, and infrastructure plan are in place. Implementation of the cognitive pipeline is underway.

See [`docs/`](docs/) for full architectural documentation, implementation plans, and research artifacts.

---