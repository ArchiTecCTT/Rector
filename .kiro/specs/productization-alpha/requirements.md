# Requirements Document

## Introduction

Rector Productization Alpha makes the already-built local-first BYOK neuro-symbolic coding/orchestration agent usable as a hassle-free desktop/web product. The symbolic and BYOK core is complete: a provider-free local deterministic mode plus an external BYOK mode with a live planner, skeptic, synthesizer, safe workspace executor, validation/healing loop, persistence, SSE streaming, a cost dashboard, and cumulative budget enforcement.

This effort is about **productization only**. It does not rebuild, replace, or remove the core control plane. The provider-free local deterministic mode remains the regression baseline and must keep working. No requirement here introduces real provider or network calls into the automated test suite; tests use deterministic test doubles and mocks. All work must continue to redact secrets at every boundary, preserve the existing chat/trace UX, preserve sandbox safety constraints, and keep the established verification gates passing.

The scope is the ten productization deliverables from the architecture roadmap (setup wizard, provider key test, workspace safety panel, benchmark harness, prompt hardening, desktop shell spike, local secret storage, TiDB smoke test path, run approval UX, and mobile companion design) plus cross-cutting non-functional requirements.

## Glossary

- **Rector**: The local-first BYOK neuro-symbolic AI coding/orchestration agent that is the subject of this productization effort.
- **Setup_Wizard**: The browser UI surface that displays Rector configuration readiness and current mode.
- **Setup_API**: The server-side API endpoints that expose redacted setup and configuration status to the UI.
- **Connection_Test_API**: The existing `/api/setup/test-connection` endpoint used to validate BYOK provider credentials.
- **Provider_Test_Panel**: The UI surface that lets a user run a provider connection test and view the result.
- **Workspace_Safety_Panel**: The UI surface that displays the configured workspace root and sandbox safety policy.
- **Sandbox**: The safe workspace containment layer (`src/sandbox/index.ts`, `src/orchestration/sandboxExecutor.ts`) that enforces path and command constraints.
- **Benchmark_Harness**: The repeatable suite that runs Rector against fixture workspaces and records structured results.
- **Test_Double**: A deterministic scripted provider or component substituted for a real provider in tests and provider-free runs.
- **Fixture_Workspace**: A temporary, isolated repository or directory used as input for a benchmark task.
- **Benchmark_Result**: The structured record for a single benchmark task containing result, patch, commands, cost estimate, duration, and final status.
- **Prompt_Set**: The collection of live planner, skeptic, repair, and synthesizer prompts (`src/orchestration/prompts.ts` and related modules).
- **Desktop_Shell_Decision**: The recorded decision document selecting Tauri or Electron for the first desktop shell.
- **Secret_Store**: The abstraction for storing and checking provider secrets without exposing raw values.
- **TiDB_Smoke_Test**: The manual, documented path that validates the optional TiDB Cloud persistence driver.
- **Approval_Flow**: The UI/API flow that lets a user approve or deny operations in `NEEDS_APPROVAL` or runs in `NEEDS_DECISION`.
- **Event_Log**: The persisted run event record used for trace, audit, and replay.
- **Mobile_Companion_Design**: The design-only document describing a mobile control surface and its security model.
- **Redaction_Layer**: The secret-scrubbing layer (`src/security/redaction.ts`) applied at persistence, streaming, API, and UI boundaries.
- **Local_Mode**: The provider-free deterministic orchestration mode (`ORCHESTRATOR_MODE=local`) that serves as the regression baseline.
- **External_Mode**: The BYOK orchestration mode (`ORCHESTRATOR_MODE=external`) that calls live providers.
- **Verification_Gates**: The required checks: `npm test`, `npm run build`, `npm run check`, `node scripts/generate-roadmap-issues.js --check`, and `node scripts/export-linear-issues.js --check`.

## Requirements

### Requirement 1: Setup Wizard UI

**User Story:** As a first-run Rector user, I want a browser setup surface that shows my configuration status, so that I can understand what is needed before BYOK mode works without reading docs or editing `.env` manually.

