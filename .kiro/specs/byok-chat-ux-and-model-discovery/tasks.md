# Implementation Plan: BYOK Chat UX and Model Discovery (ORN-56 → ORN-61)

## Overview

This plan implements the effort in TypeScript (the language used throughout the design: Zod
schemas, Vitest, and `fast-check` 4.x), building incrementally so each step wires into prior work
with no orphaned code. It is sequenced as: shared type foundations → route-aware chat reply path
(Areas A/B) → discovery subsystem (Area C: cache, adapters, service, API) → setup UI probe + model
picker (Area D) → regional-discovery docs and scaffold (Area E) → final verification.

All 17 correctness properties from the design are implemented as `fast-check` property-based tests
(one test per property, minimum 100 iterations), placed close to the code they validate. Every
adapter, probe, and provider call is exercised against a mocked `fetch` or mocked provider so the
suite stays hermetic. Local_Mode behavior for every route other than `NEEDS_CLARIFICATION` and
`DIRECT_ANSWER` is preserved byte-for-byte.

## Tasks

- [x] 1. Discovery and probe type foundations
  - [x] 1.1 Define discovery schemas in `src/providers/discovery/types.ts`
    - Implement `ModelCandidateScopeSchema`, `ModelLifecycleSchema`, and `ModelCandidateSchema` with required and optional fields and `z.infer` types
    - Implement `DiscoveryErrorCategorySchema`, `DiscoveryErrorSchema`, and the `DiscoveryResultSchema` discriminated union
    - Export `ModelCandidate`, `DiscoveryError`, and `DiscoveryResult` types
    - _Requirements: 10.4, 11.1, 11.2, 11.3, 11.4, 11.5, 17.1, 18.1_

  - [x] 1.2 Define `ProbeErrorCategory` schema in `src/providers/probe.ts`
    - Implement `ProbeErrorCategorySchema` enum and `ProbeErrorCategory` / `ProbeResult` types
    - _Requirements: 23.1, 23.2_

- [x] 2. Route-aware synthesizer reply builders (Area A / B)
  - [x] 2.1 Make `synthesizeChatBrainstemResponse` route-aware in `src/orchestration/synthesizer.ts`
    - Add `selectResponseText` switching on `input.triage.route` while leaving `status`, `route`, `traceId`, `evidence`, and `observability` unchanged
    - Implement pure `buildClarificationResponse` (≤ 3 sentences, derives missing-detail hint or uses fixed default text, excludes internal-prose substrings)
    - Implement pure `buildDeterministicDirectAnswer` (≤ 6 sentences, deterministic, no provider content)
    - Keep `legacyStatusResponse` as the existing path for all other routes, byte-for-byte
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4, 5.1, 5.2, 5.3, 6.1, 6.2, 6.3, 27.3_

  - [x] 2.2 Write property test for clarification replies
    - **Property 1: Clarification replies carry no internal prose and stay short**
    - **Validates: Requirements 1.1, 1.4, 2.1, 2.2, 2.3, 2.4, 3.3**

  - [x] 2.3 Write property test for direct-answer replies
    - **Property 2: Direct answers carry no internal prose and stay bounded**
    - **Validates: Requirements 5.1, 5.2, 5.3**

  - [x] 2.4 Write property test for Local_Mode determinism
    - **Property 3: Local_Mode replies are deterministic and provider-free**
    - **Validates: Requirements 6.1, 6.2, 6.3, 27.2**

  - [x] 2.5 Write property test for non-target route preservation
    - **Property 4: Non-target routes preserve legacy output**
    - **Validates: Requirements 27.3**

  - [x] 2.6 Write unit tests for clarification phrasing
    - Test the fixed default clarification text and the missing-detail phrasing branch
    - _Requirements: 1.2, 1.3_

- [x] 3. Triage routing for vague input (Area A)
  - [x] 3.1 Route empty/whitespace and vague greetings to `NEEDS_CLARIFICATION` in `src/orchestration/triage.ts`
    - Ensure empty/whitespace-only messages classify as `NEEDS_CLARIFICATION`
    - Ensure vague greetings ("Hello", "hi", "What's up") classify as `NEEDS_CLARIFICATION`
    - _Requirements: 3.1, 3.2_

  - [x] 3.2 Write property test for whitespace-only input
    - **Property 5: Empty or whitespace input routes to clarification**
    - **Validates: Requirements 3.2**

  - [x] 3.3 Write unit test for greeting-set routing
    - Test the explicit greeting set maps to `NEEDS_CLARIFICATION`
    - _Requirements: 3.1_

