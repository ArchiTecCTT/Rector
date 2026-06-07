# Implementation Plan: Productization Alpha

## Overview

This plan layers the ten productization deliverables plus cross-cutting non-functional guarantees **around** the existing, complete local-first BYOK control plane. Every module is additive and inert in Local_Mode by default. All work is in TypeScript using the existing stack (vitest + fast-check), uses deterministic test doubles (injected `fetchImpl`, `WorkspaceFs`, `CommandRunner`, in-memory `SqlDriver`, fake clocks), and makes zero real provider or network calls. New API responses, UI surfaces, streamed frames, and errors route through the existing `Redaction_Layer`.

Property-based tests implement the 17 correctness properties from the design (one PBT per property, minimum 100 iterations, tagged `// Feature: productization-alpha, Property {n}: ...`). UI panels, design-only documents, and verification gates are covered by example, snapshot, doc-structure, and smoke tests.

## Tasks

- [ ] 1. Implement Secret Store abstraction
  - [x] 1.1 Implement `SecretStore` interface and local development backing
    - Create `src/security/secretStore.ts` with `SecretStore` (`setSecret`, `getSecret`, `hasSecret`) and `SecretStoreResult<T>` discriminated union
    - Implement `createLocalSecretStore(options: LocalSecretStoreOptions)` that persists across restarts using an authenticated-encryption envelope (nonce + ciphertext + tag), with injectable `fsImpl` and `now`
    - Keep the interface consumer-agnostic so an OS-keychain backing can be added without changing consumers
    - Route every error message through `redactString`/`redactSecrets`; on store/retrieve failure return `{ok:false, error}` without persisting a partial/corrupted value
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.6, 7.7, 7.8_

  - [ ] 1.2 Write property test for secret store restart round-trip
    - **Property 10: Secret store persists across restart (round-trip)**
    - **Validates: Requirements 7.2**

  - [ ] 1.3 Write property test for non-plaintext stored representation
    - **Property 11: Secret store representation is non-plaintext**
    - **Validates: Requirements 7.4**

  - [ ] 1.4 Write property test for secret presence without value exposure
    - **Property 2: Secret presence is reported without value exposure**
    - **Validates: Requirements 1.4, 7.5, 7.6**

  - [ ] 1.5 Write unit tests for secret store failure paths
    - Cover mid-write failure (no partial/corrupted value persisted) and redacted error messages
    - _Requirements: 7.7, 7.8_

- [ ] 2. Implement Setup Status Service and Setup API
  - [ ] 2.1 Implement `computeSetupStatus` composer
    - Create `src/setupStatus.ts` with `SetupMode`, `ReadinessStatus`, `SetupCategory`, `CategoryReadiness`, `SetupStatusResponse`
    - Derive mode from `ORCHESTRATOR_MODE` (default `local`); compose `getSetupChecklist()` into exactly one readiness entry per category; include `secretPresence` booleans only via the `SecretStore`
    - Run the assembled response through `redactSecrets` before return; if redaction of a value fails, omit that value rather than return it
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.10, 7.5_

  - [ ] 2.2 Write property test for setup status mode derivation
    - **Property 3: Setup status mode derivation**
    - **Validates: Requirements 1.1**

  - [ ] 2.3 Write property test for well-formed readiness
    - **Property 4: Setup status readiness is well-formed**
    - **Validates: Requirements 1.2**

  - [ ] 2.4 Add `GET /api/setup/status` route
    - Wire the route in `src/api/server.ts` returning the redacted `SetupStatusResponse`
    - Wrap in try/catch returning a structured, redacted error state; keep the handler fast and non-blocking so the client can apply a 10s timeout
    - _Requirements: 1.3, 1.8_

  - [ ] 2.5 Write unit tests for setup status route error handling
    - Cover internal-error structured response and redacted value omission
    - _Requirements: 1.8, 1.10_

