# Requirements Document

## Introduction

BYOK Alpha Phase 1 (ORN-31 → ORN-34) makes Rector's chat pipeline capable of using a real
Bring-Your-Own-Key (BYOK) provider for the **PLANNING** phase only, while keeping the existing
provider-free local path as the default and as the regression baseline that `npm test` exercises
with no credentials.

These requirements are derived from the approved design document
(`.kiro/specs/byok-alpha-phase1/design.md`) and align with its components, data models, and the
correctness properties enumerated there. The work spans four components: a single orchestration
mode switch with startup validation (ORN-31), a provider connection-test endpoint (ORN-32), a
mode-aware chat runner with budget preflight (ORN-33), and a live planner agent with JSON
validation, a single repair retry, and structured blockers (ORN-34).

Every requirement preserves four hard product constraints: the symbolic control plane stays in
charge, all secrets are redacted at every boundary, a budget preflight runs before any network
call, and malformed or unsafe output is refused deterministically rather than crashing.

## Glossary

- **Rector**: The overall system that orchestrates a deterministic chat pipeline (triage → context → planner → skeptic → crucible → DAG → executor → validation/healing → synthesis).
- **Symbolic_Control_Plane**: The deterministic, non-LLM components of Rector that validate, budget, and decide; they retain final authority over any plan an external provider proposes.
- **Orchestration_Config_Parser**: The component (`parseOrchestrationConfig`) that reads and validates `ORCHESTRATOR_MODE` and provider configuration without performing network I/O.
- **Connection_Test_Service**: The component (`runConnectionTest`) backing `POST /api/setup/test-connection` that verifies a single provider's credentials with at most one network ping.
- **Chat_Runner**: The mode-aware dispatcher (`runChat`) that routes a chat run to the deterministic local path or the external BYOK path.
- **Live_Planner**: The component (`runLivePlanner`) that prompts a configured provider, validates the returned plan, retries once on failure, and otherwise emits a structured blocker.
- **Budget_Gate**: The existing budget evaluation logic (`evaluateBudget` / `invokeWithBudget`) used to authorize provider calls.
- **ORCHESTRATOR_MODE**: The environment variable selecting orchestration mode; permitted values are `local` and `external`.
- **Local_Mode**: Orchestration mode in which the pipeline runs provider-free with all-zero budget and zero network calls.
- **External_Mode**: Orchestration mode in which the planning phase uses a configured BYOK provider.
- **Orchestration_Config_Error**: The error (`OrchestrationConfigError`) thrown for an invalid mode or a misconfigured external mode; carries a redacted `setupHint`.
- **Configured_Provider**: A supported provider whose `validateConfig()` check passes for the current environment.
- **Provider_Ping**: A single minimal provider invocation (one short system+user message, small `maxOutputTokens`) used by the Connection_Test_Service.
- **Planner_Output_Schema**: The existing Zod schema (`PlannerOutputSchema`) plus invariant check (`validatePlannerOutput`) that a plan must satisfy.
- **Planner_Input_Schema**: The existing Zod schema (`PlannerInputSchema`) that planner input must satisfy.
- **Provider_Call_Metadata**: The recorded payload (`ProviderCallMetadataSchema`) describing provider, model, route, usage, attempts, and repair status on the `PLANNING` run event.
- **Planner_Blocker**: A structured, redacted result with code `BUDGET_DENIED`, `PLANNER_INVALID`, or `PROVIDER_ERROR`.
- **Redaction_Layer**: The existing helpers (`redactString` / `redactSecrets`) applied at every trust boundary.
- **Run_Event**: A persisted record of a phase transition in the run state machine.
- **LLM_Usage**: The accumulated token and cost record (`LLMUsage`) across provider calls.

## Requirements

### Requirement 1: Orchestration Mode Configuration and Startup Validation (ORN-31)

**User Story:** As an operator, I want a single orchestration mode switch validated at startup, so that Rector runs provider-free by default and only enters BYOK mode when a supported provider is correctly configured.

#### Acceptance Criteria

1. WHEN orchestration configuration is parsed AND the ORCHESTRATOR_MODE variable is unset, empty, or consists solely of whitespace characters, THE Orchestration_Config_Parser SHALL resolve the orchestration mode to local AND return an orchestration configuration whose configured-provider list is empty.
2. IF the orchestration mode is external AND no Configured_Provider validates, THEN THE Orchestration_Config_Parser SHALL throw an Orchestration_Config_Error with code EXTERNAL_MODE_NO_PROVIDER and a redacted setup hint that names the required environment variable key names.
3. THE Orchestration_Config_Parser SHALL exclude every provider secret value from the returned orchestration configuration and from every Orchestration_Config_Error message.
4. IF the ORCHESTRATOR_MODE variable holds a non-empty, non-whitespace value that does not exactly match the case-sensitive string local or external, THEN THE Orchestration_Config_Parser SHALL throw an Orchestration_Config_Error with code ORCHESTRATOR_MODE_INVALID and a redacted setup hint.
5. WHEN the orchestration mode is external AND at least one Configured_Provider validates, THE Orchestration_Config_Parser SHALL return an orchestration configuration that lists each provider whose configuration validated.
6. THE Orchestration_Config_Parser SHALL complete configuration parsing without performing any network request.