#### Acceptance Criteria

1. WHEN the Setup_Wizard is opened, THE Setup_Wizard SHALL display whether Rector is running in Local_Mode or External_Mode.
2. WHEN the Setup_Wizard is opened, THE Setup_Wizard SHALL display exactly one readiness status from {Ready, Incomplete, Error} for each of the provider, persistence, workspace, and budget configuration categories.
3. WHEN the Setup_API returns configuration status, THE Setup_API SHALL pass all values through the Redaction_Layer before returning them.
4. THE Setup_API SHALL exclude raw environment secret values from every response.
5. THE Setup_Wizard SHALL store no secret values in browser localStorage or sessionStorage.
6. WHERE server-side environment mutation is not yet supported, THE Setup_Wizard SHALL present configuration status with no controls capable of modifying configuration.
7. WHILE the Setup_Wizard is displayed, THE Setup_Wizard SHALL keep the existing chat and trace UI accessible.
8. IF the Setup_API returns an error, THEN THE Setup_Wizard SHALL display an error state and SHALL keep the existing chat and trace UI accessible.
9. IF the Setup_API does not respond within 10 seconds, THEN THE Setup_Wizard SHALL display an error state and SHALL keep the existing chat and trace UI accessible.
10. IF redaction of a value fails, THEN THE Setup_API SHALL omit that value rather than return it.

### Requirement 2: Provider Key Test UI

**User Story:** As a Rector user configuring BYOK, I want to validate my provider credentials from the UI, so that I can confirm a provider works before relying on External_Mode.

#### Acceptance Criteria

1. WHEN the Provider_Test_Panel is displayed, THE Provider_Test_Panel SHALL present a selectable list of all configured providers and SHALL enable the connection-test action only after exactly one provider is selected.
2. WHEN a user triggers a connection test for a selected provider, THE Provider_Test_Panel SHALL invoke the existing Connection_Test_API within 1 second.
3. WHEN a connection test succeeds, THE Provider_Test_Panel SHALL display, within 2 seconds of receiving the API response, a human-language readiness message that contains no API key material.
4. IF provider configuration is missing or invalid, THEN THE Provider_Test_Panel SHALL display a human-language failure message that identifies the failure reason, SHALL contain no API key material, and SHALL retain the user's provider selection.
5. THE Provider_Test_Panel SHALL pass every displayed message through the Redaction_Layer so that no full or partial API key material appears in any displayed message.
6. WHILE a connection test is in progress, THE Provider_Test_Panel SHALL display a loading indicator and SHALL disable the connection-test action.
7. IF a connection test does not return a result within 30 seconds, THEN THE Provider_Test_Panel SHALL terminate the test, clear the loading indicator, and display a human-language timeout failure message that contains no API key material.

### Requirement 3: Workspace Picker and Safety Panel

**User Story:** As a Rector user, I want to see which workspace Rector can touch and what safety rules apply, so that I can trust the agent before it proposes or executes workspace actions.

#### Acceptance Criteria

1. WHEN the Workspace_Safety_Panel is opened, THE Workspace_Safety_Panel SHALL display the configured workspace root as returned by the Setup_API.
2. WHEN the Workspace_Safety_Panel is opened, THE Workspace_Safety_Panel SHALL display the list of allowlisted commands enforced by the Sandbox.
3. WHEN the Workspace_Safety_Panel is opened, THE Workspace_Safety_Panel SHALL display the destructive command protection status as either enabled or disabled.
4. WHEN the Workspace_Safety_Panel is opened, THE Workspace_Safety_Panel SHALL display the approval-required policy indicating which operation categories require user approval before execution.
5. THE Workspace_Safety_Panel SHALL preserve all existing Sandbox containment constraints.
6. THE Workspace_Safety_Panel SHALL provide no mechanism to execute arbitrary commands from the UI.
7. WHERE the redaction policy requires hiding path segments, THE Setup_API SHALL redact the configured workspace root before returning it.
8. IF the configured workspace root or Sandbox safety policy cannot be retrieved, THEN THE Workspace_Safety_Panel SHALL display an error message indicating the safety configuration is unavailable and SHALL present no workspace action controls.

