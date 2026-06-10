# Requirements Document

## Introduction

Rector currently runs as a provider-free, local-only simulation baseline: the orchestrator
defaults to `local` mode, the sandbox echoes commands through a deterministic stub, heavy
developer routes return formatted status strings instead of natural-language answers, model
discovery and the BYOK config bridge are scaffolded, and persistence defaults to an in-memory
store. This feature transitions Rector to a cloud-ready commercial codebase that can use the
configured credit stack — TiDB Cloud (relational persistence), multiple inference providers
(Together AI, Cloudflare Workers AI, and Azure OpenAI), and E2B (real sandbox execution) — while
preserving the local-mode regression baseline exactly and never leaking secrets into logs or
telemetry.

Model discovery is multi-provider: the Model_Discovery_Service dispatches a dedicated
Discovery_Adapter per provider kind so that Together AI, Cloudflare Workers AI, and Azure OpenAI
each support automatic model discovery against their native catalog endpoints. In addition, Rector
supports a bring-your-own, generic OpenAI-compatible provider: the user supplies a recognizable
display name to identify the provider and may list the specific model identifiers to use. For that
generic provider, discovery attempts the OpenAI-compatible models endpoint first and falls back to
the user-entered model list when the endpoint is unavailable.

The work spans five areas: (1) repairing the startup validation catch-22 so the server boots
even when credentials live only in the UI configuration stores; (2) completing Bring-Your-Own-Key
(BYOK) multi-provider model discovery and provider-agnostic routing; (3) replacing the mock sandbox
command runner with a real E2B container client; (4) streaming semantic prose answers from the
synthesizer for heavy developer routes; and (5) connecting TiDB Cloud relational persistence. Two
invariants hold across every area: local mode performs zero network and zero external sandbox calls,
and every secret-bearing value is redacted before it is written to any log or telemetry sink.

## Glossary

- **Rector_Server**: The HTTP server process started by `src/bin/server.ts` that hosts the UI,
  the settings/configuration API, and the orchestration runtime.
- **Orchestration_Config**: The resolved configuration object produced by `parseOrchestrationConfig`,
  carrying the orchestration mode and the list of configured provider ids (never a secret value).
- **Orchestrator_Mode**: The `ORCHESTRATOR_MODE` selection, exactly one of `local` or `external`.
- **Local_Mode**: Orchestrator_Mode `local` — the provider-free regression baseline that performs no
  network calls and no external sandbox execution.
- **External_Mode**: Orchestrator_Mode `external` — the BYOK live mode that may call configured
  providers and external sandboxes.
- **Provider_Kind**: One of the supported provider kinds `together`, `cloudflare`, `azure-openai`, or
  `openai-compatible`.
- **Provider_Config_Store**: The non-secret persisted store of `Provider_Config_Record`s
  (`.rector/providers.json`), accessed through the `ProviderConfigStore` interface.
- **Provider_Config_Record**: A persisted, non-secret provider configuration record carrying its
  Provider_Kind, Provider_Label, endpoint coordinates, model selections, and a reference to its
  secret material.
- **Provider_Label**: The record's user-facing display name (`label`), a non-empty string used to
  identify a configured provider in the UI.
- **Manual_Model_List**: A user-entered list of model identifiers persisted on a Provider_Config_Record
  and used as a discovery fallback and as selectable model identifiers.
- **Secret_Store**: The encrypted store of provider secrets (`.rector/secrets.enc`), accessed through
  the `SecretStore` interface, which exposes secret presence as a boolean and secret values only at
  provider construction time.
- **Config_Bridge**: The `src/providers/configBridge.ts` module that resolves persisted configuration
  plus secrets into provider instances and the External_Mode `Model_Router`.
- **Model_Router**: The component that selects a provider and model route for a request.
- **Active_Route_Map**: The persisted mapping of capability roles (`flagship`, `slm`) to a designated
  `Provider_Config_Record` id, honored by the Config_Bridge during selection.
- **Capability_Tier**: A routing tier; this feature concerns the `flagship` and `slm` tiers.
- **Model_Discovery_Service**: The service that dispatches the per-Provider_Kind Discovery_Adapter and
  returns normalized `Model_Candidate`s.
