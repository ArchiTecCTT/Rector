# Requirements Document

## Introduction

This effort (parent Linear issue **ORN-56**, "BYOK chat UX and model discovery") improves two
distinct surfaces of Rector while preserving the provider-free local mode as the default and
regression baseline:

1. **Chat experience (ORN-57, ORN-58).** Replace the internal trace/status prose that currently
   leaks into the user-facing chat answer for the `NEEDS_CLARIFICATION` and `DIRECT_ANSWER` routes
   with short, natural, helpful responses. Vague messages get a friendly clarification ask; simple
   queries get a lightweight direct answer. Local mode stays deterministic; external/BYOK mode may
   use a cheap model when configured and within budget, always falling back to deterministic local
   text on failure, missing provider, or budget denial. All internal detail remains available
   through the trace/event endpoints and the expandable trace UI.

2. **Model discovery and selection (ORN-59, ORN-60, ORN-61).** Add a backend Model_Discovery_Service
   that enumerates available models for configured BYOK providers through provider-specific
   discovery adapters behind one service interface, normalizes results into a single candidate
   shape, and caches them with TTL and invalidation. Add a setup UI model picker that lets users
   discover, inspect, select, and probe candidate models per role before saving an active route.
   Document and scaffold the follow-up needed for cloud-provider regional discovery (Azure
   management-plane and AWS Bedrock) where an endpoint plus API key is insufficient.

These five child issues group into five requirement areas (A–E) below, followed by cross-cutting
non-functional requirements (Area F). Dependencies: ORN-57 and ORN-58 are independent
UX/orchestration changes; ORN-59 is the foundational discovery API; ORN-60 depends on ORN-59;
ORN-61 depends on ORN-59 and is primarily documentation and scaffolding.

Carried constraints from the existing architecture: provider-free **Local_Mode** remains the default
and the regression baseline; the automated test suite makes no live provider, network, or cloud
calls (every `fetch`/cloud API is mocked); secrets are never stored, logged, returned, or displayed
in any boundary; `npm test` and `npm run build` must continue to pass.

## Glossary