### Requirement 4: Real Task Benchmark Harness

**User Story:** As a Rector maintainer, I want a repeatable benchmark suite over fixture workspaces, so that I can measure whether Rector performs useful coding tasks.

#### Acceptance Criteria

1. THE Benchmark_Harness SHALL execute a defined, version-controlled set of at least three coding tasks, each run against its own isolated Fixture_Workspace.
2. WHEN the Benchmark_Harness runs in its default mode, THE Benchmark_Harness SHALL use deterministic Test_Doubles and SHALL make no real provider or network calls.
3. WHEN a benchmark task completes, THE Benchmark_Harness SHALL record a Benchmark_Result containing the result, patch, executed commands, cost estimate, duration, and final status.
4. THE Benchmark_Harness SHALL write all benchmark output to temporary directories and SHALL NOT modify tracked repository files.
5. IF a benchmark task fails, THEN THE Benchmark_Harness SHALL retain that task's artifacts and logs in its temporary output directory and SHALL record a failed final status in the corresponding Benchmark_Result.
6. WHERE live-provider benchmarking is manually enabled, THE Benchmark_Harness SHALL execute the same defined set of tasks against the configured providers.
7. IF a benchmark task's execution duration exceeds 300 seconds, THEN THE Benchmark_Harness SHALL terminate that task and record a timeout final status in its Benchmark_Result.
8. WHEN a benchmark run completes, THE Benchmark_Harness SHALL produce a summary recording the total task count and the count of tasks per final status.
9. WHILE running in its default mode with deterministic Test_Doubles, THE Benchmark_Harness SHALL produce identical final status values for each task across repeated executions.

### Requirement 5: Prompt Hardening from Benchmark Failures

**User Story:** As a Rector maintainer, I want to improve the live agent prompts using benchmark evidence, so that Rector produces better plans, reviews, repairs, and answers without weakening safety.

#### Acceptance Criteria

1. WHEN a failure mode appears in two or more Benchmark_Result records within a single benchmark cycle, THE Prompt_Set SHALL be updated such that the regression case for that failure mode passes on the next benchmark run.
2. WHEN the Prompt_Set is updated, THE Prompt_Set SHALL retain every safety constraint that was present before the update, verified by the safety constraint test suite passing at 100%.
3. IF a Prompt_Set update causes any safety constraint test to fail, THEN THE System SHALL reject the update and retain the previous Prompt_Set version.
4. WHEN a failure mode is fixed in the Prompt_Set, THE test suite SHALL include a regression case that reproduces that failure mode and asserts the corrected behavior.
5. WHEN the Prompt_Set is updated, THE Prompt_Set SHALL maintain a Local_Mode regression baseline pass rate greater than or equal to the pass rate recorded immediately before the update.
6. IF a Prompt_Set update reduces the Local_Mode regression baseline pass rate below the pre-update pass rate, THEN THE System SHALL reject the update and retain the previous Prompt_Set version.
7. THE Redaction_Layer SHALL prevent any secret from appearing in prompt-related outputs, such that the count of detected secrets in those outputs is zero.

### Requirement 6: Desktop Shell Spike

**User Story:** As a Rector maintainer, I want a recorded decision between Tauri and Electron with a minimal prototype path, so that the first desktop shell can be built on an evaluated foundation.

#### Acceptance Criteria

1. THE Desktop_Shell_Decision SHALL state exactly one recommended shell technology selected from Tauri or Electron.
2. THE Desktop_Shell_Decision SHALL document, for both Tauri and Electron, an assessment of packaging complexity, local server lifecycle management, native folder picker support, secure secret storage, auto-update path, and Windows, macOS, and Linux platform concerns.
3. WHEN the recommendation is stated, THE Desktop_Shell_Decision SHALL provide a rationale that references the documented assessment factors for the recommended technology.
4. THE Desktop_Shell_Decision SHALL include either a minimal prototype path describing the steps to launch the existing Node web application inside the recommended shell, or a documented reason the prototype was deferred.
5. THE Desktop_Shell_Decision work SHALL leave the existing Node web application runnable with all Verification_Gates passing and the Local_Mode regression baseline unchanged.
6. WHERE a new dependency is added for the spike, THE Desktop_Shell_Decision SHALL document the reason the dependency was added and the candidate technology it supports.