- **Discovery_Adapter**: A component that queries a single provider's model catalog and returns an
  adapter result of either normalized `Model_Candidate`s or a classified `Discovery_Error`. The
  registry maps each Provider_Kind to exactly one Discovery_Adapter.
- **Together_Discovery_Adapter**: The Discovery_Adapter for the `together` kind that queries the
  Together AI catalog at `GET {baseUrl}/models` and falls back to `GET {baseUrl}/v1/models` only on an
  HTTP 404 response.
- **Cloudflare_Discovery_Adapter**: The Discovery_Adapter for the `cloudflare` kind that queries the
  Cloudflare Workers AI model catalog at `/accounts/{accountId}/ai/models/search`.
- **Azure_Discovery_Adapter**: The Discovery_Adapter for the `azure-openai` kind that queries the
  Azure OpenAI data-plane catalog at `GET {endpoint}/openai/models?api-version=2024-10-21`.
- **OpenAI_Compatible_Discovery_Adapter**: The Discovery_Adapter for the `openai-compatible` kind that
  queries the generic catalog at `GET {baseUrl}/v1/models`.
- **Model_Candidate**: The normalized, provider-agnostic description of a discoverable model defined
  by `ModelCandidateSchema`.
- **Discovery_Error**: The classified, redacted error returned by a Discovery_Adapter or the
  Model_Discovery_Service, carrying exactly one category from `auth_invalid`, `endpoint_invalid`,
  `rate_limited`, `network_error`, `unsupported_response`, `requires_management_plane`, or `unknown`
  (with `not_found` and `timeout` additionally used at the Settings_API layer).
- **Settings_API**: The configuration HTTP endpoints served by `src/api/server.ts` that the UI uses
  to manage providers, trigger discovery, and select routes.
- **Sandbox_Adapter**: A component implementing the `SandboxAdapter` contract that executes sandbox
  operations and returns a `Sandbox_Execution_Result`.
- **E2B_Sandbox_Adapter**: The Sandbox_Adapter backed by a real E2B container client, replacing
  `createE2BSandboxAdapterStub`.
- **Sandbox_Operation**: A `RUN_COMMAND`, `PROPOSE_PATCH`, `READ_FILE`, or `LIST_DIR` request defined
  by `SandboxOperationSchema`.
- **Sandbox_Execution_Result**: The result object defined by `SandboxExecutionResultSchema` /
  `SandboxOperationResultSchema` carrying status, exit code, captured stdout/stderr, and artifacts.
- **MAX_CAPTURED_STREAM_BYTES**: The hard upper bound of 262144 bytes (256 KiB) applied to each
  captured stdout/stderr stream.
- **Synthesizer**: The `src/orchestration/synthesizer.ts` component that produces the user-facing
  `Main_Assistant_Message` for a run.
- **Heavy_Developer_Route**: One of the triage routes `RESEARCH`, `CODE_EDIT`, `PLAN_ONLY`, or
  `LONG_RUNNING`.
- **Narrative_Answer**: A concise, natural-language, provider-generated summary of a run that states
  what was attempted, what was fixed, and which files changed, and references the trace drawer for
  raw data.
- **Legacy_Status_Response**: The deterministic `Status: ... Route: ... Evidence: ...` string the
  Synthesizer returns today for non-targeted routes.
- **Rector_Store**: A persistence implementation conforming to the `RectorStore` interface.
- **TiDB_Store**: A `Rector_Store` backed by a TiDB Cloud connection over the MySQL wire protocol.
- **Persistence_Driver**: The `RECTOR_PERSISTENCE` selection, one of `memory`, `sqlite`, or `tidb`.
- **Startup_Migration**: The boot-time routine that verifies and provisions the relational table
  layout when the Persistence_Driver is `tidb`.
- **Redaction_Layer**: The `src/security/redaction.ts` utilities (`redactString`, `redactSecrets`,
  `redactOutbound`) that remove secrets, API keys, and authorization headers from a value.

## Requirements

### Requirement 1: Boot-Tolerant Startup Validation

**User Story:** As a Rector operator, I want the server to start even when my credentials live only
in the UI configuration stores, so that I can open the configuration panel and enter or correct my
credentials instead of being locked out by a startup crash.

#### Acceptance Criteria