### Requirement 2: Provider Connection-Test Endpoint (ORN-32)

**User Story:** As an operator, I want to verify a single provider's credentials with one minimal ping, so that I can confirm BYOK setup before enabling external mode without leaking secrets.

#### Acceptance Criteria

1. IF the resolved provider's configuration validation fails, THEN THE Connection_Test_Service SHALL return a response with ok set to false, code CONFIG_INVALID, and networkAttempted set to false, without performing any provider network call.
2. THE Connection_Test_Service SHALL perform at most one provider network call per connection test.
3. THE Connection_Test_Service SHALL exclude the provider API key, Authorization header, and raw provider response body from every connection-test response and error message.
4. IF the requested providerId is not a supported provider identifier, THEN THE Connection_Test_Service SHALL return a response with ok set to false, code CONFIG_INVALID, and networkAttempted set to false, without performing any provider network call.
5. WHEN the Provider_Ping succeeds, THE Connection_Test_Service SHALL return a response with ok set to true, the echoed providerId, the resolved model identifier, and networkAttempted set to true.
6. IF the Provider_Ping fails with a provider or network error, THEN THE Connection_Test_Service SHALL return a response with ok set to false, the provider error code, a redacted error message, and networkAttempted set to true.

### Requirement 3: Mode-Aware Chat Runner with Budget Preflight (ORN-33)

**User Story:** As a Rector maintainer, I want the chat runner to dispatch by orchestration mode, so that the local path stays an unchanged regression baseline and the external path adds a budgeted, observable planner step.

#### Acceptance Criteria

1. WHILE the orchestration mode is local, THE Chat_Runner SHALL produce a run whose phase sequence equals the existing createFakeChatRun phase sequence AND whose costEstimate USD, actualCost USD, actualCost model-call count, tokenEstimate input count, and tokenEstimate output count are all zero.
2. WHILE the orchestration mode is local, THE Chat_Runner SHALL obtain the plan from the createFakePlan source.
3. WHEN a chat run executes in external mode, THE Chat_Runner SHALL complete a Budget_Gate preflight evaluation before initiating any provider network call.
4. IF a Budget_Gate preflight evaluation in external mode is not allowed, THEN THE Chat_Runner SHALL perform zero provider network calls for that run.
5. WHEN an external-mode chat run completes the planning phase successfully, THE Chat_Runner SHALL record Provider_Call_Metadata that conforms to the Provider_Call_Metadata schema on the PLANNING Run_Event.
6. WHEN an external-mode chat run completes the planning phase successfully, THE Chat_Runner SHALL map the reported estimated USD into the run costEstimate USD field AND the reported input and output token counts into the run tokenEstimate input and output fields.
7. IF the Live_Planner returns a Planner_Blocker, THEN THE Chat_Runner SHALL transition the run to FAILED for code PLANNER_INVALID or to NEEDS_DECISION for code BUDGET_DENIED or PROVIDER_ERROR, AND SHALL return a structured result without propagating an exception past the route handler.
8. WHILE running in either orchestration mode, THE Chat_Runner SHALL execute the skeptic, crucible, DAG compilation, executor, validation, and synthesis phases in that fixed order, producing identical phase outputs for identical phase inputs.

### Requirement 4: Live Planner Agent with Validation and Single Repair Retry (ORN-34)

**User Story:** As a Rector maintainer, I want the live planner to validate provider output to the same safety bar as the fake plan, so that the symbolic control plane never executes a malformed or unsafe plan.

#### Acceptance Criteria

1. WHEN the provider returns content, THE Live_Planner SHALL validate the parsed JSON against the Planner_Output_Schema and the validatePlannerOutput invariants before returning a status of ok.
2. IF the first provider response is not valid JSON or fails validation, THEN THE Live_Planner SHALL issue exactly one repair prompt to the provider.
3. THE Live_Planner SHALL perform no more than two provider calls per invocation.
4. IF the planner output remains invalid after exactly one repair attempt, THEN THE Live_Planner SHALL resolve with a structured Planner_Blocker whose code is PLANNER_INVALID rather than raising an exception, AND SHALL perform no further provider call.
5. THE Live_Planner SHALL redact the Planner_Blocker message and details so that no provider secret, API key, or raw model output appears in the returned blocker.
6. WHEN the returned blocker code is PLANNER_INVALID, THE Live_Planner SHALL include in the blocker details the identifiers of the failing schema fields without including raw model output.
7. WHEN constructing each provider call, THE Live_Planner SHALL evaluate the Budget_Gate before invoking the provider.
8. IF a Budget_Gate evaluation is not allowed, THEN THE Live_Planner SHALL return a BUDGET_DENIED Planner_Blocker AND SHALL NOT invoke the provider.
9. THE Live_Planner SHALL validate input against the Planner_Input_Schema before constructing any prompt.
10. WHEN constructing a provider call, THE Live_Planner SHALL request a JSON object response format from the provider.
11. IF the provider invocation throws a provider error, THEN THE Live_Planner SHALL return a redacted PROVIDER_ERROR Planner_Blocker.
12. THE Live_Planner SHALL accumulate LLM_Usage across every provider call performed AND report the total token count and total cost in the result.
