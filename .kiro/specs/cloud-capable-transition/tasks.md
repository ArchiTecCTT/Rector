# Implementation Plan: Cloud-Capable Transition

## Overview

This plan completes and connects existing seams to ship the **v0.3.0 configured product**:
`runtime-settings.json` as source of truth, mandatory uncloseable onboarding, single orchestration path
(`runOrchestratedChatRun`), and spy-only CI (`SpyLLMProvider`). The legacy local/external product
model is deprecated — not preserved as the user-facing default. Work proceeds bottom-up: extend the
provider config model, build the boot-tolerant config resolver, harden discovery, wire the
Settings_API and routing, replace the sandbox stub with a real E2B adapter, gate the synthesizer,
complete TiDB persistence, enforce configured-product and spy-CI invariants (Req 9), and confirm
universal redaction. Each correctness property from the design is implemented by a single
property-based test (`fast-check`, ≥100 iterations) placed next to the code it validates, using
injectable seams (`fetchImpl`, `fsImpl`, `clock`, `commandRunner`, `clientFactory`, `SpyLLMProvider`)
so tests stay hermetic with zero real network calls.

The implementation language is **TypeScript** (existing Vitest/`fast-check` stack).

## Tasks

- [x] 1. Extend the provider configuration data model
  - [x] 1.1 Add the `Manual_Model_List` field to the provider config schema
    - Add `manualModels: z.array(z.string().min(1)).optional()` to `ProviderConfigRecordSchema` in `src/providers/config.ts`
    - Confirm `models.flagship` / `models.slm` and `ActiveRouteMapSchema` can reference a `manualModels` identifier
    - Keep the field non-secret; no secret material is ever added to the record shape
    - _Requirements: 3.3, 3.8_
  - [x] 1.2 Write property test for manual-list route designation
    - **Property 15: Any manual-list identifier is designable as a route model**
    - **Validates: Requirements 3.8**

- [x] 2. Boot-tolerant orchestration config resolution
  - [x] 2.1 Implement `resolveOrchestrationConfig` and provider descriptors
    - Add the async, store-aware resolver (new `src/providers/orchestrationConfig.ts`) that awaits the `Provider_Config_Store` + `Secret_Store` (presence-only via `hasSecret`)
    - Compute `configuredProviders` as the union of env-satisfied providers and store-satisfied records
    - Resolve unset/empty/whitespace `ORCHESTRATOR_MODE` to `local`; throw `OrchestrationConfigError` only for a non-empty value that is not exactly `local`/`external`
    - Treat a store read failure as absent credentials, emit a redacted error, and continue
    - Define the per-kind provider descriptor table (required env-key names + required secret refs)
    - Retain the existing synchronous env-only parser for pure-env callers/tests
    - _Requirements: 1.1, 1.2, 1.3, 1.6, 1.8, 9.5_
  - [x] 2.2 Write property test for configured-provider resolution
    - **Property 1: Configured-provider resolution is the union of env and stores**
    - **Validates: Requirements 1.1, 1.2, 1.3**
  - [x] 2.3 Write property test for default-local mode resolution
    - **Property 2: Empty or whitespace mode resolves to local**
    - **Validates: Requirements 9.5**
  - [x] 2.4 Write property test for invalid-mode halt
    - **Property 3: An invalid mode value halts startup with a redacted, named error**
    - **Validates: Requirements 1.6**
  - [x] 2.5 Wire the boot sequence in `src/bin/server.ts`
    - Call `resolveOrchestrationConfig` on the live path; hard-exit (non-zero) only on `MODE_INVALID` with a redacted error naming `local`/`external`
    - On external mode with zero configured providers, emit a redacted warning naming each provider's required env keys, then bind + listen (do not exit)
    - _Requirements: 1.4, 1.5, 1.6, 1.7, 1.8_
  - [x] 2.6 Write property test for the startup warning
    - **Property 4: The startup warning names env keys and leaks no secret**
    - **Validates: Requirements 1.7**
  - [x] 2.7 Write unit tests for boot wiring
    - External + no providers warns and serves (no exit); store-read failure continues startup
    - _Requirements: 1.4, 1.5, 1.8_