1. THE Rector_Server SHALL resolve the Orchestration_Config from both `process.env` and the
   initialized Provider_Config_Store and Secret_Store before deciding whether to halt startup.
2. WHERE `parseOrchestrationConfig` is invoked with a Provider_Config_Store and a Secret_Store,
   THE Orchestration_Config resolution SHALL await both the Provider_Config_Store read and the
   Secret_Store read before returning, and the resolved configured-provider list SHALL include every
   provider whose credentials were found in those stores.
3. WHILE Orchestrator_Mode is `external`, THE Rector_Server SHALL treat a provider as configured when
   all of that provider's required credential keys are present and non-empty in `process.env`, OR the
   provider has a Provider_Config_Record in the Provider_Config_Store with every required secret
   reported present by the Secret_Store.
4. IF Orchestrator_Mode is `external` AND no provider satisfies the configured-provider condition in
   either `process.env` or the configuration stores, THEN THE Rector_Server SHALL emit a redacted
   startup warning that instructs the operator to enter credentials in the UI before the server begins
   serving requests.
5. IF Orchestrator_Mode is `external` AND no provider satisfies the configured-provider condition in
   either source, THEN THE Rector_Server SHALL NOT exit with a non-zero process status and SHALL bind
   and listen on the configured port.
6. WHEN the resolved Orchestrator_Mode value does not exactly match `local` or `external`
   (case-sensitive), THE Rector_Server SHALL halt startup by exiting with a non-zero process status
   and SHALL emit a redacted configuration error that names the accepted values `local` and `external`.
7. WHEN the Rector_Server emits the startup warning, THE Rector_Server SHALL name the required
   environment variable keys for each supported provider and SHALL exclude every secret value from the
   warning.
8. IF the Provider_Config_Store or the Secret_Store cannot be initialized or read during
   Orchestration_Config resolution, THEN THE Rector_Server SHALL treat the stored credentials as
   absent, emit a redacted error indicating the store could not be read, and continue startup rather
   than exit with a non-zero process status.

### Requirement 2: Multi-Provider Model Discovery

**User Story:** As a Rector user with credits across Together AI, Cloudflare Workers AI, and Azure
OpenAI, I want Rector to discover each provider's model catalog through its own adapter, so that I can
select models for my routes from the UI regardless of which provider I configured.

#### Acceptance Criteria

1. WHEN the Model_Discovery_Service receives a discovery request for a Provider_Config_Record, THE
   Model_Discovery_Service SHALL dispatch the single Discovery_Adapter mapped to that record's
   Provider_Kind and SHALL return that adapter's result.
2. WHEN the Together_Discovery_Adapter runs with a configured base URL and credential, THE
   Together_Discovery_Adapter SHALL request `GET {baseUrl}/models` and SHALL request
   `GET {baseUrl}/v1/models` as a fallback only when the first request returns an HTTP 404 status.
3. WHEN the Cloudflare_Discovery_Adapter runs with a configured account id and credential, THE
   Cloudflare_Discovery_Adapter SHALL request `GET /accounts/{accountId}/ai/models/search` and SHALL
   retain only catalog entries whose task is exactly one of text generation, chat, or embeddings,
   discarding all other entries.
4. WHEN the Azure_Discovery_Adapter runs with a configured endpoint and credential, THE
   Azure_Discovery_Adapter SHALL request the data-plane catalog at
   `GET {endpoint}/openai/models?api-version=2024-10-21`, SHALL set `requiresDeployment` to true on
   every emitted Model_Candidate, and SHALL emit no deployment identifier on any Model_Candidate.
5. IF a discovery request to the Azure_Discovery_Adapter requests deployment enumeration, THEN THE
   Azure_Discovery_Adapter SHALL return a Discovery_Error with category `requires_management_plane`.
6. WHEN the OpenAI_Compatible_Discovery_Adapter runs with a configured base URL and credential, THE
   OpenAI_Compatible_Discovery_Adapter SHALL request `GET {baseUrl}/v1/models`.
7. WHEN any Discovery_Adapter receives a catalog response, THE Discovery_Adapter SHALL normalize each
   retained entry against `ModelCandidateSchema` and SHALL map each entry that validates to a
   Model_Candidate.
