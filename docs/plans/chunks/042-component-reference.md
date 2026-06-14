# Chunk 042 Component Reference — What Each Part Does

> Created: 2026-06-12
> Purpose: Explain the subsystems targeted by the hardening plan before implementation.

## Orchestration Components

### 1. Triage (`src/orchestration/triage.ts`)

**Job:** Decide what kind of user request this is before expensive work starts.

It classifies each message into routes:

- `DIRECT_ANSWER` — answer immediately, no plan/execution needed.
- `PLAN_ONLY` — produce a plan/design, do not change files.
- `CODE_EDIT` — likely code modification request.
- `RESEARCH` — needs research/search/context gathering.
- `LONG_RUNNING` — bigger task, likely multi-step execution.
- `NEEDS_CLARIFICATION` — prompt too vague or unsafe to proceed.

**Current implementation:** deterministic regex/pattern scoring.

**Hardened target:** deterministic local baseline stays, but external mode can add optional LLM-assisted classification, confidence calibration, ambiguity detection, risk labels, and traceable reasons.

---

### 2. Context Builder (`src/orchestration/contextBuilder.ts`)

**Job:** Assemble the context pack used by planner/reviewer/synthesizer.

It gathers:

- conversation/message references
- relevant docs/artifacts
- memory entries
- constraints
- available providers/tools
- risk flags
- inline vs externalized context artifacts

**Current implementation:** deterministic, mostly store/truth-library driven, limited retrieval.

**Hardened target:** stronger retrieval ranking, bounded context budgets, time-aware memory summaries, provenance/citations, stale-context detection, and deterministic local fallbacks.

---

### 3. Planner (`src/orchestration/planner.ts`)

**Job:** Convert triage + context into a structured plan.

Plan includes:

- goal
- assumptions
- tasks
- dependencies
- validation checks
- risk level
- approval gates

**Current implementation:** `createFakePlan` deterministic baseline; `runLivePlanner` exists for external mode but needs stronger integration/testing.

**Hardened target:** live planner produces schema-valid, dependency-safe, testable plans; deterministic fallback remains; repair attempts are bounded; budget/redaction always enforced.

---

### 4. Skeptic (`src/orchestration/skeptic.ts`)

**Job:** Review the planner output before execution.

It checks:

- missing validation
- dangling dependencies
- weak approval gates
- underestimated risk
- destructive language
- context mismatch

**Current implementation:** deterministic heuristic review plus live prompt support.

**Hardened target:** hybrid review: deterministic gates first, optional LLM semantic critique second, finding deduplication, severity thresholds, and explainable blockers.

---

### 5. Crucible (`src/orchestration/crucible.ts`)

**Job:** Arbitrate planner vs skeptic findings.

It decides:

- `ACCEPTED` — plan can compile/execute.
- `NEEDS_REVISION` — repair plan and review again.
- `ESCALATED` — human/operator decision needed.
- `BLOCKED` — cannot proceed safely.

**Current implementation:** deterministic arbitration with max 2 rounds.

**Hardened target:** enforce stricter revision semantics, attach blocker evidence, support targeted repair prompts, and make escalation criteria explicit.

---

### 6. DAG Compiler (`src/orchestration/dagCompiler.ts`)

**Job:** Convert an accepted plan into an executable DAG.

It produces:

- task nodes
- validation nodes
- dependency edges
- validation policy
- budget policy
- permissions metadata

**Current implementation:** structurally compiles plan to DAG; execution policies are mostly metadata.

**Hardened target:** explicit node capability policies, safer permission mapping, topological/cycle guarantees, executable validation contracts, artifact expectations, and rollback metadata.

---

### 7. Executor Simulator (`src/orchestration/executorSimulator.ts`)

**Job:** Deterministically simulate DAG execution for local/provider-free mode and tests.

It models:

- dependency ordering
- retries
- timeouts
- injected failures
- node events/results

**Current implementation:** fake deterministic execution.

**Hardened target:** keep deterministic simulator, but increase fidelity: better retry policies, dependency failure propagation, validation-node semantics, timeout modeling, and trace parity with real sandbox execution.

---

### 8. Sandbox Executor (`src/orchestration/sandboxExecutor.ts`)

**Job:** Bridge DAG nodes to real sandbox operations.

It maps nodes to:

- file reads/writes
- patch proposals
- commands
- validation operations

and sends them through `WorkspaceSandboxAdapter`.

**Current implementation:** safe bridge exists; real E2B only when configured; local path mostly mock/no-op.

**Hardened target:** robust operation mapping, artifact capture, stdout/stderr truncation, timeout/cancel handling, approval integration, and local safe command runner option guarded by policy.