- **Rector**: The local-first, Bring-Your-Own-Key (BYOK) neuro-symbolic AI coding/orchestration agent that is the subject of this effort.
- **Triage**: The deterministic classifier (`src/orchestration/triage.ts`) that maps a user message to a Triage_Route.
- **Triage_Route**: The route a message is classified into: one of `DIRECT_ANSWER`, `PLAN_ONLY`, `CODE_EDIT`, `RESEARCH`, `LONG_RUNNING`, or `NEEDS_CLARIFICATION`.
- **NEEDS_CLARIFICATION**: The Triage_Route assigned to vague or under-specified messages that lack enough detail to route safely.
- **DIRECT_ANSWER**: The Triage_Route assigned to simple, self-contained queries that can be answered without orchestration.
- **Main_Assistant_Message**: The single assistant chat message persisted and returned for a user message (`assistantMessage.content`) and rendered as the primary chat reply in the UI.
- **Synthesizer**: The component (`src/orchestration/synthesizer.ts`) that produces the Main_Assistant_Message from run state, in both a deterministic form and a live provider-backed form.
- **Chat_Runner**: The dispatcher (`src/orchestration/chatRunner.ts`) that runs a chat turn in Local_Mode or External_Mode and records run, trace, provider call, cost, and fallback metadata.
- **Clarification_Response**: A short, natural, helpful Main_Assistant_Message produced for the `NEEDS_CLARIFICATION` route that asks the user for the missing task details.
- **Direct_Answer_Response**: A short, bounded, polite Main_Assistant_Message produced for the `DIRECT_ANSWER` route.
- **Trace_Detail**: Internal run detail — status, route, trace id, evidence, phase events, provider calls, cost, and fallback status — exposed through the Trace_Event_Endpoints and the Trace_Drawer.
- **Trace_Event_Endpoints**: The API endpoints that expose internal run/trace detail: `GET /api/runs/:id/events`, `GET /api/runs/:id/stream`, and `GET /api/runs/:id/cost`.
- **Trace_Drawer**: The expandable trace UI in `src/public/` that displays the run phase timeline, observability stats, cost panel, and run events.
- **Local_Mode**: The provider-free deterministic orchestration mode (`ORCHESTRATOR_MODE=local`) that is the default and the regression baseline.
- **External_Mode**: The BYOK orchestration mode (`ORCHESTRATOR_MODE=external`) that calls live providers through a configured Model_Router.
- **Provider**: A configured model backend. The supported provider kinds are Together AI, Cloudflare Workers AI, Azure OpenAI, and any OpenAI-compatible endpoint.
- **Model_Router**: The router (`src/providers/llm.ts`) that selects a Provider and model for a request, honoring the Active_Route_Map.
- **Budget_Gate**: The pre-flight budget enforcement (`src/security/budget.ts`, `evaluateBudget`/`enforceMaxPerRunBudget`) that allows, requires a decision on, or denies a provider call before it happens.
- **Redaction_Layer**: The secret-scrubbing layer (`src/security/redaction.ts`) applied at every persistence, logging, streaming, API, and UI boundary.
- **Secret_Store**: The encrypted store (`src/security/secretStore.ts`) that holds provider secrets, persists them across restarts, and exposes value-bearing reads only through `getSecret` while exposing presence through `hasSecret`.
- **Provider_Config_Store**: The non-secret configuration store (`src/providers/configStore.ts`, `config.ts`) that persists Provider_Config_Records and the Active_Route_Map, and never holds a secret value.
- **Provider_Config_Record**: A persisted, non-secret entry describing one configured Provider deployment (id, kind, label, base URL, model ids, optional non-secret headers, provider-specific scope, and a `secretRef` — never the secret value).
- **Active_Route_Map**: The per-role mapping (`flagship` and `slm`) that designates which configured Provider serves each model role.
- **Config_Bridge**: The component (`src/providers/configBridge.ts`) that resolves Provider_Config_Records plus their Secret_Store secrets into provider instances for the Model_Router and the Connection_Test_Service.
- **Model_Discovery_Service**: The new backend service interface that enumerates available models for configured Providers by delegating to Discovery_Adapters and normalizing the results.
- **Discovery_Adapter**: A provider-specific implementation that queries one Provider's model catalog and returns normalized Model_Candidates. There is one adapter per provider kind.
- **Model_Candidate**: The normalized, provider-agnostic description of a discoverable model produced by a Discovery_Adapter (shape defined in Requirement 11).
- **Discovery_Cache**: The TTL-bounded cache that stores Model_Discovery_Service results per Provider and is invalidated on provider config, secret, or scope change.
- **Discovery_API**: The API endpoints `GET /api/providers/:id/models` and `POST /api/providers/:id/models/refresh`.
- **Setup_UI**: The browser provider-configuration surface (`src/public/app.js`, `index.html`, `src/public/styles/`) where a user views, enters, tests, and selects Provider configuration.
- **Model_Picker**: The Setup_UI surface that lists discovered Model_Candidates and lets a user select candidates for the `flagship` and `slm` roles.
- **Model_Probe**: A single, cheap, model-or-deployment-aware test invocation run against a selected Model_Candidate to verify it works before saving the active route.
- **Connection_Test_Service**: The existing connection-test path (`/api/setup/test-connection`, `runConnectionTest`) that validates a Provider's credentials with at most one minimal network ping; extended to be model/deployment-aware for the Model_Probe.
- **Probe_Error_Category**: A classified, redacted outcome of a failed Model_Probe (e.g. auth invalid, endpoint invalid, region unsupported, deployment not found, model access missing, quota exceeded, parameter incompatible, content rejected, unknown).
- **Regional_Discovery**: Cloud-provider model discovery that requires more than an endpoint plus API key — specifically Azure management-plane deployment enumeration and AWS Bedrock region-scoped model availability.
- **Verification_Gates**: The required checks: `npm test` and `npm run build`.

## Requirements

### Area A — Friendly Clarification Responses for Vague Chat (ORN-57)

### Requirement 1: Friendly clarification answer for the NEEDS_CLARIFICATION route

**User Story:** As a Rector user sending a vague message, I want a short, natural, helpful reply that asks what I need, so that I am guided toward a usable request instead of reading internal pipeline output.

#### Acceptance Criteria

1. WHEN Triage assigns the `NEEDS_CLARIFICATION` route to a user message, THE Synthesizer SHALL produce a Clarification_Response as the Main_Assistant_Message.
2. THE Clarification_Response SHALL ask the user to provide the missing task details, including the task, repository area, or goal.
3. WHEN no specific missing detail can be derived from the message, THE Synthesizer SHALL use the default Clarification_Response text "What would you like me to help with? Share the task, repo area, or goal, and I'll route it through the right Rector workflow."
4. THE Clarification_Response SHALL be at most 3 sentences.