8. IF a retained catalog entry fails validation against `ModelCandidateSchema`, THEN THE
   Discovery_Adapter SHALL exclude that entry from the result set and continue processing the remaining
   retained entries.
9. THE Model_Discovery_Service SHALL abort any Discovery_Adapter catalog request that does not receive
   a response within 30 seconds.
10. IF a provider's required credential is absent (missing, empty, or whitespace-only), THEN THE
    dispatched Discovery_Adapter SHALL return a Discovery_Error with category `auth_invalid`.
11. IF a provider's required endpoint or account coordinate is absent (missing, empty, or
    whitespace-only), THEN THE dispatched Discovery_Adapter SHALL return a Discovery_Error with category
    `endpoint_invalid`.
12. IF a Discovery_Adapter catalog request fails, times out after 30 seconds, returns a non-OK HTTP
    status, or returns a payload that does not match the expected catalog structure, THEN THE
    Discovery_Adapter SHALL return a classified, redacted Discovery_Error rather than raising an
    exception.
13. WHEN a Discovery_Error message is constructed, THE Discovery_Adapter SHALL exclude every credential
    value and any raw provider response body from the message.
14. WHEN a Discovery_Adapter receives a catalog response and zero entries remain after normalization
    and filtering, THE Discovery_Adapter SHALL return an empty Model_Candidate set rather than a
    Discovery_Error.
15. WHILE Orchestrator_Mode is `local`, THE Model_Discovery_Service SHALL perform zero discovery
    network calls.

### Requirement 3: Bring-Your-Own OpenAI-Compatible Provider with Manual Model Entry

**User Story:** As a Rector user with a provider endpoint that is not Together AI, Cloudflare, or
Azure, I want to register that endpoint with a recognizable name and list the specific models I want,
so that I can use any OpenAI-compatible provider even when its catalog endpoint is unavailable.

#### Acceptance Criteria

1. WHEN the Settings_API receives an `openai-compatible` Provider_Config_Record with a non-empty
   Provider_Label, THE Settings_API SHALL persist the Provider_Label on the Provider_Config_Record for
   provider identification.
2. IF the Settings_API receives an `openai-compatible` Provider_Config_Record whose Provider_Label is
   missing, empty, or whitespace-only, THEN THE Settings_API SHALL reject the record with a validation
   error and SHALL persist no record.
3. WHEN the Settings_API receives an `openai-compatible` Provider_Config_Record with a Manual_Model_List,
   THE Settings_API SHALL persist the Manual_Model_List on the Provider_Config_Record and SHALL exclude
   every secret value from the persisted record.
4. WHEN the OpenAI_Compatible_Discovery_Adapter runs for a record, THE OpenAI_Compatible_Discovery_Adapter
   SHALL first attempt `GET {baseUrl}/v1/models`.
5. IF the `GET {baseUrl}/v1/models` request fails, times out, returns a non-OK HTTP status, or returns
   no usable entries, AND a Manual_Model_List is present on the record, THEN THE
   OpenAI_Compatible_Discovery_Adapter SHALL build the discovery result from the Manual_Model_List
   instead of returning a Discovery_Error.
6. WHEN the OpenAI_Compatible_Discovery_Adapter builds the discovery result from the Manual_Model_List,
   THE OpenAI_Compatible_Discovery_Adapter SHALL emit exactly one Model_Candidate per Manual_Model_List
   model identifier, and each emitted Model_Candidate SHALL validate against `ModelCandidateSchema`.
7. IF the `GET {baseUrl}/v1/models` request fails, times out, returns a non-OK HTTP status, or returns
   no usable entries, AND no Manual_Model_List is present on the record, THEN THE
   OpenAI_Compatible_Discovery_Adapter SHALL return a classified, redacted Discovery_Error.
8. WHERE a Manual_Model_List is present on a record, THE Active_Route_Map SHALL be able to designate any
   Manual_Model_List model identifier as the `flagship` or `slm` model identifier for that record.

### Requirement 4: Trigger Discovery from the Settings API

**User Story:** As a Rector user, I want the settings panel to trigger model discovery for a
configured provider of any kind, so that I can browse and choose discovered models without editing
files.

#### Acceptance Criteria

1. WHEN the Settings_API receives a discovery request for a provider id that has a
   Provider_Config_Record in the Provider_Config_Store, THE Settings_API SHALL invoke the
   Model_Discovery_Service for that provider and return the resulting Model_Candidates.
