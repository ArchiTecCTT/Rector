> [!WARNING]
> STALE / QUARANTINED DOC: This cloud-heavy implementation-plan document is preserved for historical research only.
> Do not use it as the active implementation plan for Rector 0.1.0.
> Current source of truth: `docs/architecture/rector-0.1.0-architecture.md` and `docs/plans/rector-master-roadmap.md`.

# Rector: Architecture Overview

Rector is a neuro-symbolic multi-agent orchestration framework designed to minimize reliance on expensive, monolithic LLMs by routing AI logic through a deterministic assembly line.

## Core Philosophy
1. **Economic Asymmetry**: Use tiny, fast, cheap SLMs (Small Language Models) for 90% of mechanical data processing. Use Flagship models strictly for final synthesis and deep reasoning.
2. **Context Hygiene**: Never pass raw, noisy data to expensive models. Intake agents compress and distill context.
3. **Deterministic Guardrails**: LLMs do not orchestrate tasks. A JSON State Machine managed by a programmatic router (Thalamus) handles all routing, retries, and execution loops.
4. **Self-Healing Sandbox**: Generated code is executed in isolated containers. Errors are parsed deterministically and sent back to cheap SLMs for localized fixes without involving the Flagship layer.

## The Assembly Line Stack
*   **Nervous System (Event Bus):** Confluent (Kafka), MongoDB, Doppler
*   **Sandbox (Validation):** Depot, CodeCov, Codescene, Sentry
*   **Cognitive Primitives (SLMs):** Together AI (Qwen/Llama with APC), Chroma, Perplexity
*   **Prefrontal Cortex (Flagship):** Azure OpenAI / AWS Bedrock
*   **Control Center (UI):** Bubble.io, Make, Requestly
*   **Observability:** PostHog, DataDog, Amplitude

Please follow the phase files in this directory sequentially for implementation details.