- [x] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Harden the Model_Discovery_Service dispatch and timeout
  - [x] 4.1 Confirm per-kind dispatch and the 30s abort
    - In `src/providers/discovery/service.ts` confirm `adapters[record.kind]` dispatch returns the adapter result
    - Wrap each adapter catalog call with an `AbortController` + 30 000 ms timer; classify an unanswered request
    - _Requirements: 2.1, 2.9_
  - [x] 4.2 Write property test for discovery dispatch
    - **Property 5: Discovery dispatch returns the mapped adapter's result**
    - **Validates: Requirements 2.1**

- [x] 5. Complete and harden the Discovery_Adapters
  - [x] 5.1 Confirm Together native/fallback request logic
    - In `src/providers/discovery/adapters/together.ts` request `GET {baseUrl}/models`, fall back to `/v1/models` only on HTTP 404
    - _Requirements: 2.2_
  - [x] 5.2 Write property test for the Together fallback
    - **Property 6: Together falls back to /v1/models only on HTTP 404**
    - **Validates: Requirements 2.2**
  - [x] 5.3 Implement the Cloudflare task filter
    - In `src/providers/discovery/adapters/cloudflare.ts` retain only entries whose task is exactly `text-generation`, `chat`, or `embeddings`
    - _Requirements: 2.3_
  - [x] 5.4 Write property test for the Cloudflare task filter
    - **Property 7: Cloudflare retains only allowed-task entries**
    - **Validates: Requirements 2.3**
  - [x] 5.5 Confirm Azure deployment classification
    - In `src/providers/discovery/adapters/azure.ts` set `requiresDeployment: true` and emit no deployment id on every candidate; return `requires_management_plane` for a deployment-enumeration request
    - _Requirements: 2.4, 2.5_
  - [x] 5.6 Write property test for Azure candidates
    - **Property 8: Azure candidates require deployment and omit deployment ids**
    - **Validates: Requirements 2.4**
  - [x] 5.7 Write unit test for Azure management-plane error
    - A deployment-enumeration request returns a `requires_management_plane` Discovery_Error
    - _Requirements: 2.5_
  - [x] 5.8 Implement OpenAI-compatible discovery with manual-model fallback
    - In `src/providers/discovery/adapters/openaiCompatible.ts` attempt `GET {baseUrl}/v1/models` first; on failure/timeout/non-OK/empty build candidates from `manualModels` when present, else return a classified error
    - Emit exactly one schema-valid Model_Candidate per manual identifier (with matching model id)
    - _Requirements: 2.6, 3.4, 3.5, 3.6, 3.7_
  - [x] 5.9 Write property test for the manual-model fallback
    - **Property 12: Manual-model fallback builds one valid candidate per identifier**
    - **Validates: Requirements 3.5, 3.6**
  - [x] 5.10 Write unit test for the OpenAI-compatible request shape
    - Confirms the exact `GET {baseUrl}/v1/models` request is issued first
    - _Requirements: 2.6_
  - [x] 5.11 Confirm shared normalization and error classification
    - Normalize each retained entry against `ModelCandidateSchema`, dropping invalid entries and continuing; treat empty-after-filter as success
    - Classify absent credential as `auth_invalid`, absent endpoint/account coordinate as `endpoint_invalid`; never throw on transport/HTTP/payload failure; route every error message through `redactString`
    - _Requirements: 2.7, 2.8, 2.10, 2.11, 2.12, 2.13, 2.14_
  - [x] 5.12 Write property test for normalization
    - **Property 9: Normalization keeps exactly the schema-valid entries**
    - **Validates: Requirements 2.7, 2.8**
  - [x] 5.13 Write property test for classified coordinate errors
    - **Property 10: Missing required coordinates produce the correct classified error**
    - **Validates: Requirements 2.10, 2.11**
  - [x] 5.14 Write property test for non-throwing classification
    - **Property 11: Adapters never throw and always classify failures**
    - **Validates: Requirements 2.12**