2. IF the Settings_API receives a discovery request for a provider id that has no
   Provider_Config_Record, THEN THE Settings_API SHALL return a Discovery_Error with category
   `not_found`.
3. WHILE Orchestrator_Mode is `local`, THE Settings_API SHALL perform no model discovery network call.
4. WHEN the Settings_API returns a discovery result, THE Settings_API SHALL exclude every secret value
   and authorization header from the response payload.
5. IF the Model_Discovery_Service returns a Discovery_Error for the requested provider, THEN THE
   Settings_API SHALL return that classified error to the caller without raising an exception.
6. IF the Settings_API does not receive a discovery result from the Model_Discovery_Service within
   30 seconds of invoking it, THEN THE Settings_API SHALL stop waiting and return a Discovery_Error
   with category `timeout`.
7. WHILE Orchestrator_Mode is `local`, IF the Settings_API receives a discovery request, THEN THE
   Settings_API SHALL return a Discovery_Error indicating that model discovery is unavailable in
   local mode.

### Requirement 5: Provider Routing in External Mode

**User Story:** As a Rector user, I want to route flagship and small-model tiers to selected models
from any configured provider kind, so that I can balance capability and cost across my credits
regardless of which provider serves each tier.

#### Acceptance Criteria

1. WHERE a provider of any Provider_Kind is selected in External_Mode, THE Config_Bridge SHALL
   construct that provider with network access enabled.
2. WHEN the Active_Route_Map designates a Provider_Config_Record for the `flagship` role, that record
   exists with its required credentials and endpoint coordinates present in the stores, and that record
   designates a non-empty model identifier for the `flagship` role, THE Model_Router SHALL route
   `flagship`-tier requests to the designated model on that provider.
3. WHEN the Active_Route_Map designates a Provider_Config_Record for the `slm` role, that record exists
   with its required credentials and endpoint coordinates present in the stores, and that record
   designates a non-empty model identifier for the `slm` role, THE Model_Router SHALL route `slm`-tier
   requests to the designated model on that provider.
4. IF a designated Provider_Config_Record is absent, is missing its required credentials or endpoint
   coordinates, designates no model identifier for the requested role, or raises an error when serving
   the route, THEN THE Model_Router SHALL select the next provider in the capability-priority fallback
   order rather than failing the run.
5. WHEN the Model_Router substitutes a fallback provider for a designated route, THE Model_Router SHALL
   record an indication of the substitution in the run trace without including any secret value.
6. WHILE Orchestrator_Mode is `local`, THE Config_Bridge SHALL NOT construct any external provider and
   the Model_Router SHALL select the provider-free fallback.

### Requirement 6: Real E2B Sandbox Command Execution

**User Story:** As a Rector user running in external mode, I want sandbox commands and patches to run
inside a real E2B container, so that Rector executes real work instead of echoing commands.

#### Acceptance Criteria

1. WHERE Orchestrator_Mode is `external` AND an E2B API key is present in the Secret_Store, THE
   E2B_Sandbox_Adapter SHALL initialize an E2B container client using that key.
2. WHEN the E2B_Sandbox_Adapter receives a `RUN_COMMAND` Sandbox_Operation that has cleared the
   command allowlist, destructive denylist, and approval gates, THE E2B_Sandbox_Adapter SHALL execute
   the command inside the E2B container.
3. WHEN the E2B_Sandbox_Adapter receives an approved `PROPOSE_PATCH` Sandbox_Operation, THE
   E2B_Sandbox_Adapter SHALL apply the file change inside the E2B container.
4. WHEN the E2B_Sandbox_Adapter completes a command, THE E2B_Sandbox_Adapter SHALL capture the command
   exit code, stdout, and stderr into the Sandbox_Execution_Result.
5. WHEN a captured stdout or stderr stream exceeds MAX_CAPTURED_STREAM_BYTES (262144 bytes), THE
   E2B_Sandbox_Adapter SHALL truncate that stream to MAX_CAPTURED_STREAM_BYTES in the
   Sandbox_Execution_Result and SHALL set an indication that the stream was truncated.