- [ ] 3. Implement Setup Wizard UI
  - [ ] 3.1 Build the Setup Wizard panel
    - Add a panel in `src/public` rendered alongside (never replacing) the existing chat/trace UI
    - Fetch `/api/setup/status`, render mode plus the four category pills, and show an error state on failure or a 10s client timeout while keeping chat/trace accessible
    - Store no secret values in `localStorage`/`sessionStorage`; render no configuration-mutation controls
    - _Requirements: 1.1, 1.2, 1.5, 1.6, 1.7, 1.8, 1.9_

  - [ ] 3.2 Write snapshot/DOM tests for the wizard
    - Assert mode + four pills render, chat/trace remain accessible, error and timeout states render
    - _Requirements: 1.5, 1.6, 1.7, 1.8, 1.9_

- [ ] 4. Implement Provider Key Test Panel
  - [x] 4.1 Build the Provider Test Panel over the existing connection test
    - Add a panel in `src/public` listing providers from `SUPPORTED_PROVIDER_IDS`; enable the test action only when exactly one provider is selected
    - Invoke the existing Connection_Test_API promptly; show a loading indicator and disable the action while in flight; render redacted success/failure messages and retain selection on failure
    - Apply a 30s client-side timeout that aborts, clears loading, and shows a redacted timeout message
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_

  - [ ] 4.2 Write property test for connection-test action enablement
    - **Property 5: Connection-test action enablement**
    - **Validates: Requirements 2.1**

  - [ ] 4.3 Write unit tests for provider panel states
    - Cover loading/disabled-in-flight, redacted failure message with retained selection, and 30s timeout message
    - _Requirements: 2.2, 2.4, 2.6, 2.7_

- [ ] 5. Implement Workspace Safety API and Panel
  - [ ] 5.1 Add the workspace safety endpoint
    - Implement `buildWorkspaceSafetyResponse(config)` and a read-only route in `src/api/server.ts` exposing workspace root (redacted), allowlisted commands, destructive-protection status, and approval-required categories
    - Set `available:false` when the root or policy cannot be retrieved; the endpoint reads configuration only and never executes
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.7, 3.8_

  - [ ] 5.2 Build the Workspace Safety panel
    - Add a panel in `src/public` rendering the safety values with no command-execution control; show an unavailable error state with no action controls when `available:false`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.6, 3.8_

  - [ ] 5.3 Write unit tests for the safety panel/endpoint
    - Cover policy rendering, no-exec-control invariant, and the unavailable state
    - _Requirements: 3.6, 3.8_

- [ ] 6. Implement Benchmark Harness
  - [x] 6.1 Implement the harness, types, and fixture tasks
    - Create `src/benchmark/` with `BenchmarkTask`, `BenchmarkResult`, `BenchmarkSummary`, `BenchmarkOptions`, and `runBenchmark(tasks, options)` plus a script entry point
    - Provide at least three version-controlled tasks, each building its own isolated `Fixture_Workspace`; default mode uses deterministic test doubles with no network
    - Write all output under a temporary root (never modify tracked files); retain artifacts/logs and record `failed` on failure; terminate and record `timeout` past 300s; produce a summary with total and per-status counts; support a manual `live` mode over the same task set
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8_

  - [ ] 6.2 Write property test for benchmark result completeness
    - **Property 6: Benchmark result completeness**
    - **Validates: Requirements 4.3**

  - [ ] 6.3 Write property test for benchmark output containment
    - **Property 7: Benchmark output containment**
    - **Validates: Requirements 4.4**

  - [ ] 6.4 Write property test for consistent summary counts
    - **Property 8: Benchmark summary counts are consistent**
    - **Validates: Requirements 4.8**

  - [ ] 6.5 Write property test for default-mode determinism
    - **Property 9: Benchmark determinism in default mode**
    - **Validates: Requirements 4.9**

  - [ ] 6.6 Write unit tests for benchmark failure and timeout
    - Cover artifact retention on failure, 300s timeout termination, and zero network calls in default mode
    - _Requirements: 4.2, 4.5, 4.7_