- [x] 6. Settings_API discovery endpoint and provider validation
  - [x] 6.1 Add the discovery route to the Settings_API
    - In `src/api/server.ts` add the provider discovery endpoint: invoke `ModelDiscoveryService` for a configured provider, return candidates or relay a classified error without throwing
    - Return `not_found` for an unknown provider; race the call against a 30 000 ms timer returning a `timeout` error on expiry
    - In local mode return a `Discovery_Error` indicating discovery is unavailable without invoking the service or any network call
    - Send the response through `sendRedacted` / `redactOutbound`
    - _Requirements: 4.1, 4.2, 4.4, 4.5, 4.6, 4.7_
  - [x] 6.2 Write property test for unknown-provider handling
    - **Property 16: An unknown provider id yields not_found**
    - **Validates: Requirements 4.2**
  - [x] 6.3 Write property test for error relay
    - **Property 17: The Settings_API relays any Discovery_Error category without throwing**
    - **Validates: Requirements 4.5**
  - [x] 6.4 Write unit test for local-mode inertness
    - A discovery request in local mode returns the "unavailable in local mode" error with no service call
    - _Requirements: 4.3, 4.7_
  - [x] 6.5 Add Provider_Label validation and manual-model persistence
    - In `src/api/server.ts` reject an `openai-compatible` record whose label is missing/empty/whitespace with a validation error and persist nothing
    - Persist a non-empty label and the `manualModels` list as non-secret config
    - _Requirements: 3.1, 3.2, 3.3_
  - [x] 6.6 Write property test for label validation
    - **Property 13: Provider_Label validation persists valid labels and rejects blank ones**
    - **Validates: Requirements 3.1, 3.2**
  - [x] 6.7 Write property test for manual-list round-trip
    - **Property 14: Manual_Model_List round-trips with no secret in the record**
    - **Validates: Requirements 3.3**

- [x] 7. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Confirm provider routing in external mode
  - [x] 8.1 Confirm `buildConfiguredRouter` routing and fallback
    - In `src/providers/configBridge.ts` confirm per-record routing for all kinds with network enabled, capability-priority fallback that never fails the run, and a secret-free substitution marker recorded in the run trace
    - Refuse to construct external providers in local mode
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_
  - [x] 8.2 Write property test for external network construction
    - **Property 18: External selection constructs providers with network enabled**
    - **Validates: Requirements 5.1**
  - [x] 8.3 Write property test for valid designated routing
    - **Property 19: A valid designated route resolves to that provider and model**
    - **Validates: Requirements 5.2, 5.3**
  - [x] 8.4 Write property test for fallback substitution
    - **Property 20: An invalid designation falls back and records a secret-free substitution**
    - **Validates: Requirements 5.4, 5.5**

- [x] 9. Real E2B sandbox command execution
  - [x] 9.1 Implement `createE2BSandboxAdapter`
    - Add `src/sandbox/e2bSandboxAdapter.ts` implementing the `SandboxAdapter` contract; reuse the `WorkspaceSandboxAdapter` policy gates (allowlist, destructive denylist, approval gates, path containment) before any container call
    - Apply the pipeline: policy gates first → lazy client init from the Secret_Store key → run command → apply patch → capture exit/stdout/stderr → truncate each stream to `MAX_CAPTURED_STREAM_BYTES` with a truncation indicator → redact streams and artifacts
    - Return a redacted failure result and spawn no process on client-init failure; leave the target file unchanged on patch-apply failure; accept an injectable `clientFactory`
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.8, 6.9, 6.10_
  - [x] 9.2 Wire the adapter selection in `src/bin/server.ts`
    - Construct the E2B adapter only in external mode; in local mode construct the network-free local runner and initialize no E2B client
    - _Requirements: 6.7_
  - [x] 9.3 Write property test for stream capture and truncation
    - **Property 21: Captured streams are recorded, truncated to the cap, and flagged**
    - **Validates: Requirements 6.4, 6.5**
  - [x] 9.4 Write property test for denied operations
    - **Property 22: Denied operations never spawn a container process**
    - **Validates: Requirements 6.6**
  - [x] 9.5 Write unit tests for the container happy path and failure modes
    - Approved RUN_COMMAND executes and PROPOSE_PATCH applies via the injected client; client-init failure and patch-apply failure return redacted failure results
    - _Requirements: 6.1, 6.2, 6.3, 6.9, 6.10_