6. IF a Sandbox_Operation is denied by the command allowlist, the destructive denylist, or a missing
   approval, THEN THE E2B_Sandbox_Adapter SHALL return a `DENIED` or `NEEDS_APPROVAL`
   Sandbox_Execution_Result without spawning a container process.
7. WHILE Orchestrator_Mode is `local`, THE Rector_Server SHALL execute sandbox operations through the
   local provider-free runner and SHALL initialize no E2B container client.
8. WHEN the E2B_Sandbox_Adapter records captured streams or artifacts, THE E2B_Sandbox_Adapter SHALL
   redact secret values from the recorded content.
9. IF the E2B container client cannot be initialized, THEN THE E2B_Sandbox_Adapter SHALL return a
   failure Sandbox_Execution_Result with a redacted error indication and SHALL spawn no container
   process.
10. IF an approved `PROPOSE_PATCH` Sandbox_Operation cannot be applied inside the container, THEN THE
    E2B_Sandbox_Adapter SHALL return a failure Sandbox_Execution_Result with a redacted error
    indication and SHALL leave the target file unchanged.

### Requirement 7: Streamed Semantic Answers for Heavy Developer Routes

**User Story:** As a Rector user, I want a natural-language summary for research and code-editing runs,
so that I understand what happened without reading raw status logs.

#### Acceptance Criteria

1. WHILE Orchestrator_Mode is `external` AND the Active_Route_Map designates a valid configured
   provider for the `flagship` role, WHEN a run resolves to a Heavy_Developer_Route, THE Synthesizer
   SHALL request a Narrative_Answer from the designated flagship model.
2. WHEN the Synthesizer constructs the Narrative_Answer prompt, THE Synthesizer SHALL include the
   triage intent, the compiled DAG, the node execution logs, the validation outcomes, and the
   generated diffs, and SHALL omit any of these inputs that are absent for the run rather than fail.
3. WHEN the flagship model returns a valid Narrative_Answer, THE Synthesizer SHALL return a summary of
   at most 2000 characters stating what was attempted, what was fixed, and which files changed, and
   SHALL reference the trace drawer for raw data.
4. IF the flagship model request is denied by budget, fails, returns an invalid answer, or does not
   return within 60 seconds, THEN THE Synthesizer SHALL return the deterministic Legacy_Status_Response
   for that route.
5. WHILE Orchestrator_Mode is `local`, WHEN a run resolves to a Heavy_Developer_Route, THE Synthesizer
   SHALL return the deterministic Legacy_Status_Response and SHALL make zero provider calls.
6. WHEN the Synthesizer returns a Narrative_Answer, THE Synthesizer SHALL redact secret values from the
   answer text and every citation field before returning.
7. THE Synthesizer SHALL treat a Narrative_Answer as invalid when the model response is empty, is not
   parseable as the expected answer shape, or exceeds the maximum answer length.

### Requirement 8: TiDB Cloud Relational Persistence

**User Story:** As a Rector operator deploying to the cloud, I want runs and conversations persisted in
TiDB Cloud, so that data survives restarts and scales beyond a single machine.

#### Acceptance Criteria

1. WHERE the Persistence_Driver is `tidb` AND the connection block provides a non-empty host, port,
   database name, username, and password, THE Rector_Server SHALL construct a TiDB_Store that connects
   over the MySQL wire protocol using connection pooling.
2. IF the Persistence_Driver is `tidb` AND any of the required connection fields (host, port, database
   name, username, or password) is missing or empty, THEN THE Rector_Server SHALL raise a configuration
   error that names the missing field(s) before opening any network connection, and SHALL NOT begin
   listening on the configured port.
3. THE TiDB_Store SHALL map the `conversations`, `messages`, `runs`, `run_events`, and `artifacts`
   entities to relational tables using the MySQL dialect.
4. WHEN the Rector_Server boots with Persistence_Driver `tidb`, THE Startup_Migration SHALL verify that
   each of the `conversations`, `messages`, `runs`, `run_events`, and `artifacts` tables exists and
   SHALL provision any missing table before the Rector_Server serves any request.
5. WHEN an entity of any of the `conversations`, `messages`, `runs`, `run_events`, or `artifacts` types
   is written to the TiDB_Store and then read back by its identifier, THE TiDB_Store SHALL return an
   entity deep-equal to the entity written (round-trip property).
