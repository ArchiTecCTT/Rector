# Rector: Step-by-Step Implementation Blueprint

This document outlines the exact sequence of implementation chunks to build Rector, a neuro-symbolic multi-agent orchestration framework.

## Phase 1: The Nervous System (Event Bus & State Machine)
**Goal:** Establish the deterministic backend infrastructure that controls task states without relying on LLMs for control flow.
**Tech Stack:** Confluent (Kafka), MongoDB, Doppler, Heroku/DigitalOcean (Worker nodes)

*   **Step 1.1: Secrets & Infrastructure Provisioning**
    *   Set up **Doppler** to manage API keys (Together AI, Azure, Confluent, etc.) across environments.
    *   Provision **MongoDB** (database for persisting the JSON State Machine).
    *   Provision **Confluent Cloud** (Kafka) and create core topics:
        *   `rector.tasks.ingest` (New tasks from Linear/User)
        *   `rector.tasks.state_change` (Transitions in the state machine)
        *   `rector.agents.slm.request` / `rector.agents.slm.response`
        *   `rector.agents.flagship.request` / `rector.agents.flagship.response`
        *   `rector.sandbox.validation` / `rector.sandbox.result`
*   **Step 1.2: Build the Thalamus Router Engine**
    *   Deploy a Node.js or Python service on **Heroku** or **DigitalOcean Hatch**.
    *   Implement the `TaskManager` class: Listens to `rector.tasks.ingest`, generates a `TaskID`, and creates the initial JSON State Machine document in MongoDB.
    *   Implement the State Transition Logic: A pure functional loop that reads a MongoDB document, determines the next required action (e.g., `1_INTAKE` -> `2_ARCHITECTURAL_PLAN`), and emits an event to the appropriate Kafka topic.

## Phase 2: The Deterministic Sandbox (Execution & Validation)
**Goal:** Build the programmatic guardrails that validate AI code before it goes to the flagship model or the user.
**Tech Stack:** Depot, CodeCov, Codescene, Sentry

*   **Step 2.1: Ephemeral Sandbox Setup**
    *   Integrate the **Depot** CLI/SDK into a dedicated Kafka consumer worker (`sandbox-worker`).
    *   Create base Dockerfiles for supported languages (e.g., Node.js 20, Python 3.11) pre-loaded with Vitest, PyTest, eslint, etc.
*   **Step 2.2: AST Injection & Test Execution**
    *   When the `sandbox-worker` receives a `rector.sandbox.validation` event containing code, it writes the code to a virtual volume.
    *   Trigger Depot to build/run the test suite against that volume.
    *   Capture stdout/stderr.
*   **Step 2.3: The Healing Loop Routing**
    *   If tests/lint pass: Push code to **Codescene** for anti-pattern checks and **CodeCov** for coverage. Emit `SUCCESS` to Kafka.
    *   If tests fail: Parse the stack trace. Send the localized error and the AST snippet to **Sentry** (for tracking). Emit a `FAILED` event to Kafka with the exact error payload, triggering the Thalamus Router to transition to `5_HEALING_LOOP`.

## Phase 3: The Assembly Line (SLMs & Prompt Caching)
**Goal:** Implement the low-cost, high-speed micro-agents using Together AI.
**Tech Stack:** Together AI, Chroma, Perplexity

*   **Step 3.1: Vector Memory & Context Ingestion**
    *   Setup **Chroma**. Implement a worker that syncs GitHub repositories, chunks the code, and generates embeddings.
    *   Create the Intake Agent (SLM): Listens for task ingestion, queries Chroma, and distills the codebase into a dense markdown context file.
*   **Step 3.2: Configure Prefix Caching on Together AI**
    *   Define strict, immutable Prompt Prefixes for specific agent roles (e.g., `ROLE_QA_ENGINEER`, `ROLE_TRIAGE`).
    *   Format payload strictly: `[Immutable System Prompt] + [Immutable Tool JSON Schemas] + [Dynamic User Input]`.
    *   Integrate with **Together AI's** API using the $15K credits, utilizing models like `Qwen 2.5 Coder 7B` or `Llama 3.1 8B`.
*   **Step 3.3: SLM Worker Fan-Out**
    *   Build the Kafka consumers for `rector.agents.slm.request`.
    *   When Thalamus requests multiple files to be edited, the router emits N events. N SLM workers pick these up and process them concurrently.

## Phase 4: The Prefrontal Cortex (Flagship Layer)
**Goal:** Integrate the elite reasoning models for architecture and final review.
**Tech Stack:** Azure (GPT-4o), AWS (Claude 3.5), Linear

*   **Step 4.1: Flagship Worker Implementation**
    *   Create a worker listening to `rector.agents.flagship.request`.
    *   Connect to **Azure OpenAI** or **AWS Bedrock**.
*   **Step 4.2: Architectural Planning**
    *   Implement the prompt logic that accepts the distilled context from the Intake Agent and outputs a strict JSON array of sub-tasks for the SLMs.
*   **Step 4.3: Linear Integration**
    *   Set up webhooks from **Linear**. When an issue is tagged `Rector`, trigger the `rector.tasks.ingest` Kafka topic.
    *   Flagship model updates the Linear issue with PR links upon final synthesis.

## Phase 5: The Control Center (Frontend UI)
**Goal:** Create the user interface for developers to oversee the assembly line.
**Tech Stack:** Bubble.io, Make, Requestly

*   **Step 5.1: API Gateway**
    *   Expose a REST/GraphQL API from the Thalamus Router (Heroku) to query MongoDB task states.
*   **Step 5.2: Bubble.io Dashboard Construction**
    *   Use **Bubble** to build the UI:
        *   **Task Board:** Grid showing tasks moving through states (Intake -> SLM Fanout -> Validation -> Done).
        *   **Node Graph:** Visual representation of SLMs currently executing in parallel.
        *   **Cost Metrics:** Real-time token cost and KV-cache hit rate display.
*   **Step 5.3: Webhooks & Automations**
    *   Use **Make.com** to connect Bubble.io actions (e.g., "Approve PR", "Retry Task") back to the Kafka ingestion topics via webhooks.
    *   Use **Requestly** during frontend testing to mock API responses and test Bubble.io state changes without hitting the real backend.

## Phase 6: Telemetry & Observability
**Goal:** Track costs, performance, and errors.
**Tech Stack:** PostHog, DataDog, New Relic, Amplitude

*   **Step 6.1: Cost & Analytics Tracking**
    *   Embed **PostHog** and **Amplitude** in the Bubble.io frontend to track developer engagement and feature usage.
    *   In the Thalamus Router, after every LLM call, calculate the token cost and push an event to **PostHog** (e.g., `event: agent_invocation`, `properties: { model, cost, cache_hit_rate }`).
*   **Step 6.2: Backend APM**
    *   Deploy **DataDog** agents on the Heroku/DigitalOcean workers to monitor Kafka lag, memory usage, and execution latency.
    *   Use **New Relic** as a fallback or for specific trace analysis through the Node.js/Python stack.
