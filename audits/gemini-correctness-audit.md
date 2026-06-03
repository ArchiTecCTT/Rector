# Correctness and Logic Audit Report

## Review

### Correct: Already Good
- **Deterministic Run State Machine**: The phase transition logic in `src/orchestration/runStateMachine.ts` is robustly guarded by `ALLOWED_RUN_PHASE_TRANSITIONS`. Validations are correct, and reference leakage is prevented via structured cloning of inputs and patches before mutation.
- **Topological Sorting**: Both `src/orchestration/dagCompiler.ts` and `src/orchestration/executorSimulator.ts` correctly implement topological sorting algorithms. Cycles are correctly detected and gracefully handle arbitrary graphs.
- **Reference Integrity / Cloning**: `InMemoryRectorStore` uses `structuredClone` for all reads and writes to guarantee that map objects do not suffer from reference mutations, ensuring strong state persistence semantics in-memory.

---

### Fixed: Issues Resolved
*(None: This is a review/audit task where file edits are not permitted, so no changes have been applied to the code.)*

---

### Blocker: Critical Issues

#### 1. Empty DAG / Clarification Route Incorrectly Classified as FAILED
- **Location**: `src/orchestration/validationHealing.ts`, lines 114–126 (inside `validateAndHealExecution()`).
- **Impact**: Very common user experiences, such as empty prompt triage to `NEEDS_CLARIFICATION`, compile a 0-task plan and a 0-node DAG. The executor returns `status: "SKIPPED"` correctly, but the validation loop incorrectly classifies this as `"FAILED"` because there are no transient/timeout retryable failures (`failures.length === 0`, making `retryFailures.length === 0` true). This ultimately causes the synthesizer to output `"Status: FAILED."` in the assistant response, corrupting a completely successful clarification flow.
- **Proof / Repro**:
  We ran a TypeScript pipeline simulation with a message triaged to `NEEDS_CLARIFICATION`. The pipeline completed with `execution SKIPPED`, but the validation loop output `FAILED`, and the synthesizer output `"Status: FAILED."` in the response content.
- **Suggested Fix**:
  Update `validateAndHealExecution` to check for `failures.length === 0` or specifically handle `current.status === "SKIPPED"` as a valid completed state if there are no errors:
  ```typescript
  if (current.status === "SUCCESS" || (current.status === "SKIPPED" && failures.length === 0)) {
    return parseResult({ status: "VALIDATED", attempts, failures: [], actions, finalExecutionResult: current });
  }
  ```

---

### Note: Observations, Risks, or Follow-up Items

#### 1. High-Risk Tasks Silently Auto-Healed in Validation Loop
- **Location**: `src/orchestration/validationHealing.ts`, lines 251–266 (`isUnsafeToAutoHeal()`).
- **Observation / Risk**: While high-risk tasks (`risk: "high"`) have their task-level retry policy limited to `maxAttempts: 1` in `dagCompiler.ts`, `isUnsafeToAutoHeal` only labels `"destructive"` tasks as unsafe to auto-heal. Consequently, if a high-risk task fails due to a timeout or transient error, the validation healing loop will silently trigger a whole-DAG replay (healing attempt) up to `maxHealingAttempts` (default 2) without requesting human approval, which violates the strict intent of limiting high-risk execution retries.
- **Suggested Action**: Extend `isUnsafeToAutoHeal` to treat `"high"` risk tasks as unsafe to auto-heal, ensuring they transition to `NEEDS_DECISION`:
  ```typescript
  if (metadata?.approvalRequired === true || metadata?.risk === "destructive" || metadata?.risk === "high") return true;
  ```

#### 2. Executor Simulator `dagStatus` Returns `"PARTIAL"` with Zero Successful Tasks
- **Location**: `src/orchestration/executorSimulator.ts`, lines 365–375 (`dagStatus()`).
- **Observation / Risk**: If a DAG execution has one task that fails and downstream tasks are skipped (e.g., `failed = 1, skipped = N, succeeded = 0`), `dagStatus` returns `"PARTIAL"`. It is misleading to report `"PARTIAL"` success when exactly zero tasks completed successfully.
- **Suggested Action**: Consider adjusting the fallback logic so that if `succeeded === 0` and `failed > 0`, the status is correctly reported as `"FAILED"`:
  ```typescript
  if (failed > 0 && succeeded === 0) return "FAILED";
  ```