- [x] 10. Synthesizer gating for heavy developer routes
  - [x] 10.1 Implement the live/legacy gating decision
    - In `src/orchestration/synthesizer.ts` add `shouldRunLiveSynthesizer` (external + Heavy_Developer_Route + valid flagship) selecting between `runLiveSynthesizer` and the deterministic Legacy_Status_Response
    - Build the prompt from triage intent, compiled DAG, node logs, validation outcomes, and diffs, omitting absent inputs; cap the answer at 2000 chars and reference the trace drawer; add the max-length refinement and reject empty/unparseable/over-length answers
    - Race the live call against a 60 000 ms deadline; on budget denial, failure, invalid answer, or timeout return the Legacy_Status_Response; report `providerCalls === 0` when the gate is closed; redact the answer text and citations
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7_
  - [x] 10.2 Write property test for the narrative request gate
    - **Property 23: A heavy route with a valid flagship requests a Narrative_Answer**
    - **Validates: Requirements 7.1**
  - [x] 10.3 Write property test for prompt assembly
    - **Property 24: The narrative prompt includes present inputs and omits absent ones without failing**
    - **Validates: Requirements 7.2**
  - [x] 10.4 Write property test for the bounded answer
    - **Property 25: An accepted Narrative_Answer is bounded and references the trace drawer**
    - **Validates: Requirements 7.3**
  - [x] 10.5 Write property test for narrative validation
    - **Property 26: Narrative validation rejects empty, unparseable, or over-length answers**
    - **Validates: Requirements 7.7**
  - [x] 10.6 Write property test for the failure-mode fallback
    - **Property 27: Synthesizer failure modes yield the Legacy_Status_Response**
    - **Validates: Requirements 7.4**
  - [x] 10.7 Write property test for local-mode synthesis
    - **Property 28: Local-mode synthesis is deterministic with zero provider calls**
    - **Validates: Requirements 7.5, 9.4**

- [x] 11. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. TiDB Cloud relational persistence
  - [x] 12.1 Add connection pooling and field validation
    - In `src/store/tidbRectorStore.ts` upgrade `createTiDBDriver` to a pooled MySQL-wire client behind the synchronous `SqlDriver` contract
    - Confirm `createRectorStore` throws `StoreConfigError` naming the missing host/port/database/user/password before any connection; the `memory` driver opens no connection
    - _Requirements: 8.1, 8.2, 8.3, 8.6_
  - [x] 12.2 Implement the Startup_Migration step
    - In `src/store/index.ts` add a boot-time verify/provision of the `conversations`, `messages`, `runs`, `run_events`, `artifacts` tables before serving any request
    - Race connect + provision against a 30 000 ms deadline; on timeout or provision failure halt startup with a redacted persistence error and serve nothing
    - _Requirements: 8.4, 8.8_
  - [x] 12.3 Write property test for incomplete TiDB config
    - **Property 29: Incomplete TiDB config errors naming the missing fields before any connection**
    - **Validates: Requirements 8.2**
  - [x] 12.4 Write property test for the entity round-trip
    - **Property 30: Entity write-then-read round-trip is deep-equal**
    - **Validates: Requirements 8.5**
  - [x] 12.5 Write integration test for the pooled driver and migration
    - Construct the TiDB_Store over an injected pooled driver and exercise the verify/provision sequence
    - _Requirements: 8.1, 8.4_

- [x] 13. Local-mode baseline invariants
  - [x] 13.1 Enforce the mode gate across all collaborators
    - In `src/bin/server.ts` and the affected modules ensure local mode performs zero outbound provider calls, runs no external sandbox container, never consults the Config_Bridge, and blocks any attempted outbound call leaving persisted state unchanged
    - Use counting-double seams so the "ran 0 times" invariants are observable
    - _Requirements: 9.1, 9.2, 9.3, 9.6_
  - [x] 13.2 Write property test for zero provider network calls
    - **Property 31: Local mode performs zero outbound provider network calls**
    - **Validates: Requirements 9.1, 2.15, 4.3**
  - [x] 13.3 Write property test for zero external sandbox execution
    - **Property 32: Local mode performs no external sandbox execution**
    - **Validates: Requirements 9.2, 6.7**
  - [x] 13.4 Write property test for Config_Bridge bypass
    - **Property 33: Local mode never consults the Config_Bridge and selects the provider-free fallback**
    - **Validates: Requirements 9.3, 5.6**
  - [x] 13.5 Write property test for blocked-attempt state preservation
    - **Property 34: A blocked local outbound attempt leaves persisted state unchanged**
    - **Validates: Requirements 9.6**
  - [x] 13.6 Write property test for local-mode determinism
    - **Property 35: Local-mode runs are deterministic**
    - **Validates: Requirements 9.7**