### Requirement 2: No internal trace prose in the clarification answer

**User Story:** As a Rector user, I want the chat reply to read like a helpful assistant, so that internal status and trace text never appears in my conversation.

#### Acceptance Criteria

1. WHEN the Main_Assistant_Message is produced for the `NEEDS_CLARIFICATION` route, THE Synthesizer SHALL exclude the substring "Status:" from the Main_Assistant_Message.
2. WHEN the Main_Assistant_Message is produced for the `NEEDS_CLARIFICATION` route, THE Synthesizer SHALL exclude the substring "Route: NEEDS_CLARIFICATION" from the Main_Assistant_Message.
3. WHEN the Main_Assistant_Message is produced for the `NEEDS_CLARIFICATION` route, THE Synthesizer SHALL exclude the substring "Trace:" from the Main_Assistant_Message.
4. WHEN the Main_Assistant_Message is produced for the `NEEDS_CLARIFICATION` route, THE Synthesizer SHALL exclude the substring "Evidence:" from the Main_Assistant_Message.

### Requirement 3: Vague greetings route to clarification

**User Story:** As a Rector user who types a greeting, I want a friendly prompt to describe my task, so that I know how to proceed.

#### Acceptance Criteria

1. WHEN a user message consists of a vague greeting such as "Hello", "hi", or "What's up", THE Triage SHALL assign the `NEEDS_CLARIFICATION` route.
2. WHEN a user message is empty or contains only whitespace, THE Triage SHALL assign the `NEEDS_CLARIFICATION` route.
3. WHEN the `NEEDS_CLARIFICATION` route is assigned to a vague greeting, THE Synthesizer SHALL return the Clarification_Response as the Main_Assistant_Message.

### Requirement 4: Internal detail remains available through trace surfaces

**User Story:** As a Rector operator debugging a run, I want the full internal status, route, and evidence to remain available in the trace, so that hiding it from chat does not reduce my visibility.

#### Acceptance Criteria

1. WHEN a chat turn is routed to `NEEDS_CLARIFICATION`, THE Chat_Runner SHALL record the route, run id, trace id, and phase events in the Event_Log.
2. WHEN a client requests a run through the Trace_Event_Endpoints, THE Trace_Event_Endpoints SHALL return the run's internal status, route, and evidence detail.
3. WHEN the user expands the Trace_Drawer for a `NEEDS_CLARIFICATION` run, THE Trace_Drawer SHALL display the run's internal phase and status detail.

### Area B — Lightweight Direct-Answer Path for Simple Queries (ORN-58)

### Requirement 5: Direct-answer route does not return trace prose

**User Story:** As a Rector user asking a simple question, I want a concise direct answer, so that I do not receive internal status text as my reply.

#### Acceptance Criteria

1. WHEN Triage assigns the `DIRECT_ANSWER` route to a user message, THE Synthesizer SHALL produce a Direct_Answer_Response as the Main_Assistant_Message.
2. WHEN the Main_Assistant_Message is produced for the `DIRECT_ANSWER` route, THE Synthesizer SHALL exclude the substrings "Status:", "Route:", "Trace:", and "Evidence:" from the Main_Assistant_Message.
3. THE Direct_Answer_Response SHALL be bounded to at most 6 sentences.

### Requirement 6: Deterministic direct answer in Local_Mode

**User Story:** As a Rector user running provider-free, I want a deterministic, polite answer to simple queries, so that local mode stays predictable and reproducible.

#### Acceptance Criteria

1. WHILE Rector runs in Local_Mode, WHEN the `DIRECT_ANSWER` route is assigned, THE Synthesizer SHALL produce a deterministic Direct_Answer_Response.
2. WHILE Rector runs in Local_Mode, THE Synthesizer SHALL produce identical Direct_Answer_Response text for identical input.
3. THE Direct_Answer_Response produced in Local_Mode SHALL contain no provider-specific content and SHALL record zero provider calls.

### Requirement 7: Optional cheap-model direct answer in External_Mode

**User Story:** As a BYOK user, I want simple queries answered by a cheap model when one is configured, so that direct answers are higher quality without exceeding my budget.

#### Acceptance Criteria