- [x] 4. External-mode live direct answer and trace recording (Area B)
  - [x] 4.1 Implement `runLiveDirectAnswer` in `src/orchestration/liveDirectAnswer.ts`
    - Mirror `runLiveSynthesizer` discipline: budget preflight before any call, invoke, validate, redact, fallback
    - Return deterministic local text with `providerCalls === 0` on missing provider, budget denial, or provider error, tagging `fallback` reason
    - Route the assembled message through `redactOutbound` so raw provider error text and secrets never appear
    - _Requirements: 7.1, 7.2, 7.3, 8.1, 8.2, 8.3_

  - [x] 4.2 Wire `runLiveDirectAnswer` and event recording into `src/orchestration/chatRunner.ts`
    - Invoke `runLiveDirectAnswer` only for the `DIRECT_ANSWER` route in External_Mode
    - Record route, run id, provider call attempt, accumulated cost, and fallback status via existing `runEvent` / `buildProviderCallMetadata` / `addProviderUsageToRun` helpers
    - Record route, run id, trace id, and phase events for `NEEDS_CLARIFICATION` turns; keep Local_Mode provider/network calls at zero
    - _Requirements: 4.1, 8.4, 9.1, 9.2, 9.3, 27.1, 27.2_

  - [x] 4.3 Write property test for external direct-answer fallback
    - **Property 6: Direct-answer external failures fall back to deterministic local text**
    - **Validates: Requirements 7.3, 8.1, 8.2**

  - [x] 4.4 Write unit tests for direct-answer and clarification event recording
    - Test recorded route/provider/cost/fallback fields on direct-answer turns and recorded route/run/trace on clarification turns
    - _Requirements: 4.1, 8.4, 9.1, 9.2, 9.3_

- [x] 5. Checkpoint — chat UX path
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Discovery cache and invalidation (Area C)
  - [x] 6.1 Implement `DiscoveryCache` in `src/providers/discovery/cache.ts`
    - Implement in-memory per-provider `get`/`set`/`invalidate` with `SUCCESS_TTL_MS` and `ERROR_TTL_MS` (strictly shorter for error/empty results)
    - _Requirements: 16.1, 16.2, 16.4_

  - [x] 6.2 Wire cache invalidation into `src/providers/configStore.ts`
    - Evict a provider's cache entry on `upsertProvider`, `removeProvider`, `setActiveRoute`, and any secret write for that provider id
    - _Requirements: 16.3_

  - [x] 6.3 Write property test for cache behavior
    - **Property 13: Cache serves within TTL, invalidates on change, and refresh bypasses**
    - **Validates: Requirements 16.1, 16.2, 16.3, 16.4, 17.2**

- [x] 7. Discovery adapters (Area C)
  - [x] 7.1 Implement adapter registry, context, and normalizer in `src/providers/discovery/adapters/index.ts`
    - Define `DiscoveryAdapter`, `AdapterContext`, `AdapterResult`, and `DiscoveryAdapterRegistry`
    - Implement the shared normalizer that maps raw entries into `ModelCandidate` defensively (never throws on missing optional fields)
    - _Requirements: 10.2, 10.4, 11.1, 11.2, 11.3, 14.2_

  - [x] 7.2 Implement the Cloudflare adapter in `src/providers/discovery/adapters/cloudflare.ts`
    - Request `GET /accounts/{account_id}/ai/models/search`; filter defaults to text-generation/chat/embedding; honor `includeDeprecated`
    - Return classified `DiscoveryError` on failure rather than throwing
    - _Requirements: 12.1, 12.2, 12.3, 12.4_

  - [x] 7.3 Implement the Together adapter in `src/providers/discovery/adapters/together.ts`
    - Request native `GET /models`, falling back to `GET /v1/models`; do not depend on a Responses API
    - _Requirements: 13.1, 13.2, 13.3_

  - [x] 7.4 Implement the OpenAI-compatible adapter in `src/providers/discovery/adapters/openaiCompatible.ts`
    - Request `GET /v1/models`; normalize entries with omitted optional fields; return a classified error for an unrecognizable list
    - _Requirements: 14.1, 14.2, 14.3_

  - [x] 7.5 Implement the Azure adapter in `src/providers/discovery/adapters/azure.ts`
    - Request `{endpoint}/openai/models?api-version=2024-10-21`; set `requiresDeployment: true` and emit no `deploymentId`
    - Report `requires_management_plane` when deployment enumeration is requested
    - _Requirements: 15.1, 15.2, 15.3, 15.4_

  - [x] 7.6 Write property test for candidate normalization
    - **Property 9: Every adapter entry normalizes to a valid Model_Candidate**
    - **Validates: Requirements 10.4, 11.1, 11.2, 11.3, 11.4, 11.5, 14.2**

  - [x] 7.7 Write property test for Cloudflare filtering
    - **Property 10: Cloudflare default and deprecated filtering**
    - **Validates: Requirements 12.2, 12.3, 12.4**

  - [x] 7.8 Write property test for Azure deployment safety
    - **Property 11: Azure candidates always require a deployment and never expose deployment ids**
    - **Validates: Requirements 15.2, 15.3**

  - [x] 7.9 Write unit tests for adapter request URLs and edge branches
    - Test each adapter's request URL, the Together `/v1/models` fallback, and the Azure management-plane message
    - _Requirements: 12.1, 13.1, 13.2, 14.1, 15.1, 15.4_