### Requirement 7: Local Secret Storage

**User Story:** As a desktop Rector user, I want provider secrets stored through a safe local abstraction, so that I am not required to manually edit `.env` and secrets are never exposed.

#### Acceptance Criteria

1. THE Secret_Store SHALL define an interface that exposes operations to store a provider secret, retrieve a provider secret, and report whether a provider secret is configured.
2. THE Secret_Store SHALL provide a local development implementation of the interface that persists stored provider secrets across application restarts.
3. THE Secret_Store SHALL define its interface so that an OS keychain backing implementation can be added without modifying interface consumers.
4. THE Secret_Store SHALL persist provider secret values in a non-plaintext form by default, such that secret values are not readable from the stored representation as plain text or unencoded JSON.
5. WHEN the Setup_API is queried whether a provider secret is configured, THE Setup_API SHALL return a boolean presence indicator that is true only when a secret value is stored and SHALL exclude the secret value from the response.
6. THE Secret_Store SHALL exclude provider secret values from every API and UI response.
7. IF storing or retrieving a provider secret fails, THEN THE Secret_Store SHALL return a failure indicator without persisting a partial or corrupted secret value.
8. WHEN a Secret_Store operation returns an error, THE Redaction_Layer SHALL redact secret values in that error.

### Requirement 8: TiDB Cloud Smoke Test Path

**User Story:** As a Rector maintainer, I want a documented manual smoke test for optional TiDB Cloud persistence, so that the hosted alpha persistence path is credible while SQLite stays the local default.

#### Acceptance Criteria

1. THE TiDB_Smoke_Test SHALL provide a manual script or documented command path that performs a write-then-read-back cycle against TiDB Cloud persistence using documented environment variables, and that passes only when the read-back record matches the written record field-for-field.
2. IF the TiDB_Smoke_Test write-then-read-back cycle does not match field-for-field, THEN THE TiDB_Smoke_Test SHALL report a failure.
3. WHILE TiDB credentials are absent, THE Verification_Gates SHALL run to completion without requiring TiDB credentials.
4. IF TiDB configuration is missing or incomplete, THEN THE store factory SHALL terminate before opening a network connection, SHALL persist no records, and SHALL return an error identifying the missing or invalid configuration variables.
5. WHEN a TiDB configuration error is reported, THE Redaction_Layer SHALL redact credential values in the error message.
6. WHERE no persistence driver is explicitly configured, THE store factory SHALL use SQLite as the local default persistence driver.

### Requirement 9: Run Approval UX

**User Story:** As a Rector user, I want to approve or deny risky operations from the UI, so that runs needing a decision are not stuck and risky actions are never executed without my consent.

#### Acceptance Criteria

1. WHEN an operation returns `NEEDS_APPROVAL` or a run enters `NEEDS_DECISION`, THE Approval_Flow SHALL present the operation for approval or denial within 2 seconds of the state change.
2. WHILE an operation is awaiting a decision, THE Approval_Flow SHALL display the diff, command, and target path of the operation before any approval action can be submitted.
3. WHEN a user approves or denies an operation, THE Approval_Flow SHALL record the decision, the deciding user identity, and a timestamp in the Event_Log before executing or cancelling the operation.
4. THE Approval_Flow SHALL require an explicit user approval action for every risky shell command and SHALL NOT execute any risky shell command without a recorded user approval.
5. WHEN a user denies an operation, THE Approval_Flow SHALL halt execution of that operation and continue the run to a final answer that excludes the denied operation, leaving any files and targets affected by the denied operation unchanged.
6. WHEN operation details are displayed, THE Redaction_Layer SHALL redact secret values in those details such that no unredacted secret value appears in the displayed diff, command, or target path.
7. IF the Approval_Flow cannot present an operation for decision or cannot record a decision in the Event_Log, THEN THE Approval_Flow SHALL NOT execute the operation, SHALL keep the run in its pending-decision state, and SHALL present an indication that the decision could not be processed.
8. IF no approval or denial decision is received within 30 minutes of the operation being presented, THEN THE Approval_Flow SHALL treat the operation as denied, record the timeout-based denial in the Event_Log, and continue the run per criterion 5.