1. WHERE External_Mode is active and a Provider is configured for the `slm` role, WHEN the `DIRECT_ANSWER` route is assigned, THE Chat_Runner SHALL request a Direct_Answer_Response from the configured cheap model.
2. WHEN a provider call for a Direct_Answer_Response is attempted, THE Budget_Gate SHALL evaluate the call before it is sent.
3. IF the Budget_Gate denies the Direct_Answer_Response provider call, THEN THE Chat_Runner SHALL return the deterministic Local_Mode Direct_Answer_Response and SHALL make zero provider calls for that step.

### Requirement 8: Deterministic fallback for direct-answer failures

**User Story:** As a BYOK user, I want a usable answer even when my provider fails, so that a misconfigured or failing provider never breaks the chat.

#### Acceptance Criteria

1. IF the Direct_Answer_Response provider call fails, THEN THE Chat_Runner SHALL return the deterministic Local_Mode Direct_Answer_Response.
2. IF no Provider is configured for the `DIRECT_ANSWER` route in External_Mode, THEN THE Chat_Runner SHALL return the deterministic Local_Mode Direct_Answer_Response.
3. IF a Direct_Answer_Response provider call fails, THEN THE Redaction_Layer SHALL ensure the Main_Assistant_Message excludes raw provider error text and secret values.
4. WHEN a Direct_Answer_Response provider call fails or is denied, THE Chat_Runner SHALL record the route, run, provider call attempt, cost, and fallback status in the Event_Log.

### Requirement 9: Direct-answer trace recording

**User Story:** As a Rector operator, I want every direct-answer turn to record its route, provider usage, cost, and fallback status, so that I can audit cost and behavior.

#### Acceptance Criteria

1. WHEN a `DIRECT_ANSWER` turn completes, THE Chat_Runner SHALL record the Triage_Route and run id in the Event_Log.
2. WHERE a provider call was made for a Direct_Answer_Response, THE Chat_Runner SHALL record the provider id, model, and accumulated cost in the Event_Log.
3. WHEN a Direct_Answer_Response falls back to deterministic local text, THE Chat_Runner SHALL record a fallback status in the Event_Log.

### Area C — Provider Model Discovery API v1 (ORN-59)

### Requirement 10: Model discovery service behind one interface

**User Story:** As a BYOK user, I want Rector to enumerate the models available from my configured providers, so that I can pick real models instead of typing model ids by hand.

#### Acceptance Criteria

1. THE Model_Discovery_Service SHALL expose a single service interface that enumerates Model_Candidates for a configured Provider identified by its Provider_Config_Record id.
2. THE Model_Discovery_Service SHALL delegate enumeration to a Discovery_Adapter selected by the Provider's kind.
3. WHEN a discovery request names a Provider id that has no Provider_Config_Record, THE Model_Discovery_Service SHALL return a classified `not_found` result without performing a network call.
4. WHEN a Discovery_Adapter returns models, THE Model_Discovery_Service SHALL normalize every entry into the Model_Candidate shape defined in Requirement 11.

### Requirement 11: Normalized model candidate shape

**User Story:** As a developer consuming discovery results, I want one consistent candidate shape across providers, so that the UI and routing logic do not branch per provider.

#### Acceptance Criteria

1. THE Model_Discovery_Service SHALL represent each discovered model as a Model_Candidate containing the fields `providerId`, `kind`, `scope`, `displayName`, `capabilities`, `requiresDeployment`, `requiresRegion`, `source`, and `lastRefreshedAt`.
2. THE Model_Candidate `scope` field SHALL carry the optional sub-fields `accountId`, `region`, `endpoint`, `azureResource`, `subscriptionId`, and `resourceGroup` when known.
3. THE Model_Candidate SHALL carry the optional fields `modelId`, `deploymentId`, `contextWindow`, `pricing`, and `lifecycle` when the Discovery_Adapter provides them.
4. THE Model_Candidate `lifecycle` field SHALL accept the values `active`, `preview`, `deprecated`, or another provider-reported string.
5. THE Model_Candidate `capabilities` field SHALL be a list of capability tags such as text generation, chat, or embeddings.

### Requirement 12: Cloudflare Workers AI discovery adapter

**User Story:** As a Cloudflare Workers AI user, I want Rector to list my account's useful models, so that I can choose chat or embedding models without browsing the dashboard.

#### Acceptance Criteria

