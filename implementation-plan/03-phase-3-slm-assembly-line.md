# Phase 3: The SLM Assembly Line

This is the high-volume, low-cost execution layer. We rely on Automatic Prefix Caching (APC) and highly specialized small models to do the heavy lifting of triage, coding, and formatting.

## Objective
Implement massively parallel micro-agents that hit KV-caches efficiently, reducing token costs by 90% while maintaining high throughput.

## Tech Stack
*   **Together AI:** Inference engine for SLMs (Llama 3.1 8B, Qwen 2.5 Coder 7B). ($15K credits)
*   **Chroma:** Vector database for codebase RAG. ($5K credits)
*   **Perplexity Enterprise Pro:** Research and documentation distillation. (3 months free)
*   **DeepGram:** (Optional) Audio-to-text if taking voice commands from devs. ($1.2k credits)

## Step-by-Step Implementation

### Step 3.1: Vector Memory Setup (Chroma)
1.  Deploy a **Chroma** instance.
2.  Build an indexing script that clones the target GitHub repository.
3.  Use AST parsers to chunk the codebase by functions/classes (not just raw text splitting).
4.  Embed the chunks and store them in Chroma. Update this index via GitHub webhooks on `main` branch merges.

### Step 3.2: The Intake Agent (Context Hygiene)
1.  Create an `intake-worker` listening to Kafka.
2.  When a task arrives, the Intake Agent queries **Chroma** for relevant code files based on the task description.
3.  If the task requires external API knowledge, query **Perplexity Enterprise Pro** to get a clean, synthesized markdown summary of the required docs (preventing raw HTML scraping).
4.  The Intake Agent compiles the Chroma chunks and Perplexity summaries into a highly dense "Distilled Context" JSON object and saves it to MongoDB.

### Step 3.3: Automatic Prefix Caching (APC) Optimization
1.  Design immutable Prompt Prefixes for Together AI. The structure MUST be exact across requests to hit the cache:
    ```text
    [SYSTEM PROMPT: You are a strict Code Implementer...]
    [TOOL SCHEMA: { "name": "edit_file", "parameters": {...} }]
    [DISTILLED CONTEXT: (Inserted by Intake Agent)]
    -- (END OF PREFIX) --
    [USER INSTRUCTION: Add error handling to function X]
    ```
2.  Configure the Together AI SDK to utilize models known for strong coding and APC support (e.g., `Qwen/Qwen2.5-Coder-7B-Instruct`).

### Step 3.4: SLM Execution Fan-Out
1.  Create the `slm-worker` listening to `rector.agents.slm.request`.
2.  This worker is entirely stateless. It receives a prompt, calls Together AI, extracts the JSON/Code output, and emits it to `rector.agents.slm.response`.
3.  Because Kafka allows parallel consumers, if the Thalamus Router schedules 5 files to be updated, 5 `slm-worker` instances will pick them up simultaneously, executing concurrently against Together AI.