- [x] 8. Model discovery service (Area C)
  - [x] 8.1 Implement `createModelDiscoveryService` in `src/providers/discovery/service.ts`
    - Resolve the `ProviderConfigRecord`; short-circuit unknown ids to a `not_found` result with no network call
    - Serve cache hits within TTL; read the secret transiently through `SecretStore`; dispatch by `record.kind`; normalize results; route errors through the `Redaction_Layer`; write success/error TTL entries
    - _Requirements: 10.1, 10.2, 10.3, 16.1, 16.2, 16.4, 18.1, 18.2, 18.3, 18.4_

  - [x] 8.2 Write property test for adapter dispatch
    - **Property 7: Discovery dispatches to the adapter for the provider kind**
    - **Validates: Requirements 10.2**

  - [x] 8.3 Write property test for unknown-id short-circuit
    - **Property 8: Unknown provider id short-circuits with no network call**
    - **Validates: Requirements 10.3, 17.4**

  - [x] 8.4 Write property test for failure classification
    - **Property 12: Failures yield a classified category, never a raw body**
    - **Validates: Requirements 14.3, 17.3, 18.1, 23.1, 26.2**

- [x] 9. Discovery API endpoints (Area C)
  - [x] 9.1 Add discovery routes in `src/api/server.ts`
    - Implement `GET /api/providers/:id/models` returning candidates + `lastRefreshedAt` or a classified, redacted error, with a redacted not-found (no network) for unknown ids
    - Implement `POST /api/providers/:id/models/refresh` that bypasses and overwrites the cache
    - _Requirements: 17.1, 17.2, 17.3, 17.4_

  - [x] 9.2 Write integration tests for the discovery endpoints
    - Test happy-path, error, and not-found responses for both endpoints with a mocked `fetch`
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 29.1_

- [x] 10. Checkpoint — discovery subsystem
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Connection test and per-model probe (Area D)
  - [x] 11.1 Extend the probe path in `src/providers/configBridge.ts` and the test-connection endpoint
    - Add optional `model` and `deployment` inputs to `resolveTestProvider` / `runConnectionTest` so a single ping targets the selected candidate
    - Implement `classifyProbeError` mapping failures to a `ProbeErrorCategory` and route the returned message through the `Redaction_Layer`
    - _Requirements: 22.1, 22.2, 23.1, 23.2, 23.3_

  - [x] 11.2 Write integration test for the model probe
    - Test the end-to-end `Model_Probe` through the existing connection-test path with a mocked provider
    - _Requirements: 22.1, 22.2, 29.1_

  - [x] 11.3 Write unit test for the probe error category mapping
    - Test the mapping table covering each `ProbeErrorCategory`
    - _Requirements: 23.2_