1. WHEN discovery runs for a Cloudflare Provider, THE Cloudflare Discovery_Adapter SHALL request the account-scoped catalog at `GET /accounts/{account_id}/ai/models/search`.
2. THE Cloudflare Discovery_Adapter SHALL filter default results to text generation, chat, and embedding models.
3. WHEN a caller does not request deprecated models, THE Cloudflare Discovery_Adapter SHALL omit models marked deprecated from the returned Model_Candidates.
4. WHEN a caller requests deprecated models, THE Cloudflare Discovery_Adapter SHALL include models marked deprecated in the returned Model_Candidates.

### Requirement 13: Together AI discovery adapter

**User Story:** As a Together AI user, I want Rector to list my available models, so that I can select a model that my account can actually use.

#### Acceptance Criteria

1. WHEN discovery runs for a Together AI Provider, THE Together Discovery_Adapter SHALL request the native model list at `GET /models`.
2. IF the native `GET /models` request is unavailable, THEN THE Together Discovery_Adapter SHALL request the OpenAI-compatible list at `GET /v1/models`.
3. THE Together Discovery_Adapter SHALL NOT depend on a provider Responses API for enumeration.

### Requirement 14: OpenAI-compatible discovery adapter

**User Story:** As a user of an OpenAI-compatible endpoint, I want Rector to list its models defensively, so that a non-standard response does not crash discovery.

#### Acceptance Criteria

1. WHEN discovery runs for an OpenAI-compatible Provider, THE OpenAI-compatible Discovery_Adapter SHALL request the model list at `GET /v1/models`.
2. WHEN the `GET /v1/models` response omits optional fields, THE OpenAI-compatible Discovery_Adapter SHALL normalize the entries into Model_Candidates without raising an error.
3. IF the `GET /v1/models` response is not a recognizable model list, THEN THE OpenAI-compatible Discovery_Adapter SHALL return a classified error result.

### Requirement 15: Azure OpenAI discovery adapter

**User Story:** As an Azure OpenAI user, I want Rector to list the catalog models honestly, so that I am not misled into thinking an endpoint and key alone enumerate my deployments.

#### Acceptance Criteria

1. WHEN discovery runs for an Azure OpenAI Provider, THE Azure Discovery_Adapter SHALL request the data-plane model list at `{endpoint}/openai/models?api-version=2024-10-21`.
2. THE Azure Discovery_Adapter SHALL set `requiresDeployment` to true on every returned Azure Model_Candidate.
3. WHEN an Azure Provider is configured with only an endpoint and API key, THE Azure Discovery_Adapter SHALL NOT return deployment ids as discovered candidates.
4. WHEN deployment enumeration is requested for Azure, THE Azure Discovery_Adapter SHALL report that deployment auto-discovery requires management-plane authentication.

### Requirement 16: Discovery caching and invalidation

**User Story:** As a BYOK user, I want discovery results cached, so that repeated views are fast without repeatedly calling the provider.

#### Acceptance Criteria

1. WHEN the Model_Discovery_Service returns a successful result, THE Discovery_Cache SHALL store the result for the Provider with a time-to-live.
2. WHILE a cached result for a Provider is within its time-to-live, WHEN discovery is requested for that Provider without a refresh, THE Model_Discovery_Service SHALL return the cached result without a network call.
3. WHEN a Provider's configuration, secret, or scope changes, THE Discovery_Cache SHALL invalidate the cached result for that Provider.
4. WHEN the Model_Discovery_Service returns an error or empty result, THE Discovery_Cache SHALL store that result with a shorter time-to-live than a successful result.

### Requirement 17: Discovery API endpoints

**User Story:** As a frontend developer, I want HTTP endpoints to read and refresh discovered models, so that the Setup_UI can render and refresh the model list.

#### Acceptance Criteria

1. WHEN a client requests `GET /api/providers/:id/models`, THE Discovery_API SHALL return the Model_Candidates for the Provider and the `lastRefreshedAt` of the result.
2. WHEN a client requests `POST /api/providers/:id/models/refresh`, THE Discovery_API SHALL bypass the Discovery_Cache, re-run discovery, and update the Discovery_Cache.
3. WHEN discovery fails, THE Discovery_API SHALL return a classified, redacted error result.
4. WHEN a client requests discovery for a Provider id with no Provider_Config_Record, THE Discovery_API SHALL respond with a redacted not-found result without a network call.

### Requirement 18: Discovery error classification and secret safety