6. WHILE the Persistence_Driver is `memory`, THE Rector_Server SHALL construct the in-memory
   Rector_Store and SHALL open no database network connection.
7. IF a TiDB_Store error message is constructed, THEN THE TiDB_Store SHALL exclude the connection
   password and any credentials embedded in a connection URL from the message.
8. IF the Startup_Migration cannot establish a TiDB Cloud connection within 30 seconds or fails to
   provision a missing table, THEN THE Rector_Server SHALL halt startup with a redacted error
   indicating that persistence initialization failed and SHALL serve no request.

### Requirement 9: Local-Mode Regression Baseline Preservation

**User Story:** As a Rector maintainer, I want local mode to behave exactly as the provider-free
baseline, so that the existing regression suite keeps passing after the cloud transition.

#### Acceptance Criteria

1. WHILE Orchestrator_Mode is `local`, THE Rector_Server SHALL make zero outbound provider network
   calls across orchestration, discovery, and synthesis.
2. WHILE Orchestrator_Mode is `local`, THE Rector_Server SHALL execute no external sandbox container.
3. WHILE Orchestrator_Mode is `local`, THE Config_Bridge SHALL NOT be consulted for router
   construction.
4. WHEN a run completes in Local_Mode, THE Synthesizer SHALL report `providerCalls` equal to 0.
5. WHEN `ORCHESTRATOR_MODE` is unset, empty, or whitespace-only, THE Rector_Server SHALL resolve the
   Orchestrator_Mode to `local`.
6. IF a code path attempts an outbound provider network call or an external sandbox execution while
   Orchestrator_Mode is `local`, THEN THE Rector_Server SHALL block the attempt and SHALL leave
   persisted state unchanged.
7. WHEN the same Local_Mode run is executed twice with identical inputs, THE Rector_Server SHALL
   produce user-facing output deep-equal across the two executions (determinism property).

### Requirement 10: Secret Redaction Across Logs and Telemetry

**User Story:** As a Rector operator, I want secrets, API keys, and authorization headers removed from
all logs and telemetry, so that credentials never leak into observable output.

#### Acceptance Criteria

1. WHEN the Rector_Server writes an environment variable, API endpoint detail, or database identifier
   to a log or telemetry sink, THE Rector_Server SHALL redact secret values, API keys, and
   authorization headers using the Redaction_Layer before the write.
2. THE Redaction_Layer SHALL replace each redacted value with a single fixed placeholder string that
   contains no character of the original redacted value.
3. WHEN any value is redacted for a log or telemetry sink, THE redacted output SHALL contain no
   substring of any Secret_Store secret value, API key, or authorization credential.
4. WHEN a value containing a Bearer or Basic authorization header is logged, THE Redaction_Layer SHALL
   replace the credential token that follows the scheme keyword with the placeholder while retaining
   the scheme keyword.
5. WHEN a value containing a credential-bearing connection URL is logged, THE Redaction_Layer SHALL
   replace the userinfo credential component with the placeholder while retaining the other URL
   components.
6. IF outbound redaction of a value fails, THEN THE Rector_Server SHALL suppress the raw value and emit
   the fixed redaction-failed placeholder instead.

### Requirement 11: Build and Test Verification

**User Story:** As a Rector maintainer, I want the build and test suite to pass after the transition, so
that the cloud-ready codebase remains releasable.

#### Acceptance Criteria

1. WHEN `npm run build` is executed against the transitioned codebase, THE build SHALL exit with a
   zero status and report zero compilation errors.
2. WHEN `npm test` is executed against the transitioned codebase, THE test suite SHALL exit with a
   zero status and report zero failing and zero errored tests.
3. WHEN `npm run build` is executed with the optional cloud client dependencies (the TiDB MySQL driver
   and the E2B client) absent, THE build SHALL exit with a zero status.
4. WHEN the transitioned codebase is run in `local` mode with the `memory` Persistence_Driver and the
   optional cloud client dependencies absent, THE Rector_Server SHALL start and serve requests.
5. IF an operator selects the `tidb` Persistence_Driver while the TiDB MySQL driver is absent, or
   selects an E2B-backed sandbox while the E2B client is absent, THEN THE Rector_Server SHALL emit an
   error that indicates the missing dependency.