- [x] 12. Setup UI model picker (Area D)
  - [x] 12.1 Implement the Model_Picker in `src/public/app.js`, `index.html`, and `src/public/styles/`
    - Implement pure `renderCandidate` markup (capability tags, lifecycle with deprecated indicator, context/pricing when present, region/deployment note when required)
    - Wire Discover/Refresh controls to the Discovery_API and render `lastRefreshedAt`; show a redacted error while keeping manual entry on failure
    - Add `flagship`/`slm` role selectors with always-available manual override; verified/unverified save flow gated by a warning; represent secret presence as a boolean only; render the Azure deployment-name explanation
    - _Requirements: 19.1, 19.2, 19.3, 19.4, 20.1, 20.2, 20.3, 20.4, 21.1, 21.2, 21.3, 22.3, 22.4, 22.5, 24.1, 24.2, 24.3_

  - [x] 12.2 Write property test for rendered candidate detail
    - **Property 16: Rendered candidates include their present detail**
    - **Validates: Requirements 20.1, 20.2, 20.3, 20.4**

  - [x] 12.3 Write property test for secret-presence boolean
    - **Property 17: Secret presence is exposed only as a boolean**
    - **Validates: Requirements 24.3**

  - [x] 12.4 Write UI/DOM tests for picker behavior
    - Test Discover/Refresh + rendered `lastRefreshedAt`, role override retained with no candidates, verified/unverified save warning gate, and the Azure deployment explanation
    - _Requirements: 19.1, 19.2, 19.3, 19.4, 21.1, 21.2, 21.3, 22.3, 22.4, 22.5, 24.2_

- [x] 13. Cross-cutting secret-safety property tests
  - [x] 13.1 Write property test for secret redaction across boundaries
    - **Property 14: No secret value crosses any boundary**
    - **Validates: Requirements 8.3, 18.2, 18.3, 23.3, 24.1, 28.1, 28.3**

  - [x] 13.2 Write property test for config-record secret reference
    - **Property 15: Config records hold a reference, never a secret value**
    - **Validates: Requirements 18.4, 28.2**

- [x] 14. Regional discovery documentation and scaffold (Area E)
  - [x] 14.1 Write `docs/architecture/regional-discovery.md`
    - Document the Azure data-plane vs management-plane distinction and required management-plane fields; record AWS Bedrock notes (`ListFoundationModels`, `GetFoundationModelAvailability`, inference-profile routing); record the data-residency/IAM warning and the separate-adapter note
    - _Requirements: 25.1, 25.2, 25.3, 25.4, 25.5_

  - [x] 14.2 Add the optional regional adapter scaffold in `src/providers/discovery/adapters/regional.ts`
    - Provide a mockable scaffold whose runtime code distinguishes invalid-key from region/deployment/model-unavailability failures, calling only injected (mockable) cloud APIs and not blocking the foundation
    - _Requirements: 26.1, 26.2, 26.3_

  - [x] 14.3 Write smoke test for the regional-discovery documentation
    - Assert the doc contains the required Azure fields, Bedrock notes, data-residency/IAM warning, and separate-adapter note
    - _Requirements: 25.1, 25.2, 25.3, 25.4, 25.5_

- [x] 15. Final checkpoint and verification gates
  - Run `npm test` and `npm run build`; confirm the suite stays hermetic (mocked `fetch`/providers, no live calls) and snapshots/fixtures are scrubbed of secrets; preserve the baseline lower bound of 106 test files and 951 passing tests
  - Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 28.4, 29.1, 29.2, 29.3, 30.1, 30.2, 30.3_

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core
  implementation sub-tasks are never optional.
- Each task references specific requirement sub-clauses for traceability.
- Each of the 17 correctness properties is implemented by exactly one `fast-check` property-based
  test running a minimum of 100 iterations, tagged
  `Feature: byok-chat-ux-and-model-discovery, Property {number}: {property_text}`.
- Property tests are placed close to the code they validate to catch errors early; UI wiring, API
  wiring, documentation, and CI gates are covered by example, integration, UI/DOM, and smoke tests.
- Checkpoints provide incremental validation at the end of the chat UX path, the discovery
  subsystem, and the full effort.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "2.1", "3.1", "6.1", "14.1"] },
    { "id": 1, "tasks": ["2.2", "2.3", "2.4", "2.5", "2.6", "3.2", "3.3", "4.1", "6.2", "6.3", "7.1"] },
    { "id": 2, "tasks": ["4.2", "7.2", "7.3", "7.4", "7.5", "14.2"] },
    { "id": 3, "tasks": ["4.3", "4.4", "7.6", "7.7", "7.8", "7.9", "8.1"] },
    { "id": 4, "tasks": ["8.2", "8.3", "8.4", "9.1"] },
    { "id": 5, "tasks": ["9.2", "11.1"] },
    { "id": 6, "tasks": ["11.2", "11.3", "12.1"] },
    { "id": 7, "tasks": ["12.2", "12.3", "12.4", "13.1", "13.2", "14.3"] }
  ]
}
```
