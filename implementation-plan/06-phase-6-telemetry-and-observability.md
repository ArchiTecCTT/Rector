# Phase 6: Telemetry, Observability & APM

To prove the economic asymmetry of Rector, we must rigorously track every token spent and monitor the performance of the distributed agents.

## Objective
Implement comprehensive tracking to visualize the cost savings of the SLM triage layer vs. Flagship models, and monitor backend health.

## Tech Stack
*   **DataDog:** APM, server metrics, and Kafka monitoring. (Pro Account, 10 servers)
*   **PostHog:** Product analytics and custom event tracking (Costs/Tokens). ($50K credits)
*   **Amplitude:** User behavioral analytics. (Scholarship plan)
*   **New Relic:** Fallback APM/Tracing. (Free $300/month tier)

## Step-by-Step Implementation

### Step 6.1: Cost & Token Telemetry (PostHog)
1.  Initialize the **PostHog** Node.js SDK inside the Thalamus Router and all agent workers.
2.  After *every* call to Together AI, Azure, or Perplexity, emit an event to PostHog:
    ```javascript
    posthog.capture({
        event: 'llm_invocation',
        properties: {
            task_id: "tsk_123",
            agent_role: "SLM_TRIAGE",
            model: "qwen-2.5-coder-7b",
            prompt_tokens: 4500,
            completion_tokens: 120,
            cache_hit_rate: 0.85,
            cost_usd: 0.00032
        }
    });
    ```
3.  In PostHog, build dashboards:
    *   **Cost per Task:** Average cost to complete a Linear ticket.
    *   **Cache Hit Ratio:** Verify that the APC (Automatic Prefix Caching) strategy is working.
    *   **Flagship vs. SLM Spend:** Visual breakdown proving that 90% of the work is costing 10% of the budget.

### Step 6.2: Backend APM & Infrastructure Health (DataDog)
1.  Install the **DataDog** Agent on the Heroku/DigitalOcean droplets.
2.  Enable the Kafka integration in DataDog to monitor:
    *   **Consumer Lag:** Are the SLM workers keeping up with the Thalamus Router's fan-out requests?
    *   **Message Throughput:** Volume of tasks being processed.
3.  Enable APM tracing in the Node.js/Python workers to identify bottlenecks in database reads (MongoDB) or Sandbox execution times (Depot).

### Step 6.3: User Analytics (Amplitude)
1.  Integrate **Amplitude** into the Bubble.io frontend.
2.  Track how developers interact with the Control Center:
    *   How often do they manually intervene in a Healing Loop?
    *   Time-to-resolution from ticket creation to PR approval.
3.  Use this data to refine the autonomy of the Thalamus Router—if developers frequently intervene at a specific state, that state needs stricter programmatic guardrails or a better prompt.
