# Phase 5: The Control Center (Frontend UI)

Developers need a visual dashboard to observe the assembly line, intervene if an agent gets stuck, and monitor system health.

## Objective
Build a real-time, visual control center for the multi-agent system using rapid no-code/low-code tools.

## Tech Stack
*   **Bubble.io:** Frontend application builder. ($2500 credits)
*   **Make (Integromat):** Webhook orchestration and third-party glue. (Teams Plan + 240k credits)
*   **Requestly:** API mocking and debugging. (Professional Plan)
*   **Retool:** (Optional alternative/backup for internal admin dashboards).

## Step-by-Step Implementation

### Step 5.1: API Gateway (Backend to Frontend)
1.  Expose an Express.js or FastAPI REST layer on the Thalamus Router instance.
2.  Create endpoints:
    *   `GET /tasks` (List all active tasks and their state)
    *   `GET /tasks/:id` (Get the full JSON state machine document)
    *   `POST /tasks/:id/retry` (Manually trigger a Kafka retry event)
    *   `POST /tasks/:id/approve` (Human approval gate)

### Step 5.2: Build the Bubble.io Dashboard
1.  Connect Bubble's API Connector to the Thalamus API Gateway.
2.  **Build the Kanban Board:** Show tasks moving horizontally through columns: `Ingest` -> `Planning` -> `SLM Execution` -> `Validation` -> `Review`.
3.  **Build the Node Inspector:** When a user clicks a task in `SLM Execution`, open a modal showing the `sub_tasks` array. Visually indicate which SLMs are `PENDING`, `RUNNING`, `FAILED` (Healing Loop), or `COMPLETED`.
4.  **Action Buttons:** Add buttons to manually pause, abort, or retry specific sub-tasks via the API Gateway.

### Step 5.3: Webhook Orchestration with Make.com
1.  For actions that don't need to hit the custom API directly, use Make.com.
2.  Example: If a task requires human approval after `FINAL_SYNTHESIS`, the Thalamus router can hit a Make webhook. Make sends a Slack/Discord message with the PR link and "Approve/Reject" buttons.
3.  Make captures the button click and pushes the approval event back to the Thalamus Router.

### Step 5.4: Frontend Testing
1.  Use **Requestly** to intercept Bubble.io API calls during development.
2.  Mock various JSON State Machine payloads (e.g., simulating a massive SLM failure or an infinite healing loop) to ensure the Bubble UI renders states correctly without needing to burn actual LLM tokens during UI development.
