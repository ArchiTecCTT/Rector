# Chunk 047c — Run Control: Interrupt, Steer & Turn Budget

> **Created:** 2026-06-12
> **Phase:** 4 of 6 (Runtime Maturity)
> **Depends on:** Chunk 047b (tool registry dispatch path), Chunk 042b (executor loop)
> **Branch:** `rector-0.3.0-configured-product`

## Goal

Make orchestrated runs **cancellable** and **steerable** during EXECUTING/VALIDATING/HEALING, with a per-run **iteration budget** consumed by executor tool dispatches and provider repair calls. Replace operator abort/retry placeholders with real run control APIs wired to the chat UI.

## Scope

### In Scope

- New: `src/orchestration/turnBudget.ts`
- New: `src/orchestration/runControl.ts` (interrupt/steer state)
- `src/orchestration/runStateMachine.ts`
- `src/orchestration/chatRunner.ts`
- `src/orchestration/sandboxExecutor.ts`
- `src/orchestration/validationHealing.ts`
- `src/orchestration/executorSimulator.ts`
- `src/tools/middleware.ts` (budget middleware integration)
- `src/api/routes/operator.ts` (real abort; steer endpoint)
- New: `src/api/routes/runControl.ts` (user-facing interrupt/steer)
- `src/public/app.js` (stop button + steer input)
- `src/providers/llm.ts` (AbortSignal on provider calls where applicable)
- Tests under `tests/`

### Out of Scope

- Cancelling runs during PLANNING/SKEPTIC (optional future: extend to provider waits in those phases)
- Distributed run control across multiple server instances
- WebSocket push for interrupt (polling or SSE existing channel is sufficient for v0.3.0)

## Design Principles

1. **Cooperative cancellation.** Executor checks `abortSignal` between DAG nodes and inside long-running sandbox commands; no thread killing.
2. **Steer is not cancel.** Steer injects user guidance into the next tool result boundary without aborting the run.
3. **Budget is consumptive.** Each tool dispatch and repair attempt consumes one unit unless `graceCall` flag set for final summary attempt.
4. **ABORTED is terminal.** Interrupt transitions run to `ABORTED` with partial synthesis optional (user sees what completed).
5. **Operator and user APIs share core.** `runControl.ts` implements logic; operator routes delegate with RBAC.

## Data Model

### `src/orchestration/turnBudget.ts`

```ts
export const TurnBudgetConfigSchema = z.object({
  maxIterations: z.number().int().positive().default(40),
  maxToolCalls: z.number().int().positive().default(80),
  graceCallOnExhaustion: z.boolean().default(true),
});

export class IterationBudget {
  constructor(config: TurnBudgetConfig);
  get remaining(): number;
  get toolCallsRemaining(): number;
  consumeToolCall(): boolean;
  consumeIteration(): boolean;
  grantGraceCall(): void; // one tool-less provider call allowed
}
```

### `src/orchestration/runControl.ts`

```ts
export type RunControlState = {
  interruptRequested: boolean;
  interruptReason?: string;
  steerQueue: string[]; // FIFO user guidance messages, redacted on enqueue
};

export function createRunControlState(): RunControlState;
export function requestInterrupt(state: RunControlState, reason?: string): void;
export function enqueueSteer(state: RunControlState, message: string): void;
export function drainSteer(state: RunControlState): string | undefined;
export function createAbortSignal(state: RunControlState): AbortSignal; // AbortController linked to interrupt
```

In-memory map: `Map<runId, RunControlState>` with TTL cleanup on run terminal states.

### New run events

- `RUN_INTERRUPT_REQUESTED` — `{ reason, requestedAt }`
- `RUN_STEER_ENQUEUED` — `{ messagePreview }` (truncated, redacted)
- `RUN_BUDGET_EXHAUSTED` — `{ iterationsUsed, toolCallsUsed }`

### API contracts

**User-facing** (`src/api/routes/runControl.ts`):

```
POST /api/runs/:runId/interrupt
Body: { reason?: string }
Response 202: { runId, status: "aborting" }

POST /api/runs/:runId/steer
Body: { message: string }
Response 202: { runId, queued: true }
```

**Operator** (`operator.ts`):

- Replace placeholder `POST /api/operator/runs/:id/abort` to call shared `interruptRun(store, runId)`
- Requires `operator.manage` permission

## Work Items

### 1. Run control state manager

Create `src/orchestration/runControl.ts`:

- Register state when `runOrchestratedChatRun` starts
- Clear state on DONE / FAILED / ABORTED
- `interruptRun(store, runId, reason)`:
  1. Set `interruptRequested`
  2. Abort linked `AbortController`
  3. Append `RUN_INTERRUPT_REQUESTED` event
  4. If phase ∈ {EXECUTING, VALIDATING, HEALING, SYNTHESIZING}, schedule transition to ABORTED after cooperative drain