- [x] 14. Universal redaction coverage across logs and telemetry
  - [x] 14.1 Route every new sink through the Redaction_Layer
    - Ensure startup warnings, discovery errors, the Settings_API discovery response, sandbox stream/artifact capture, synthesizer answers/citations, and TiDB error messages all pass through `redactString` / `redactSecrets` / `redactOutbound` before the sink
    - On redaction failure, suppress the raw value and emit the fixed redaction-failed placeholder
    - _Requirements: 10.1, 10.6, 2.13, 4.4, 6.8, 7.6, 8.7_
  - [x] 14.2 Write property test for redaction-before-sink
    - **Property 36: Every log/telemetry write is redacted before the sink**
    - **Validates: Requirements 10.1**
  - [x] 14.3 Write property test for the fixed placeholder
    - **Property 37: Redaction uses a single fixed placeholder sharing no original character**
    - **Validates: Requirements 10.2**
  - [x] 14.4 Write property test for no-secret-substring
    - **Property 38: Redacted output contains no secret substring**
    - **Validates: Requirements 10.3, 2.13, 4.4, 6.8, 7.6, 8.7**
  - [x] 14.5 Write property test for authorization-scheme redaction
    - **Property 39: Authorization-scheme redaction retains the scheme and replaces the token**
    - **Validates: Requirements 10.4**
  - [x] 14.6 Write property test for connection-URL redaction
    - **Property 40: Connection-URL redaction replaces userinfo and retains other components**
    - **Validates: Requirements 10.5**
  - [x] 14.7 Write unit test for redaction-failure suppression
    - A value whose redaction throws is suppressed and replaced with the fixed redaction-failed placeholder
    - _Requirements: 10.6_

- [x] 15. Optional dependency strategy and build/test verification
  - [x] 15.1 Lazy-load optional cloud clients with clear absence errors
    - Keep `sync-mysql` and the E2B client behind dynamic `createRequire` loads; when a selected path's dependency is absent, throw a clear error naming the missing package
    - _Requirements: 11.5_
  - [x] 15.2 Write unit tests for missing-dependency errors
    - Selecting the `tidb` driver without `sync-mysql`, or an E2B sandbox without the E2B client, emits the actionable missing-dependency error
    - _Requirements: 11.5_
  - [x] 15.3 Write build/smoke verification tests
    - `npm run build` and `npm test` exit zero; the build succeeds with the optional cloud deps absent; the MySQL-dialect DDL is emitted for all five tables; the local + memory server boots and serves with optional deps absent
    - _Requirements: 11.1, 11.2, 11.3, 11.4_

- [x] 16. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core
  implementation sub-tasks are never optional.
- Each task references specific requirements for traceability, and each correctness property is
  implemented by a single `fast-check` property test (≥100 iterations) tagged
  `Feature: cloud-capable-transition, Property {number}: {property_text}`.
- Network, filesystem, clock, sandbox-client, and provider boundaries are injected with deterministic
  counting doubles so property tests are hermetic and the zero-network / zero-sandbox invariants are
  directly observable.
- Checkpoints provide incremental validation; the only hard-exit paths are an invalid
  `ORCHESTRATOR_MODE` value and a TiDB persistence-initialization failure under the `tidb` driver.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "4.1", "5.1", "5.3", "5.5", "5.8", "5.11", "8.1", "9.1", "10.1", "12.1"] },
    { "id": 1, "tasks": ["2.5", "6.5", "12.2", "15.1", "1.2", "4.2", "5.2", "5.4", "5.6", "5.7", "5.9", "5.10", "5.12", "5.13", "5.14", "8.2", "8.3", "8.4", "9.3", "9.4", "9.5", "10.2", "10.3", "10.4", "10.5", "10.6", "10.7", "12.3", "12.4", "12.5", "2.2", "2.3", "2.4", "2.6"] },
    { "id": 2, "tasks": ["9.2", "6.1", "2.7"] },
    { "id": 3, "tasks": ["13.1", "6.2", "6.3", "6.4", "6.6", "6.7"] },
    { "id": 4, "tasks": ["14.1", "13.2", "13.3", "13.4", "13.5", "13.6"] },
    { "id": 5, "tasks": ["14.2", "14.3", "14.4", "14.5", "14.6", "14.7", "15.2", "15.3"] }
  ]
}
```
