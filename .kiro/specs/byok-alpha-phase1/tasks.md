# Implementation Plan: BYOK Alpha Phase 1 (ORN-31 → ORN-34)

## Overview

This plan implements a BYOK provider path for the PLANNING phase only, in TypeScript, building
entirely on existing primitives (`buildModelRouter`/`invokeWithBudget` in `src/providers/llm.ts`,
`evaluateBudget` in `src/security/budget.ts`, `redactString`/`redactSecrets` in
`src/security/redaction.ts`, the Zod planner schemas in `src/orchestration/planner.ts`, and the run
state machine). The local provider-free path stays the default and the `npm test` regression
baseline — no API key or real network is required by any test.

Work proceeds bottom-up: a test harness and shared generators, then the orchestration mode switch
(ORN-31), the live planner with validation and a single repair retry (ORN-34), the connection-test
endpoint (ORN-32), the mode-aware chat runner (ORN-33), and finally cross-cutting redaction and
integration coverage. Property-based tests use `fast-check` (added as a dev dependency) and cover
the 9 correctness properties enumerated in the design; example/unit tests cover the rest. All
provider and `fetch` interactions are mocked.

## Tasks

- [x] 1. Test harness and shared property-test utilities
  - [x] 1.1 Add fast-check and create shared BYOK test utilities
    - Add `fast-check` to `devDependencies` in `package.json` (first PBT use in the repo)
    - Create `tests/support/byokArbitraries.ts` with fast-check arbitraries: arbitrary prompts,
      arbitrary key-like secret strings, arbitrary budgets (including sub-threshold), valid plans
      derived from `PlannerOutputSchema`, and arbitrary malformed/schema-invalid planner JSON
    - Add a configurable spy/mock `LLMProvider` double exposing an `invoke` call counter,
      `estimateRequest`, and scripted responses (mocked `fetch` factory for the connection test)
    - _Requirements: 1.6, 2.2 (enables zero-network, mock-only property and unit tests P1–P9)_

- [x] 2. Orchestration mode configuration and startup validation (ORN-31)
  - [x] 2.1 Implement `parseOrchestrationConfig` and `OrchestrationConfigError`
    - In `src/deployment/index.ts`: add `ORCHESTRATOR_MODES`, `OrchestratorModeSchema`,
      `OrchestratorMode`, `OrchestrationConfig`, `parseOrchestrationConfig(env?)`, and
      `OrchestrationConfigError` (codes `ORCHESTRATOR_MODE_INVALID` / `EXTERNAL_MODE_NO_PROVIDER`,
      redacted `setupHint`)
    - Default to `local` when `ORCHESTRATOR_MODE` is unset/empty/whitespace; reject unknown
      (case-sensitive) values; in `external` mode collect providers whose `validateConfig()` passes;
      throw `EXTERNAL_MODE_NO_PROVIDER` with a redacted hint naming required env key names when none
      validate; never read secret values into the result; perform zero network I/O
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

  - [x] 2.2 Write property test for safe defaults and external validation
    - **Property 8: External mode defaults safely and never requires keys for `npm test`**
    - **Validates: Requirements 1.1, 1.2, 1.4, 1.5, 1.6**
    - Add to `tests/deployment.test.ts`; assert unset mode resolves to `local`, external-with-no-valid-provider
      throws a redacted `OrchestrationConfigError` (no crash), and parsing makes zero network calls

  - [x] 2.3 Write unit tests for `parseOrchestrationConfig`
    - Cover default-local, unknown-mode rejection, external with and without a valid provider, and
      that no secret value appears in the returned config or in any error message
    - Add to `tests/deployment.test.ts`
    - _Requirements: 1.2, 1.3, 1.5, 1.6_

  - [x] 2.4 Wire orchestration config into startup, app creation, and setup checklist
    - `src/bin/server.ts`: call `parseOrchestrationConfig(process.env)` before serving; build the
      router by mode and pass `orchestration: { mode, router }` to `createApp`
    - `src/api/server.ts`: accept and store an `orchestration` option (`mode`, optional `router`)
    - `src/setupChecklist.ts`: add a descriptive `ORCHESTRATOR_MODE` item (key name only)
    - _Requirements: 1.1, 1.2_

