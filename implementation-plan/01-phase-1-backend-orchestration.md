> [!WARNING]
> STALE / QUARANTINED DOC: This cloud-heavy implementation-plan document is preserved for historical research only.
> Do not use it as the active implementation plan for Rector 0.1.0.
> Current source of truth: `docs/architecture/rector-0.1.0-architecture.md` and `docs/plans/rector-master-roadmap.md`.

# Phase 1: Backend Orchestration & The Nervous System

This phase establishes the foundational deterministic backend. We must build the Thalamus Router, event bus, and state machine before any AI is connected.

## Objective
Establish a non-blocking, event-driven architecture that manages the state of all tasks without relying on LLMs for control flow.

## Tech Stack
*   **Confluent Cloud (Kafka):** Message broker for asynchronous agent communication. ($1000 credits)
*   **MongoDB:** NoSQL database to persist the JSON State Machine documents. ($3.6k credits)
*   **Doppler:** Centralized secret management. (3 months free)
*   **Heroku / DigitalOcean Hatch:** Hosting for the Thalamus Router and worker nodes.

## Step-by-Step Implementation

### Step 1.1: Secret & Environment Management Setup
1.  Create a **Doppler** workspace.
2.  Set up environments: `development`, `staging`, `production`.
3.  Inject all provider API keys (Together AI, Azure, Perplexity, Linear, Sentry, etc.) into Doppler.
4.  Configure local development to use the Doppler CLI (`doppler run -- npm run dev`).

### Step 1.2: Infrastructure Provisioning
1.  **MongoDB Setup:**
    *   Create a MongoDB Atlas cluster.
    *   Create a database named `rector_core`.
    *   Create collections: `tasks`, `agent_logs`, `context_snapshots`.
    *   Create indexes on `task_id` and `status`.
2.  **Confluent Kafka Setup:**
    *   Create a cluster in Confluent Cloud.
    *   Create the following topics with multiple partitions (for parallel agent processing):
        *   `rector.tasks.ingest`
        *   `rector.tasks.state_change`
        *   `rector.agents.slm.request`
        *   `rector.agents.slm.response`
        *   `rector.agents.flagship.request`
        *   `rector.agents.flagship.response`
        *   `rector.sandbox.validation`
        *   `rector.sandbox.result`

### Step 1.3: Build the Thalamus Router Engine
1.  Initialize a Node.js (TypeScript) project.
2.  Install dependencies: `kafkajs`, `mongodb`, `zod` (for schema validation).
3.  **Implement the Task Manager:**
    *   Create a Kafka consumer listening to `rector.tasks.ingest`.
    *   When a payload arrives (e.g., from a Linear ticket), insert a new document into MongoDB using the strict JSON State Machine schema.
    *   Set the initial status to `1_INTAKE`.
4.  **Implement the State Transition Engine:**
    *   This is a pure deterministic loop. It listens to `rector.tasks.state_change`.
    *   It pulls the document from MongoDB, updates the state block, and emits an event to the next required queue.
    *   *Example:* If state updates to `3_SLM_EXECUTION_FANOUT`, the Thalamus Router reads the generated `sub_tasks` array and emits individual events to `rector.agents.slm.request`.

### Step 1.4: Deployment
1.  Containerize the Node.js application using Docker.
2.  Deploy the Thalamus Router to **Heroku** (using the $13/month plan) or **DigitalOcean** (using Hatch credits).
3.  Ensure the deployment pulls environment variables directly from Doppler at runtime.