**User Story:** As a security-conscious user, I want discovery to never expose my secrets and to classify failures clearly, so that errors are actionable and safe.

#### Acceptance Criteria

1. WHEN a discovery network call fails, THE Model_Discovery_Service SHALL return a classified error category rather than a raw provider error body.
2. THE Model_Discovery_Service SHALL route every returned error message through the Redaction_Layer.
3. THE Model_Discovery_Service SHALL NOT store, log, or return any secret value.
4. THE Provider_Config_Store SHALL hold only non-secret configuration, and discovery SHALL read secret values only transiently through the Secret_Store at request time.

### Area D — Provider Setup UI Model Picker and Per-Model Probe (ORN-60, depends on ORN-59)

### Requirement 19: Discover and refresh models in the Setup_UI

**User Story:** As a BYOK user configuring a provider, I want a Discover/Refresh control, so that I can pull the current model list into the UI.

#### Acceptance Criteria

1. WHEN a user opens provider configuration for a configured Provider, THE Setup_UI SHALL offer a Discover models control and a Refresh control.
2. WHEN the user activates the Discover or Refresh control, THE Setup_UI SHALL request the Discovery_API and render the returned Model_Candidates.
3. WHEN Model_Candidates are rendered, THE Setup_UI SHALL display the `lastRefreshedAt` of the result.
4. WHEN discovery returns a classified error, THE Setup_UI SHALL display the redacted error and keep manual model entry available.

### Requirement 20: Candidate display detail

**User Story:** As a BYOK user choosing a model, I want to see each candidate's capabilities and status, so that I can make an informed selection.

#### Acceptance Criteria

1. WHEN the Model_Picker renders a Model_Candidate, THE Model_Picker SHALL display the candidate's capability tags.
2. WHEN a Model_Candidate carries a lifecycle value, THE Model_Picker SHALL display the lifecycle status, including a deprecated indicator when the lifecycle is `deprecated`.
3. WHERE a Model_Candidate carries a context window or pricing, THE Model_Picker SHALL display the context window or pricing.
4. WHERE a Model_Candidate requires a region or deployment, THE Model_Picker SHALL display the region or deployment note.

### Requirement 21: Role selection with manual override

**User Story:** As a BYOK user, I want to assign candidates to the flagship and SLM roles and still type a model manually, so that I can configure routing even when discovery is incomplete.

#### Acceptance Criteria

1. WHEN the Model_Picker is displayed, THE Model_Picker SHALL let the user select a Model_Candidate for the `flagship` role and a Model_Candidate for the `slm` role.
2. THE Setup_UI SHALL retain a manual model-entry override for each role.
3. WHEN discovery returns no candidates for a Provider, THE Setup_UI SHALL keep the manual model-entry override available for each role.

### Requirement 22: Per-model probe before saving

**User Story:** As a BYOK user, I want to test a selected model before saving it as my active route, so that I do not activate a model that does not work.

#### Acceptance Criteria

1. WHEN the user activates "Test selected model" for a selected Model_Candidate, THE Connection_Test_Service SHALL run a single Model_Probe targeting that candidate's model or deployment.
2. THE Model_Probe SHALL be model-and-deployment-aware and SHALL reuse the existing Connection_Test_Service path.
3. WHEN a Model_Probe succeeds, THE Setup_UI SHALL mark the selection as verified.
4. WHEN the user saves a verified selection, THE Setup_UI SHALL persist the selection to the Active_Route_Map.
5. WHERE a selection is unverified, THE Setup_UI SHALL allow an explicit "save unverified" action only after displaying a warning.

### Requirement 23: Probe error categories

**User Story:** As a BYOK user, I want probe failures explained by category, so that I know whether to fix my key, region, deployment, or model access.

#### Acceptance Criteria

1. WHEN a Model_Probe fails, THE Connection_Test_Service SHALL classify the failure into a Probe_Error_Category.
2. THE Probe_Error_Category set SHALL include auth invalid, endpoint or base URL invalid, region or location unsupported, deployment not found, model access or agreement missing, quota or rate limit exceeded, parameter incompatibility, content or safety rejection, and unknown provider error.
3. WHEN a Model_Probe fails, THE Connection_Test_Service SHALL route the returned error message through the Redaction_Layer.

### Requirement 24: Setup_UI never displays secrets and explains Azure deployments

**User Story:** As an Azure OpenAI user, I want the UI to explain the deployment-name limitation and never show my key, so that I configure Azure correctly and safely.