- [x] 3. Live planner agent with validation and single repair retry (ORN-34)
  - [x] 3.1 Implement planner prompt construction
    - Create `src/orchestration/prompts.ts` with `buildPlannerPrompt(input)` (system rules + JSON
      contract + context) and `buildPlannerRepairPrompt(input, priorContent, errorSummary)`
    - _Requirements: 4.2, 4.10_

  - [x] 3.2 Implement `runLivePlanner` with budget preflight, validation, repair, and blockers
    - In `src/orchestration/planner.ts`: add `LivePlannerStatus`, `LivePlannerResult`,
      `PlannerBlocker`, `PlannerBlockerSchema`, `LivePlannerDeps`, and `runLivePlanner`; keep
      `createFakePlan`
    - Validate `input` with `PlannerInputSchema`; run `evaluateBudget` preflight before each
      `provider.invoke`; request `responseFormat: { type: "json_object" }`; call `invokeWithBudget`;
      parse JSON; validate with `PlannerOutputSchema` + `validatePlannerOutput`; issue exactly one
      repair prompt on failure; emit `BUDGET_DENIED` / `PLANNER_INVALID` / `PROVIDER_ERROR` blockers
      with `redactString`/`redactSecrets` on message and details (Zod issue paths only); accumulate
      `LLMUsage` across attempts
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 4.10, 4.11, 4.12_

  - [x] 3.3 Write property test for budget preflight before any network call
    - **Property 3: Budget denial precedes the network call**
    - **Validates: Requirements 3.3, 4.5**
    - Add to `tests/livePlanner.test.ts`; arbitrary sub-threshold budgets yield a `BUDGET_DENIED`
      blocker with the spy provider `invoke` count exactly 0

  - [x] 3.4 Write property test for invalid output after one repair
    - **Property 4: Invalid planner JSON after one repair yields a structured blocker, never a crash**
    - **Validates: Requirements 4.2, 4.3, 3.5**
    - Add to `tests/livePlanner.test.ts`; arbitrary malformed/schema-invalid outputs resolve to a
      redacted `PLANNER_INVALID` blocker with `attempts = 2` and exactly two `invoke` calls

  - [x] 3.5 Write property test for validation parity with the fake plan
    - **Property 5: Valid planner JSON (possibly after repair) passes the same safety bar as the fake plan**
    - **Validates: Requirements 4.1, 4.6**
    - Add to `tests/livePlanner.test.ts`; for arbitrary schema-valid plans, status `ok` only when
      `validatePlannerOutput` accepts the plan

  - [x] 3.6 Write property test for the single-repair call bound
    - **Property 6: At most one repair (at most 2 provider calls)**
    - **Validates: Requirements 4.2**
    - Add to `tests/livePlanner.test.ts`; assert `invoke` count ≤ 2 over any single invocation

  - [x] 3.7 Write unit tests for `runLivePlanner`
    - Valid first try, valid after repair, provider-error mapping to `PROVIDER_ERROR`, usage
      accumulation, input-schema validation, `json_object` response format, and redaction of details
    - Add to `tests/livePlanner.test.ts`
    - _Requirements: 4.1, 4.7, 4.8, 4.9, 4.10, 4.11, 4.12_

- [x] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Provider connection-test endpoint (ORN-32)
  - [x] 5.1 Implement `runConnectionTest` and request/response schemas
    - In `src/api/server.ts` (with a provider-resolution helper reusing `src/providers/llm.ts`): add
      `TestConnectionRequestSchema`, `TestConnectionResponseSchema`, and
      `runConnectionTest({ providerId, env, fetchImpl })`
    - Reject unsupported/unknown `providerId` with `code: "CONFIG_INVALID"`, `networkAttempted: false`;
      build exactly one provider with `enableNetwork: true` and the injected `fetchImpl`; call
      `validateConfig()` first and short-circuit on `CONFIG_INVALID` with `networkAttempted: false`;
      otherwise `invoke` a minimal ping (small `maxOutputTokens`); map `ProviderError`/exceptions to a
      safe response; run every outbound message through `redactString`; never include the API key,
      Authorization header, or raw body
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [x] 5.2 Wire `POST /api/setup/test-connection` route
    - Add the route in `src/api/server.ts` that validates the body with Zod, calls `runConnectionTest`
      with the real `fetch`, and returns 400 on invalid body/unsupported `providerId`
    - _Requirements: 2.1, 2.4_

  - [x] 5.3 Write property test for the config-invalid network short-circuit
    - **Property 9: Connection test never calls network when config is invalid**
    - **Validates: Requirements 2.1, 2.2, 2.4**
    - Add to `tests/connectionVerification.test.ts`; with credentials missing or `providerId`
      unsupported, assert `ok:false`, `networkAttempted:false`, and the mocked `fetchImpl` is called 0 times

  - [x] 5.4 Write unit tests for `runConnectionTest`
    - Invalid `providerId`, `CONFIG_INVALID` short-circuit (no fetch), successful ping, HTTP/network
      failure mapping, and redaction of error bodies
    - Add to `tests/connectionVerification.test.ts`
    - _Requirements: 2.3, 2.5, 2.6_