- `steerRun(store, runId, message)`:
  1. Redact message
  2. Push to `steerQueue`
  3. Append `RUN_STEER_ENQUEUED` event
  4. Do **not** set interrupt flag

### 2. Iteration budget integration

- Instantiate `IterationBudget` per run in `chatRunner.ts` from template/budget policy
- Pass to executor deps
- `sandboxExecutor`: before each node, `if (!budget.consumeToolCall())` emit `RUN_BUDGET_EXHAUSTED` and break DAG with PARTIAL
- `validationHealing`: repair attempts consume `consumeIteration()`
- On exhaustion with `graceCallOnExhaustion`: allow one synthesizer call without tool dispatch

### 3. Executor cooperative abort

In `sandboxExecutor.ts` and `executorSimulator.ts`:

```ts
for (const node of executionOrder) {
  if (abortSignal.aborted) {
    return buildAbortedPartialResult(...);
  }
  const steer = drainSteer(runControl);
  const result = await runToolWithMiddleware(..., { abortSignal, steerHint: steer });
}
```

- Long `commandRunner` invocations: pass `abortSignal` where supported; poll every 100ms in local runner
- Inject steer hint into tool result metadata: `{ steerGuidance: "..." }` appended to result JSON for next planner/repair context if healing resumes

### 4. Provider call abort

In `src/providers/llm.ts` / provider adapters:

- Thread optional `abortSignal?: AbortSignal` through `complete()` / `stream()`
- Spy provider respects abort in test (reject with `AbortError`)
- Live providers: pass signal to `fetch` where supported

### 5. State machine updates

In `runStateMachine.ts`:

- Ensure `ABORTED` reachable from EXECUTING, VALIDATING, HEALING, SYNTHESIZING (already listed; verify commit path)
- Add `abortRun(store, runId)` helper that validates transition and sets `lastError` redacted

### 6. Partial synthesis on abort

In `chatRunner.ts` when abort detected:

- If at least one node completed, run abbreviated synthesizer:
  - Deterministic template: "Run interrupted. Completed: … Pending: …"
  - Include trace link
- Transition to ABORTED, not FAILED

### 7. Replace operator placeholders

In `operator.ts`:

- `POST /api/operator/runs/:id/abort` → call `interruptRun`, return `{ mutated: true, status: "aborting" }`
- `POST /api/operator/runs/:id/retry` — leave placeholder but document dependency on future resume chunk (do not fake implement)

### 8. Chat UI wiring

In `src/public/app.js`:

- Add **Stop** button visible while run status is in-flight (phases before DONE)
- On click: `POST /api/runs/${runId}/interrupt`
- Optional **Steer** text field (collapsed advanced): `POST /api/runs/${runId}/steer`
- Disable send while interrupt pending; show "Stopping…" status pill

In `src/public/index.html`:

- Add stop button element near status pill (minimal markup)

## TDD Plan

### `tests/turnBudget.test.ts`

- `consumeToolCall` decrements until zero then returns false
- `grantGraceCall` allows one iteration when exhausted
- Config defaults parse

### `tests/runControl.test.ts`

- Interrupt sets aborted signal
- Steer does not abort
- Steer queue FIFO drain
- Redaction on steer message

### `tests/runInterrupt.integration.test.ts`

- Start chat run with slow simulator node; interrupt mid-execution → ABORTED
- Partial nodes marked SUCCESS; downstream SKIPPED
- `RUN_INTERRUPT_REQUESTED` event present
- Spy provider receives abort on long call (mock delay)

### `tests/runSteer.integration.test.ts`

- Steer during execution → next tool result contains steer metadata
- Run still reaches DONE if budget allows

### API tests — `tests/runControlApi.test.ts`

- Interrupt returns 202 for active run
- Interrupt returns 404 for unknown run
- Steer rejects empty message 400
- Operator abort requires permission

## Acceptance Criteria

- [ ] Operator abort placeholder removed; real interrupt works
- [ ] UI stop button triggers interrupt
- [ ] Steer enqueues without cancelling
- [ ] Budget exhaustion produces controlled PARTIAL + `RUN_BUDGET_EXHAUSTED`
- [ ] No uncaught abort errors in provider layer
- [ ] `npm test`, `npm run build`, `npm audit` pass

## Concerns to Register

- In-memory run control map not shared across multi-process deployment
- Interrupt during NEEDS_DECISION requires separate UX (approval, not abort)
- Local commandRunner may not kill child process instantly

## Commit

```text
feat(chunk-047c): run control interrupt steer and turn budget
```