### Requirement 10: Mobile Companion Design

**User Story:** As a Rector maintainer, I want a design for a mobile companion control surface, so that a future phone client can instruct and monitor agents without executing local workspace code.

#### Acceptance Criteria

1. THE Mobile_Companion_Design SHALL describe a companion architecture that documents each of the following control-surface capabilities: sending instructions to an agent, monitoring run status, approving or denying risky operations, receiving run-completion notifications, and reading run summaries.
2. THE Mobile_Companion_Design SHALL state that the mobile client executes no local workspace code directly, including no shell commands, file-system writes, or build/test execution on the user's workspace.
3. THE Mobile_Companion_Design SHALL specify that the mobile client communicates only with the desktop application or a hosted relay, and never directly with the local workspace.
4. THE Mobile_Companion_Design SHALL document, for each named security risk (stolen device, relay compromise, prompt injection over the mobile channel, and approval spoofing), a description of the risk and at least one mitigation or an explicit residual-risk statement.
5. WHERE the mobile client approves or denies a risky operation, THE Mobile_Companion_Design SHALL specify that the decision is routed through the Approval_Flow and recorded in the Event_Log.
6. THE Mobile_Companion_Design SHALL document an explicit, enumerated list of non-goals for the mobile companion.

### Requirement 11: Cross-Cutting Secret Redaction

**User Story:** As a Rector user, I want secrets redacted everywhere, so that no secret value leaks through any API response or UI surface introduced by productization.

#### Acceptance Criteria

1. WHEN an API response introduced or modified by productization work is returned, THE Redaction_Layer SHALL replace every provider secret value and environment secret value with a fixed redaction placeholder such that no substring of an original secret value appears in the response.
2. WHEN a UI surface introduced or modified by productization work displays content, THE Redaction_Layer SHALL replace every provider secret value and environment secret value with a fixed redaction placeholder such that no substring of an original secret value appears in the rendered output.
3. WHEN an error is returned to a user, THE Redaction_Layer SHALL replace every provider secret value and environment secret value in the error message, error metadata, and any included stack-trace content with a fixed redaction placeholder before the error is returned.
4. WHEN content is emitted over a streaming response introduced or modified by productization work, THE Redaction_Layer SHALL replace every provider secret value and environment secret value with a fixed redaction placeholder before each streamed chunk is transmitted.
5. IF the Redaction_Layer cannot complete redaction of an outbound response, THEN THE Redaction_Layer SHALL suppress the unredacted content and return an error indicating that redaction failed.

### Requirement 12: Preserve Existing Experience and Verification

**User Story:** As a Rector maintainer, I want productization to preserve existing behavior and pass all verification, so that the established product and safety guarantees are not regressed.

#### Acceptance Criteria

1. THE productization work SHALL keep the pre-productization chat and trace UX test outcomes passing.
2. THE productization work SHALL leave the existing Sandbox safety constraints unchanged.
3. WHEN given identical inputs, THE Local_Mode SHALL produce outputs identical to the pre-productization Local_Mode baseline.
4. IF Local_Mode output diverges from the pre-productization baseline for identical inputs, THEN THE Verification_Gates SHALL report a failure.
5. WHEN a productization change is submitted as complete, THE Verification_Gates SHALL pass with zero failures across all five checks.
6. THE automated test suite SHALL make zero real provider calls and zero outbound network calls, using deterministic Test_Doubles.
