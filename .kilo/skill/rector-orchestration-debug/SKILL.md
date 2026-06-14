---
name: rector-orchestration-debug
description: "This skill should be used when debugging, diagnosing, or understanding failures in Rector's orchestration pipeline — triage, planning, skeptic review, crucible arbitration, DAG compilation, execution, validation/healing, or synthesis. Covers the state machine, event logs, healing loop mechanics, and common failure modes. Triggers on tasks like 'debug run failure', 'why did healing fail', 'trace pipeline issue', 'run stuck in phase', or 'diagnose orchestration'."
---

# Rector Orchestration Debug

Diagnose and resolve failures in Rector's orchestration pipeline.

## Purpose

Rector's orchestration pipeline (triage -> context -> plan -> skeptic -> crucible -> DAG -> execute -> validate -> heal -> synthesize) is a complex state machine with event logging, healing loops, and multiple failure modes. This skill encodes the diagnostic knowledge needed to trace failures, understand stuck states, and resolve issues efficiently.

## When to Use

- A run is stuck or failed and the cause is unclear
- The healing loop is exhausting retries without fixing the issue
- A phase transition is invalid or unexpected
- Budget denials are blocking pipeline progress
- Provider errors are interrupting orchestration
- Understanding why a specific decision was made (skeptic/crucible)

## Pipeline Stages (in order)

| # | Phase | Module | Purpose |
|---|-------|--------|---------|
| 0 | `CHAT_RECEIVED` | chatRunner.ts | Initial state on user message |
| 1 | (external) | preprocessor.ts | SLM distills raw prompt (PREPROCESSING span) |
| 2 | `TRIAGE` | triage.ts | Route classification + complexity + risk scoring |
| 3 | `CONTEXT_BUILDING` | contextBuilder.ts | Assembles ContextPack from conversation, memory, truth library |
| 4 | `PLANNING` | planner.ts / deepPlanner.ts | Generates structured execution plan |
| 5 | `SKEPTIC_REVIEW` | skeptic.ts | Adversarial critique of the plan |
| 6 | `CRUCIBLE` | crucible.ts | Arbitrates planner vs skeptic |
| 7 | `DAG_COMPILATION` | dagCompiler.ts | Converts plan to executable DAG |
| 8 | `EXECUTING` | executorSimulator.ts | Runs DAG nodes |
| 9 | `VALIDATING` | validationHealing.ts | Classifies execution failures |
| 10 | `HEALING` | validationHealing.ts | Retry/repair loop |
| 11 | `SYNTHESIZING` | synthesizer.ts | Produces final user-facing answer |
| 12 | `DONE` | terminal | Run completes successfully |

Terminal phases: `DONE`, `NEEDS_DECISION`, `FAILED`, `ABORTED`

## Diagnostic Workflow

### Step 1: Identify Where the Pipeline Stopped

Check `run.status` and `run.phase`:
- `status: "running"` + a phase = pipeline is still active or stuck
- `status: "failed"` = check `run.lastError` and the last event
- `status: "needs_decision"` = escalated to operator, check `run.decisionRequest`

### Step 2: Read the Event Log

List events via `store.listEvents(runId)`. Each event contains:
- `type` — one of 17 event types (see `references/pipeline-reference.md`)
- `phase` — phase when event was created
- `payload` — rich, redacted metadata (provider calls, failures, actions)
- `traceId` — links to observability trace

Look for the last `PHASE_CHANGED` event to find where progress stopped, then examine subsequent events for error details.

### Step 3: Check Observability Summary

The `observabilitySummary` in the run result contains:
- Span durations per phase
- Error spans with failure context
- Model call counts and cost
- Total pipeline duration

### Step 4: Diagnose by Failure Mode

See the failure mode table in `references/pipeline-reference.md` for specific diagnosis by category.

## Healing Loop Mechanics

### Algorithm