---

### 9. Validation/Healing (`src/orchestration/validationHealing.ts`)

**Job:** Validate execution results, classify failures, and attempt bounded repair.

It handles:

- transient failures
- permission failures
- timeouts
- dependency failures
- validation failures
- patch-based repair
- revalidation

**Current implementation:** loops over fake DAG/sandbox results with simple classifications.

**Hardened target:** real validation checks, targeted repair per failure class, bounded re-execution, preserved artifacts, no blind retry loops, and clear `NEEDS_DECISION` escalation.

---

### 10. Synthesizer (`src/orchestration/synthesizer.ts`)

**Job:** Convert internal trace/results into a user-facing answer.

It includes:

- status
- route
- trace id
- evidence list
- observability summary
- final response text

**Current implementation:** deterministic route-aware response; live synthesizer exists with fallback.

**Hardened target:** external mode produces useful natural-language answers with citations/evidence, while local fallback remains deterministic and redacted.

---

### 11. Deep Planner (`src/orchestration/deepPlanner.ts`)

**Job:** Explore alternative plans when deep planning is enabled.

Current method:

- run base live planner
- generate a few deterministic alternatives
- prune with symbolic rules
- pick best plan

**Current implementation:** lightweight alpha, not real MCTS.

**Hardened target:** bounded multi-candidate search with explicit scoring, symbolic pruning, cost caps, diversity, validation coverage, and deterministic fallback.

---

### 12. Ponder Swarm (`src/orchestration/ponderSwarm.ts`)

**Job:** Reflect on memory after runs and extract lessons/contradictions.

It should support:

- background reflection
- lessons learned
- contradiction detection
- memory consolidation
- proactive hints

**Current implementation:** simple recent episodic memory reflection using synthesizer; fixed timer elsewhere.

**Hardened target:** event-driven triggers, budget gates, deduplication, contradiction confidence, no runaway background work, and observable lesson writes.

---

### 13. Task Decomposer (`src/orchestration/taskDecomposer.ts`)

**Job:** Split high-complexity tasks into smaller sub-goals and stitch results.

**Current implementation:** splits distilled text on punctuation, max 4 sub-goals; executes no-op LLM nodes through sandbox bridge.

**Hardened target:** semantic decomposition, dependency-aware sub-DAGs, bounded concurrency, partial-failure handling, artifact stitching, and clear user-facing synthesis.

---

## Memory Components

### 14. TiDB Memory (`src/memory/tidbMemoryAdapter.ts`, `src/store/tidbRectorStore.ts`)

**Job:** Durable cloud SQL memory/persistence backend.

**Current implementation:** adapter and driver exist; startup migration exists but boot wiring and full advanced memory parity need verification.

**Hardened target:** boot migration enforced before listen, schema verified, advanced memory methods covered, connection timeout/retry classified, and live smoke tests optional.

---

### 15. Mem0 Adapter (`src/memory/mem0Adapter.ts`)

**Job:** External managed memory service adapter.

**Current implementation:** optional dependency, local TypeScript interface, CRUD/search mapping, budget checks.

**Hardened target:** contract tests, error classification, metadata roundtrip, redaction, budget enforcement, and optional live test behind env flag.

---

### 16. Chroma Adapter (`src/memory/chromaMemoryAdapter.ts`)

**Job:** Vector database memory/search adapter.

**Current implementation:** optional dependency, collection wrapper, CRUD/search mapping.

**Hardened target:** deterministic adapter contract tests, vector search semantics, metadata filters, connection errors, redaction, and optional live smoke.

---

### 17. Truth Library (`src/memory/truthLibrary.ts`)

**Job:** Store/retrieve trusted facts/docs with provenance and citations.

**Current implementation:** in-memory keyword search.

**Hardened target:** hybrid retrieval scoring, provenance-aware ranking, citation quality checks, stale/rejected filtering, and future vector backend interface.

---

## Security Components

### 18. Rate Limiting (`src/api/server.ts`)

**Job:** Prevent API abuse and runaway chat/provider calls.

**Current implementation:** process-local in-memory buckets.

**Hardened target:** pluggable rate limiter interface, local default, distributed adapter contract, per-user/per-IP/per-route keys, correct headers, and testable clock injection.

---

### 19. Sandbox (`src/sandbox/index.ts`, E2B adapter paths)

**Job:** Contain file/command execution.

**Current implementation:** workspace containment, denylist, approvals, redaction, mock local runner; E2B external adapter gated.

**Hardened target:** policy-first execution, network/secrets controls, command allowlist, timeout/cancellation, artifact truncation, approval gates, and live E2B smoke behind env flag.