#### Acceptance Criteria

1. THE Setup_UI SHALL NOT display any secret value.
2. WHERE the configured Provider is Azure OpenAI, THE Setup_UI SHALL explain that inference requires a deployment name and that endpoint plus key does not enumerate deployments.
3. WHEN the Setup_UI renders provider configuration, THE Setup_UI SHALL indicate secret presence as a boolean state only.

### Area E — Azure and Bedrock Regional Discovery Follow-up (ORN-61, depends on ORN-59)

### Requirement 25: Documented regional discovery architecture

**User Story:** As a maintainer, I want the cloud regional discovery approach documented, so that follow-up work has a precise design without blocking ORN-59 and ORN-60.

#### Acceptance Criteria

1. THE documentation SHALL explain the distinction between Azure data-plane model listing and Azure management-plane deployment discovery.
2. THE documentation SHALL record the Azure management-plane configuration fields required for future Regional_Discovery, including `subscriptionId`, `resourceGroup`, `accountName`, `location`, deployment name, model name and version, and SKU or provisioning state.
3. THE documentation SHALL record the AWS Bedrock discovery design notes, including region-first `ListFoundationModels`, `GetFoundationModelAvailability` readiness checks, and inference-profile cross-region routing.
4. THE documentation SHALL record a data-residency and IAM warning for Bedrock cross-region inference profiles.
5. THE documentation SHALL note that Bedrock may require a separate future Discovery_Adapter.

### Requirement 26: Scaffolded follow-up without blocking the foundation

**User Story:** As a maintainer, I want regional discovery scaffolded but optional, so that the discovery foundation ships without full Azure management auth or a Bedrock adapter.

#### Acceptance Criteria

1. THE Regional_Discovery follow-up SHALL be delivered as design and scaffolding and SHALL NOT block delivery of Requirement 10 through Requirement 24.
2. WHERE Regional_Discovery scaffolding includes runtime code, THE error states surfaced by that code SHALL distinguish an invalid key from a region, deployment, or model unavailability.
3. WHERE Regional_Discovery scaffolding includes runtime code, THE cloud APIs it calls SHALL be mocked in tests with no live cloud call.

### Area F — Cross-Cutting Non-Functional Requirements

### Requirement 27: Provider-free local default preserved

**User Story:** As a Rector user, I want the provider-free local mode to remain the default, so that I can run Rector without any credentials.

#### Acceptance Criteria

1. WHEN no orchestration mode is configured, THE Chat_Runner SHALL run in Local_Mode.
2. WHILE Rector runs in Local_Mode, THE Chat_Runner SHALL make zero provider and zero network calls.
3. THE changes in this effort SHALL preserve the existing Local_Mode chat behavior for every Triage_Route other than `NEEDS_CLARIFICATION` and `DIRECT_ANSWER`.

### Requirement 28: No secrets across any boundary

**User Story:** As a security-conscious user, I want my secrets kept out of logs, snapshots, tests, and UI, so that BYOK is safe by default.

#### Acceptance Criteria

1. THE Redaction_Layer SHALL be applied to every persistence, logging, streaming, API, and UI boundary introduced by this effort.
2. THE Provider_Config_Store SHALL never persist a secret value.
3. THE Model_Discovery_Service, Discovery_API, Connection_Test_Service, and Setup_UI SHALL never return or display a secret value.
4. WHEN test fixtures or snapshots are produced, THE test suite SHALL exclude secret values.

### Requirement 29: Tests make no live external calls

**User Story:** As a contributor, I want the test suite to be hermetic, so that CI never depends on live providers or cloud accounts.

#### Acceptance Criteria

1. WHEN the test suite exercises a Discovery_Adapter, Model_Probe, or provider call, THE test SHALL use a mocked `fetch` or mocked provider.
2. THE test suite SHALL NOT require live provider credentials or network access.
3. THE continuous integration pipeline SHALL make no live provider or cloud calls.

### Requirement 30: Verification gates pass

**User Story:** As a maintainer, I want the build and tests to pass, so that the effort is releasable.

#### Acceptance Criteria

1. WHEN the Verification_Gates run, THE `npm test` gate SHALL pass.
2. WHEN the Verification_Gates run, THE `npm run build` gate SHALL pass.
3. THE effort SHALL preserve the baseline of 106 test files and 951 passing tests as a lower bound.