```
1. If initial execution = SUCCESS -> return VALIDATED (no healing needed)
2. Loop:
   a. Classify failures from execution result
   b. If SUCCESS -> return HEALED (attempts > 0) or VALIDATED
   c. If PERMISSION or unsafe-to-auto-heal -> return NEEDS_DECISION
   d. If attempts >= maxHealingAttempts -> return FAILED (exhausted)
   e. Increment attempts
   f. Ask repair agent for patch proposal
   g. If proposal: apply patch through sandbox -> re-execute DAG
   h. If no proposal: return FAILED
   i. Record HealingRoundRecord
   j. Continue loop
```

### Retry Limits

- Default: `DEFAULT_MAX_HEALING_ATTEMPTS = 2`
- Live repair range: clamped to `[1, 10]`
- Configurable via `Budget.maxHealingAttempts`

### Failure Classifications

| Classification | Auto-healable? | Action |
|----------------|---------------|--------|
| `TRANSIENT` | Yes (retry) | `RETRY_NODE` |
| `TIMEOUT` | Yes (retry, clamp duration) | `RETRY_NODE` |
| `PERMISSION` | No | `REQUEST_DECISION` (escalate) |
| `DEPENDENCY` | Root-cause traced | Depends on root cause |
| `VALIDATION` | No | `FAIL_RUN` |
| `UNKNOWN` | No | `FAIL_RUN` |

### Healing Terminal Statuses

| Status | Meaning |
|--------|---------|
| `VALIDATED` | Passed with no healing |
| `HEALED` | Passed after repair(s) |
| `NEEDS_DECISION` | Escalated (PERMISSION, unsafe) |
| `FAILED` | Exhausted retries or non-healable |

## State Machine Transitions

### Valid Transitions

```
CHAT_RECEIVED    -> [TRIAGE]
TRIAGE           -> [CONTEXT_BUILDING, NEEDS_DECISION, FAILED, ABORTED]
CONTEXT_BUILDING -> [PLANNING, NEEDS_DECISION, FAILED, ABORTED]
PLANNING         -> [SKEPTIC_REVIEW, NEEDS_DECISION, FAILED, ABORTED]
SKEPTIC_REVIEW   -> [CRUCIBLE, PLANNING, NEEDS_DECISION, FAILED, ABORTED]
CRUCIBLE         -> [DAG_COMPILATION, PLANNING, NEEDS_DECISION, FAILED, ABORTED]
DAG_COMPILATION  -> [EXECUTING, NEEDS_DECISION, FAILED, ABORTED]
EXECUTING        -> [VALIDATING, HEALING, NEEDS_DECISION, FAILED, ABORTED]
VALIDATING       -> [SYNTHESIZING, HEALING, NEEDS_DECISION, FAILED, ABORTED]
HEALING          -> [VALIDATING, NEEDS_DECISION, FAILED, ABORTED]
SYNTHESIZING     -> [DONE, NEEDS_DECISION, FAILED, ABORTED]
NEEDS_DECISION   -> [all active phases + ABORTED + FAILED] (resumable)
```

Key loops:
- **SKEPTIC_REVIEW -> PLANNING** and **CRUCIBLE -> PLANNING**: plan revision
- **HEALING <-> VALIDATING**: heal-then-revalidate cycle
- **NEEDS_DECISION -> (any)**: operator resume after decision

### Invalid Transition Error

`Error("Invalid run phase transition: X -> Y")` indicates an orchestrator logic bug — the code attempted a transition not in `ALLOWED_RUN_PHASE_TRANSITIONS`.

## Common Quick Checks

| Symptom | Check |
|---------|-------|
| Run stuck in PLANNING | Budget check: `run.budget` vs `run.actualCost` |
| Healing exhausted | Read `HealingLoopResult.rounds[]` for per-round details |
| NEEDS_DECISION | Check `run.decisionRequest` for the escalation reason |
| Provider error | Check blocker `message` (redacted but descriptive) + provider config |
| Invalid plan | Planner returned non-conformant JSON; check issue paths in blocker details |
| Dependency cascade | Multiple SKIPPED nodes; trace `rootCauseNodeId` + `dependencyChain` |
| Skeptic BLOCKED | Inspect `skepticReview.findings` for BLOCKER-severity items |

## Reference Files

- `references/pipeline-reference.md` — Complete type definitions, event types, and failure mode diagnosis table