- [ ] 7. Checkpoint - core services and panels
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 8. Implement Store config validation and TiDB smoke path
  - [x] 8.1 Add the TiDB write-then-read-back smoke script and docs
    - Add a manual script under `scripts/` performing a write-then-read-back cycle that passes only on a field-for-field match, reusing the existing `createRectorStore`/`assertCompleteTiDBConfig`/`StoreConfigError` path
    - Document required env vars in `docs/`; ensure the script never runs in CI and that SQLite remains the default when no driver is configured
    - _Requirements: 8.1, 8.2, 8.3, 8.6_

  - [ ] 8.2 Write property test for store write-then-read-back round-trip
    - **Property 12: Store write-then-read-back round-trip**
    - **Validates: Requirements 8.1**

  - [ ] 8.3 Write property test for pre-I/O rejection of incomplete config
    - **Property 13: Incomplete persistence config is rejected before I/O**
    - **Validates: Requirements 8.4**

  - [ ] 8.4 Write unit tests for read-back mismatch and SQLite default
    - Cover read-back mismatch failure reporting and default SQLite selection
    - _Requirements: 8.2, 8.6_

- [ ] 9. Implement Run Approval UX
  - [ ] 9.1 Add the approval decision recorder and endpoint
    - Implement `recordApprovalDecision(store, input, options)` and `POST /api/runs/:id/decision` in `src/api`, binding the existing `NEEDS_APPROVAL`/`NEEDS_DECISION` states via `createDecisionRequest`/`resumeFromDecision`
    - Record decision, deciding identity, and timestamp in the `Event_Log` before executing or cancelling; require explicit approval for risky shell commands; on denial halt the operation and continue the run to a final answer excluding it (targets unchanged)
    - When the operation cannot be presented or recorded, do not execute, keep the run pending, and surface an indication; treat a 30-minute no-decision as a timeout denial
    - _Requirements: 9.1, 9.3, 9.4, 9.5, 9.7, 9.8_

  - [ ] 9.2 Build the Approval UX panel
    - Add a panel in `src/public` that consumes the existing SSE stream, presents pending operations, and displays redacted diff/command/target path before any approval action can be submitted
    - _Requirements: 9.1, 9.2, 9.6_

  - [ ] 9.3 Write property test for decision-before-action ordering
    - **Property 14: A decision is recorded before the operation acts**
    - **Validates: Requirements 9.3**

  - [ ] 9.4 Write property test for approval-gated risky commands
    - **Property 15: Risky commands never run without recorded approval**
    - **Validates: Requirements 9.4**

  - [ ] 9.5 Write property test for denial leaving targets unchanged
    - **Property 16: Denial leaves targets unchanged and continues the run**
    - **Validates: Requirements 9.5, 9.8**

  - [ ] 9.6 Write unit tests for approval edge cases
    - Cover record-failure keeping the run pending and the 30-minute timeout denial
    - _Requirements: 9.7, 9.8_

- [ ] 10. Enforce cross-cutting redaction at new boundaries
  - [ ] 10.1 Wire all new boundaries through redaction with failure suppression
    - Audit the new setup-status, workspace-safety, and approval responses, streamed frames, and error paths to ensure each routes through `redactSecrets`/`redactString`
    - Add outbound redaction-failure suppression so unredacted content is never emitted and a redaction-failed error is returned instead
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_

  - [ ] 10.2 Write property test for boundary redaction
    - **Property 1: Boundary redaction leaves no secret substring**
    - **Validates: Requirements 1.3, 1.4, 2.3, 2.5, 3.7, 5.7, 7.8, 8.5, 9.6, 11.1, 11.2, 11.3, 11.4**

