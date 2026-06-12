# Chunk 042 — System Hardening Master Plan

> **Pre-v0.3.0; superseded by [`configured-product-architecture.md`](../../architecture/configured-product-architecture.md).**

> **Branch:** `rector-0.2.0`
> **Created:** 2026-06-12
> **Goal:** Harden all orchestration, memory, and security subsystems from
> deterministic stubs/heuristics into production-grade, well-tested components.
> Resolve or formally close all open concerns in the concerns register.

## Current State (Pre-Hardening)

| Subsystem | Status | Problem |
|-----------|--------|---------|
| Triage | Deterministic regex | No LLM fallback for ambiguous inputs |
| Context Builder | Deterministic | No semantic retrieval, no memory integration |
| Planner | Fake planner | `createFakePlan` only; `runLivePlanner` exists but untested in integration |
| Skeptic | Heuristic-only | No LLM-backed semantic review |
| Crucible | Deterministic | No real arbitration, no plan repair |
| DAG Compiler | Metadata-only | Emits structure but no executable policies |
| Executor Simulator | Fake execution | Simulates, doesn't execute |
| Sandbox Executor | E2B-gated, local mock | Local always uses echo mock |
| Validation/Healing | Replays fake DAG | No real re-execution after repair |
| Synthesizer | Deterministic + live gated | Live path exists but fallback is trace dump |
| Deep Planner | Stub | Generates fake alternatives, no real MCTS |
| Ponder Swarm | Stub demo | No real reflection, fixed 2h timer |
| Task Decomposer | Alpha heuristic | Splits on `.`, max 4 sub-goals, no semantic decomposition |
| TiDB Memory | Adapter exists | Missing Chunk 27 interface methods in SQL store |
| Mem0 Memory | Adapter exists | Untested integration, optional dep |
| Chroma Memory | Adapter exists | Untested integration, optional dep |
| Truth Library | In-memory keyword | No vector/semantic search |
| Rate Limiting | In-memory only | Local-process, no distributed backend |
| Sandbox | Mock runner local | E2B only in external mode with key |

## Hardening Phases

| Phase | Chunk | Focus | Components |
|-------|-------|-------|------------|
| 1 | 042a | Orchestration Core | Triage, Context Builder, Planner, Skeptic, Crucible, DAG Compiler |
| 2 | 042b | Orchestration Execution | Executor Simulator, Sandbox Executor, Validation/Healing, Synthesizer |
| 3 | 042c | Neuro-Symbolic | Deep Planner, Ponder Swarm, Task Decomposer |
| 4 | 042d | Memory System | TiDB, Mem0, Chroma, Truth Library |
| 5 | 042e | Security & Sandbox | Rate Limiting, Sandbox, Budget |
| 6 | 042f | Concerns Resolution | Close/update all open concerns |

## Acceptance Gates (All Phases)

1. `npm test` — all existing tests pass, new tests added for hardened behavior
2. `npm run build` — clean compile
3. `npm audit` — 0 vulnerabilities maintained
4. Local mode invariant — zero external calls, deterministic, no secrets required
5. Property tests — fast-check ≥100 iterations for each new invariant
6. Redaction — all new code paths pass through redaction layer
7. Each chunk gets its own commit on `rector-0.2.0`

## Component Reference

See `042-component-reference.md` for detailed explanation of what each component
does, its current implementation, and what "hardened" means for it.