- [x] 6. Mode-aware chat runner with budget preflight (ORN-33)
  - [x] 6.1 Implement `runChat` dispatcher and the local runner
    - Create `src/orchestration/chatRunner.ts` with `ChatRunnerDeps`, `ChatRunResult`, and `runChat`
      that dispatches by mode; refactor the existing `createFakeChatRun` logic into `runFakeChatRun`
      and the shared deterministic phase sequence (skeptic → crucible → DAG → executor → validation →
      synthesis), preserving identical local-mode outputs (`createFakePlan`, all-zero budget/cost)
    - _Requirements: 3.1, 3.2, 3.8_

  - [x] 6.2 Write property test for local-mode regression baseline
    - **Property 1: Local mode output is unchanged (regression baseline)**
    - **Validates: Requirements 3.1, 3.2**
    - Add to `tests/chatRunner.test.ts`; for arbitrary prompts assert the local-mode phase sequence,
      `costEstimate.usd === 0`, and `actualCost.modelCalls === 0` match the deterministic baseline

  - [x] 6.3 Implement the external chat runner with metadata recording
    - In `src/orchestration/chatRunner.ts`: add `runExternalChatRun` and `ProviderCallMetadataSchema`;
      create the run with the external budget, select the provider via `router.select`, run the budget
      preflight before any provider call, obtain the plan via `runLivePlanner`, record
      `ProviderCallMetadata` on the `PLANNING` event, map reported `estimatedUsd`/tokens into the run's
      `costEstimate`/`tokenEstimate` (and `actualCost`/`actualTokens`), and on a blocker transition the
      run to `FAILED` (`PLANNER_INVALID`) or `NEEDS_DECISION` (`BUDGET_DENIED`/`PROVIDER_ERROR`) via the
      run state machine, returning a structured result without throwing past the handler
    - _Requirements: 3.3, 3.4, 3.5, 3.6, 3.7, 3.8_

  - [x] 6.4 Write property test for recorded provider/cost metadata
    - **Property 7: External mode records provider/model/cost on the PLANNING event**
    - **Validates: Requirements 3.4, 4.9**
    - Add to `tests/chatRunner.test.ts`; drive a successful external run with a mocked provider
      reporting arbitrary token counts and assert the `PLANNING` event carries
      `ProviderCallMetadata` and the run cost/token fields reflect the reported usage

  - [x] 6.5 Write unit tests for the external chat runner
    - Planner swap vs local, metadata recording shape, and blocker-to-transition mapping
      (`FAILED` vs `NEEDS_DECISION`) without an exception escaping the handler
    - Add to `tests/chatApi.test.ts`
    - _Requirements: 3.4, 3.5, 3.6, 3.7_

  - [x] 6.6 Wire `runChat` into the chat endpoint
    - In `src/api/server.ts`, replace the hard-coded `createFakeChatRun` call with `runChat` using the
      app's orchestration deps (mode + router)
    - _Requirements: 3.1, 3.7_

- [x] 7. Cross-cutting redaction and integration coverage
  - [x] 7.1 Write property test for end-to-end secret redaction
    - **Property 2: No API key appears in any event, trace, error, response, or snapshot**
    - **Validates: Requirements 1.3, 2.3, 4.4**
    - Add `tests/byokRedaction.test.ts`; inject arbitrary key-like secrets via env/provider options,
      drive the external path and connection test with mocked provider/fetch, then assert the secret
      substring is absent from every persisted event, the run, the synthesis, the connection-test
      response, and any thrown error message

  - [x] 7.2 Write external-mode end-to-end integration test
    - Drive a full external run through `createApp` with an injected mocked `ModelRouter`/provider
      (planner → skeptic → crucible → DAG → executor → validation → synthesis); assert provider/cost
      metadata on the events and no secret leakage in the HTTP response body (supertest)
    - Add `tests/byokExternalE2E.test.ts`
    - _Requirements: 3.5, 3.6, 3.8_

- [x] 8. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP; they are test sub-tasks.
- `fast-check` is the repo's first property-based testing dependency; all provider/`fetch`
  interactions are mocked so no API key and no real network are needed for `npm test`.
- Each property sub-task references a specific property from the design and the requirements clause it
  validates, placed close to the implementation it checks to catch errors early.
- Checkpoints validate incrementally; the full verification set is `npm test`, `npm run build`,
  `npm run check`, `node scripts/generate-roadmap-issues.js --check`, and
  `node scripts/export-linear-issues.js --check`.
- The local path stays byte-for-byte the current deterministic baseline; external mode differs only
  in the planner step and the recorded provider/cost metadata.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "3.1", "5.1", "6.1"] },
    { "id": 1, "tasks": ["3.2", "2.2", "5.2", "5.3", "6.2"] },
    { "id": 2, "tasks": ["2.3", "2.4", "6.3", "3.3", "5.4"] },
    { "id": 3, "tasks": ["6.6", "3.4", "6.4", "6.5"] },
    { "id": 4, "tasks": ["7.1", "7.2", "3.5"] },
    { "id": 5, "tasks": ["3.6"] },
    { "id": 6, "tasks": ["3.7"] }
  ]
}
```