- [ ] 11. Implement Prompt Hardening regression harness
  - [x] 11.1 Add the safety-constraint test suite
    - Add tests asserting every existing safety line/invariant in `PLANNER_SYSTEM_RULES`, `SKEPTIC_SYSTEM_RULES`, `SYNTHESIZER_SYSTEM_RULES`, and `REPAIR_SYSTEM_RULES` remains present, so a prompt edit that drops a constraint fails the gate (rejecting the update)
    - _Requirements: 5.2, 5.3, 5.7_

  - [x] 11.2 Add the Local_Mode baseline pass-rate guard
    - Add a test comparing the Local_Mode regression pass rate before/after a prompt change so a drop fails the gate and the previous prompt set stands
    - _Requirements: 5.5, 5.6_

  - [ ] 11.3 Add a regression-case template for fixed failure modes
    - Provide a reusable regression-case scaffold that reproduces a benchmark failure mode and asserts the corrected behavior
    - _Requirements: 5.1, 5.4_

- [ ] 12. Author design-only documents
  - [x] 12.1 Write the Desktop_Shell_Decision document
    - Create the document under `docs/` stating exactly one recommended shell (Tauri or Electron) with an assessment of packaging, local server lifecycle, native folder picker, secure secret storage, auto-update, and Windows/macOS/Linux concerns for both options
    - Include a rationale referencing the assessment, a minimal prototype path (or documented deferral reason), and any added-dependency reasons; leave the Node web app runnable with gates passing
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_

  - [ ] 12.2 Write doc-structure test for the Desktop_Shell_Decision
    - Assert presence of recommendation, assessment factors, rationale, and prototype path/deferral sections
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

  - [x] 12.3 Write the Mobile_Companion_Design document
    - Create the document under `docs/` describing the control-surface capabilities (instruct, monitor, approve/deny, completion notifications, run summaries), the no-local-execution statement, and the desktop/relay-only communication boundary
    - Document each named risk (stolen device, relay compromise, prompt injection, approval spoofing) with a mitigation or explicit residual-risk statement; route approvals through the `Approval_Flow`/`Event_Log`; enumerate non-goals
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6_

  - [ ] 12.4 Write doc-structure test for the Mobile_Companion_Design
    - Assert presence of capabilities, no-local-exec statement, comms boundary, risk/mitigation entries, approval routing, and non-goals
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6_

- [ ] 13. Implement preserve-experience guard suite
  - [ ] 13.1 Add the regression guard suite
    - Add guards asserting existing chat/trace tests still pass, sandbox constraints are unchanged, all five verification gates pass, and the suite makes zero real provider/network calls
    - _Requirements: 12.1, 12.2, 12.4, 12.5, 12.6_

  - [ ] 13.2 Write property test for Local_Mode determinism vs baseline
    - **Property 17: Local_Mode is deterministic against the baseline**
    - **Validates: Requirements 12.3**

- [ ] 14. Final checkpoint - all gates green
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional (property, unit, snapshot, doc-structure, and integration tests) and can be skipped for a faster MVP; core implementation tasks are never optional.
- Prompt-hardening tasks 11.1 and 11.2 are core deliverables (the safety/baseline gates themselves), so they are not marked optional even though they are test code.
- Each task references specific granular requirements for traceability.
- Each correctness property (1–17) is implemented by a single fast-check property test (minimum 100 iterations) tagged `// Feature: productization-alpha, Property {n}: ...`.
- All tests use deterministic doubles (`fetchImpl`, `WorkspaceFs`, `CommandRunner`, in-memory `SqlDriver`, fake clocks) and make zero real provider or network calls.
- Checkpoints ensure incremental validation against the five verification gates.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "4.1", "6.1", "8.1", "11.1", "11.2", "12.1", "12.3"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4", "1.5", "2.1", "4.2", "4.3", "6.2", "6.3", "6.4", "6.5", "6.6", "8.2", "8.3", "8.4", "11.3", "12.2", "12.4"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4"] },
    { "id": 3, "tasks": ["2.5", "3.1", "5.1"] },
    { "id": 4, "tasks": ["3.2", "5.2", "5.3", "9.1"] },
    { "id": 5, "tasks": ["9.2", "9.3", "9.4", "9.5", "9.6", "10.1"] },
    { "id": 6, "tasks": ["10.2", "13.1", "13.2"] }
  ]
}
```
