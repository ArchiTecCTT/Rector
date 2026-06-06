# Requirements Document

## Introduction

BYOK Alpha Phase 2 (ORN-35 → ORN-38) turns the remaining deterministic phases of Rector's chat loop
into a real neuro-symbolic coding agent while keeping the symbolic control plane in charge. Phase 1
made only the planning phase BYOK-capable; Phase 2 adds a live skeptic agent (ORN-35), a live
synthesizer agent (ORN-36), a safe workspace executor (ORN-37), and a real bounded validation and
healing loop over actual command failures (ORN-38).

The hard product constraint is unchanged from Phase 1: the language model proposes a critique, a
final answer, or a repair patch, and the symbolic control plane budgets every proposal before any
network call, validates its structure deterministically, confines every file and command operation
to the workspace root, blocks destructive commands by default, bounds the healing loop, redacts
every trust boundary, and refuses unsafe output rather than crashing. Local provider-free mode
remains the default and the regression baseline; it must be byte-for-byte identical to the Phase 1
path with zero provider calls, zero cost, and no real network or disk dependency.

These requirements are derived from the approved Phase 2 design document and preserve its component
boundaries, schemas, invariants, and safety guarantees.

## Glossary

- **Control_Plane**: The symbolic orchestration layer that budgets, validates, contains, redacts,
  and refuses unsafe output across every live step.
- **Live_Skeptic**: The external-mode agent (`runLiveSkeptic`) that uses a provider to critique a
  plan and emits a review conforming to the existing `SkepticReviewSchema` (ORN-35).
- **Live_Synthesizer**: The external-mode agent (`runLiveSynthesizer`) that produces the final,
  evidence-cited answer and falls back to the deterministic synthesizer on any failure (ORN-36).
- **Safe_Executor**: The `WorkspaceSandboxAdapter` and `resolveWithinWorkspace` containment gate
  that performs contained file and command operations (ORN-37).
- **Healing_Loop**: The extended `validateAndHealExecution` function that applies bounded live
  repairs over real command failures (ORN-38).
- **Chat_Runner**: `runChat`, which dispatches by `ORCHESTRATOR_MODE` to the local or external path.
- **Repair_Agent**: A `LiveRepairAgent` that proposes a patch from redacted failed output and never
  touches disk itself.
- **Budget_Preflight**: The `evaluateBudget` check performed before any provider call.
- **Workspace_Root**: The absolute directory that bounds every file and command operation.
- **Sandbox_Approval**: An explicit, recorded `SandboxApproval` authorizing a risky write or command.
- **Skeptic_Blocker**: A redacted, structured `SkepticBlocker` returned when the Live_Skeptic cannot
  produce a valid review (codes `BUDGET_DENIED`, `SKEPTIC_INVALID`, `PROVIDER_ERROR`).
- **Local_Mode**: The provider-free default path (`ORCHESTRATOR_MODE = local`) that preserves Phase 1
  behaviour exactly.
- **External_Mode**: The BYOK path (`ORCHESTRATOR_MODE = external`) that activates the live agents and
  the Safe_Executor.
- **Redaction**: Application of `redactString`/`redactSecrets` at a trust boundary.

## Requirements

### Requirement 1: Live skeptic critique generation (ORN-35)

**User Story:** As a Rector operator running in external mode, I want a live skeptic to critique the
plan using a provider, so that plans receive a model-driven safety and quality review while the
control plane stays in charge.

#### Acceptance Criteria

1. WHILE the Chat_Runner operates in External_Mode, WHEN the planner produces a plan output, THE
   Live_Skeptic SHALL critique that planner output and produce a review that conforms to the
   existing `SkepticReviewSchema`.
2. WHEN the Live_Skeptic assembles a review, THE Live_Skeptic SHALL stamp the `reviewedPlanId` and
   `planGoal` from the planner output and the `createdAt` value from the clock.
3. WHEN the Live_Skeptic assembles a review, THE Live_Skeptic SHALL recompute the `verdict` from
   finding severities such that any `BLOCKER` finding yields `BLOCKED`, any other non-empty findings
   yield `NEEDS_REVISION`, and no findings yield `SOUND`.
4. WHEN a Live_Skeptic review is produced with status `ok`, THE Crucible SHALL consume the review
   through `arbitratePlanWithCrucible` without special-casing.
5. WHEN the provider returns malformed or schema-invalid output, THE Live_Skeptic SHALL issue
   exactly one repair prompt before returning any blocker.
6. IF the provider output remains invalid after one repair prompt, THEN THE Live_Skeptic SHALL
   return a `SKEPTIC_INVALID` Skeptic_Blocker with `attempts` equal to 2 and SHALL make no third
   provider call.
7. WHEN the Live_Skeptic returns a result, THE Live_Skeptic SHALL report an `LLMUsage` value equal
   to the sum of usage across all provider attempts.
8. WHEN the Live_Skeptic performs a provider invocation, THE Live_Skeptic SHALL bound that single
   invocation to a 60-second timeout and SHALL count a timed-out invocation as one attempt within
   the two-attempt maximum.
9. IF a provider invocation is unavailable or fails at the transport level, THEN THE Live_Skeptic
   SHALL return a `PROVIDER_ERROR` Skeptic_Blocker, preserve the accumulated `LLMUsage`, and make no
   further provider call.

### Requirement 2: Live synthesizer evidence-cited answer (ORN-36)

**User Story:** As a Rector user in external mode, I want the final answer to cite the evidence it
relied on, so that I can trust the answer is grounded in the actual run state and never leaks
secrets.

#### Acceptance Criteria

1. WHILE the Chat_Runner operates in External_Mode, THE Live_Synthesizer SHALL produce a final
   answer from the run state that conforms to the `SynthesisDraftSchema` and assembles a grounded
   `BrainstemSynthesis`.
2. WHEN the run carried execution or validation evidence, THE Live_Synthesizer SHALL require at
   least one entry in `citations`, and each citation SHALL reference an execution artifact or a
   validation result from the run state.
3. IF the run carried execution or validation evidence and the provider returns an answer with an
   empty `citations` array, THEN THE Live_Synthesizer SHALL treat the answer as invalid and route it
   to the repair-then-fallback path.
4. WHEN the provider returns output that does not conform to `SynthesisDraftSchema`, THE
   Live_Synthesizer SHALL issue exactly one repair prompt and SHALL make at most two total provider
   calls before falling back.
5. IF a budget denial, provider error, validation failure, or post-repair non-conformance occurs,
   THEN THE Live_Synthesizer SHALL set status `fallback` and return the deterministic
   `synthesizeChatBrainstemResponse` result.
6. WHILE the Chat_Runner operates in External_Mode, THE Live_Synthesizer SHALL apply Redaction to
   every `BrainstemSynthesisInput` field before prompt construction such that no configured secret
   value remains in the constructed prompt.
7. WHEN the Live_Synthesizer returns a result, THE Live_Synthesizer SHALL apply Redaction to the
   assembled `response` and `citations` such that no configured secret value remains in either.
8. WHEN the run carried failed validation output, THE Live_Synthesizer SHALL include that failed
   validation output in the returned answer rather than omitting it.

### Requirement 3: Workspace path containment (ORN-37)

**User Story:** As a Rector operator, I want every file operation confined to the workspace root, so
that the agent can never read or write outside the project even via crafted or symlinked paths.

#### Acceptance Criteria

1. WHEN a `READ_FILE`, `LIST_DIR`, or `PROPOSE_PATCH` operation is requested, THE Safe_Executor SHALL
   resolve the candidate path through `resolveWithinWorkspace`, applying validation checks in the
   fixed order of empty-path, absolute-path, parent-traversal (`..`), then symlink-target
   containment, before performing any input or output.
2. IF a candidate path is empty, null, or consists only of whitespace, THEN THE Safe_Executor SHALL
   deny the operation with denial reason `INVALID_PATH` and perform no input or output.
3. IF a candidate path is absolute, THEN THE Safe_Executor SHALL deny the operation with denial
   reason `ABSOLUTE_PATH` and perform no input or output.
4. IF a candidate path contains a `..` segment, THEN THE Safe_Executor SHALL deny the operation with
   denial reason `PATH_ESCAPE` and perform no input or output.
5. IF a candidate path resolves through a symlink to a location outside the Workspace_Root, THEN THE
   Safe_Executor SHALL deny the operation with denial reason `SYMLINK_ESCAPE` and perform no input or
   output.
6. WHEN `resolveWithinWorkspace` returns success, THE Safe_Executor SHALL return a `resolvedPath`
   whose normalized absolute form is equal to, or a descendant of, the Workspace_Root.
7. WHEN an operation is denied, THE Safe_Executor SHALL withhold the resolved absolute path from the
   operation result and set `denialReason` to the value corresponding to the first failed validation
   check in the order defined in criterion 1.

### Requirement 4: Command allowlist, denylist, and approval enforcement (ORN-37)

**User Story:** As a Rector operator, I want command execution restricted to an allowlist with
destructive commands blocked and risky operations gated by approval, so that the agent cannot run
dangerous or arbitrary commands.

#### Acceptance Criteria

1. IF a `RUN_COMMAND` operation requests execution via a shell interpreter or supplies a command
   string containing shell metacharacters, THEN THE Safe_Executor SHALL deny it with denial reason
   `ARBITRARY_SHELL_DISABLED` and spawn no process.
2. IF a `RUN_COMMAND` command is not on the allowlist, THEN THE Safe_Executor SHALL deny it with
   denial reason `COMMAND_NOT_ALLOWLISTED` and spawn no process.
3. IF a `RUN_COMMAND` command matches the destructive denylist, THEN THE Safe_Executor SHALL deny it
   with denial reason `DESTRUCTIVE_COMMAND_BLOCKED` and spawn no process, even when the command also
   appears on the allowlist.
4. IF a mutating write or command execution lacks a matching Sandbox_Approval, where a matching
   Sandbox_Approval has the same operation type and target (the resolved path for writes, the exact
   allowlisted command for commands), THEN THE Safe_Executor SHALL return status `NEEDS_APPROVAL` and
   perform no mutation.
5. WHEN a `PROPOSE_PATCH` operation lacks a matching `FILE_WRITE` Sandbox_Approval for its resolved
   path, THE Safe_Executor SHALL emit an unapproved `PatchArtifact` and perform no write.
6. IF a `RUN_COMMAND` operation exceeds a 60-second execution timeout, THEN THE Safe_Executor SHALL
   terminate the process, deny the operation with denial reason `COMMAND_TIMEOUT`, and capture the
   partial `stdout` and `stderr` produced before termination.
7. WHEN a `RUN_COMMAND` operation completes, THE Safe_Executor SHALL capture `stdout` and `stderr` as
   artifacts, bounding each captured stream to 262144 bytes and truncating any excess.
8. WHEN a `RUN_COMMAND` operation completes, THE Safe_Executor SHALL set `networkCalls` to 0.

### Requirement 5: Bounded validation and healing loop (ORN-38)

**User Story:** As a Rector operator, I want the healing loop to repair real failures within a hard
bound and preserve all artifacts, so that healing can never run unbounded and failures are never
silently hidden.

#### Acceptance Criteria

1. THE Healing_Loop SHALL perform at most `maxHealingAttempts` healing rounds, where
   `maxHealingAttempts` is a configured integer between 1 and 10 inclusive.
2. WHEN a Repair_Agent and Safe_Executor are provided and a failure is safe to auto-heal, where safe
   to auto-heal means the failure classification is not `PERMISSION` and is not otherwise flagged
   unsafe, THE Healing_Loop SHALL redact the failed output before requesting a patch proposal from
   the Repair_Agent.
3. WHEN the Healing_Loop applies a repair patch, THE Healing_Loop SHALL apply it only through
   `Safe_Executor.operate` with a `PROPOSE_PATCH` operation.
4. WHEN a repair patch is applied, THE Healing_Loop SHALL re-run validation and append exactly one
   `HealingRoundRecord` for that round.
5. WHEN re-validation passes after an applied patch, THE Healing_Loop SHALL return status
   `SUCCEEDED` with all artifacts preserved.
6. WHERE a `HealingRoundRecord` has `repairApplied` equal to true, THE Healing_Loop SHALL set
   `patchArtifactId` to the identifier of a `PatchArtifact` emitted by the Safe_Executor.
7. WHEN a Repair_Agent or Safe_Executor is not provided, THE Healing_Loop SHALL heal deterministically
   by retrying the failed node, preserving the Phase 1 behaviour.
8. IF a failure is classified `PERMISSION` or is otherwise unsafe to auto-heal, THEN THE Healing_Loop
   SHALL return status `NEEDS_DECISION` without attempting a repair.
9. IF the healing bound is reached without resolving the failure, THEN THE Healing_Loop SHALL return
   status `FAILED` with the final execution result and all artifacts preserved and a redacted
   explanation.
10. THE Healing_Loop SHALL preserve failed validation output in the returned result rather than
    hiding it.
11. THE Healing_Loop SHALL apply every file mutation only through the Safe_Executor and never by
    writing files directly or via shell.

### Requirement 6: Budget preflight before provider calls (ORN-35/36)

**User Story:** As a Rector operator, I want every live provider call gated by a budget check first,
so that no network cost is incurred when the budget disallows the call.

#### Acceptance Criteria

1. WHEN the Live_Skeptic is about to perform a provider invocation, THE Live_Skeptic SHALL run
   Budget_Preflight first and SHALL perform that provider invocation only after Budget_Preflight
   returns an allow decision.
2. WHEN the Live_Synthesizer is about to perform a provider invocation, THE Live_Synthesizer SHALL
   run Budget_Preflight first and SHALL perform that provider invocation only after Budget_Preflight
   returns an allow decision.
3. IF Budget_Preflight denies the call, THEN THE Live_Skeptic SHALL make zero provider calls, return
   a `BUDGET_DENIED` Skeptic_Blocker, and report a provider cost of 0 USD for that step.
4. IF Budget_Preflight denies the call, THEN THE Live_Synthesizer SHALL make zero provider calls, set
   status `fallback`, return the deterministic `synthesizeChatBrainstemResponse` result, and report a
   provider cost of 0 USD for that step.
5. IF a provider invocation throws a provider error, where a provider error is any thrown exception
   or non-success response returned by the provider, THEN THE Live_Skeptic SHALL return a
   `PROVIDER_ERROR` Skeptic_Blocker with Redaction applied to its `message` and `details` and SHALL
   exclude the raw provider response body from the blocker and from any thrown error.
6. WHEN the Live_Skeptic issues its single repair prompt as a second provider invocation, THE
   Live_Skeptic SHALL run Budget_Preflight before that repair-prompt invocation and SHALL skip the
   repair-prompt invocation when Budget_Preflight returns a deny decision.

### Requirement 7: Secret redaction at every trust boundary

**User Story:** As a Rector operator, I want secrets redacted at every boundary, so that no secret
appears in any artifact, event, response, blocker, or error.

#### Acceptance Criteria

1. WHEN a Skeptic_Blocker is returned, THE Live_Skeptic SHALL apply Redaction to its `message` and
   `details` fields such that no substring matching any value in the configured secret set remains in
   either field.
2. WHEN a sandbox operation result is assembled, THE Safe_Executor SHALL apply Redaction to
   `stdout`, `stderr`, `fileContent`, and every captured artifact such that no substring matching any
   value in the configured secret set remains in any of those fields.
3. WHEN a `HealingRoundRecord` is created, THE Healing_Loop SHALL apply Redaction to the failed
   output fed to the repair prompt and to the record `explanation` such that no substring matching
   any value in the configured secret set remains in either field.
4. WHEN run events are persisted, THE Control_Plane SHALL pass provider call metadata, execution
   artifacts, and healing round payloads through `redactSecrets` before the event is written to
   storage.
5. THE Control_Plane SHALL guarantee that, for any value in the configured secret set, no exact
   substring match of that value is present in any persisted event, artifact, sandbox result,
   skeptic review, synthesis response, citation, blocker, or thrown error message.
6. IF Redaction cannot be applied to a value before it crosses a trust boundary, THEN THE
   Control_Plane SHALL replace the entire value with a fixed redaction placeholder, block persistence
   or emission of the raw value, and surface an error indication that redaction failed.

### Requirement 8: Local mode regression preservation

**User Story:** As a Rector maintainer, I want local mode to remain identical to the Phase 1
baseline, so that the provider-free default stays the trusted regression baseline with zero cost and
no network.

#### Acceptance Criteria

1. WHILE the Chat_Runner operates in Local_Mode, THE Chat_Runner SHALL produce output that matches
   the Phase 1 baseline in phase sequence, output field set, and section ordering, using the
   heuristic skeptic, simulated executor, deterministic healing, and deterministic synthesis.
2. WHILE the Chat_Runner operates in Local_Mode, THE Chat_Runner SHALL report a cost estimate of
   exactly 0 USD and exactly 0 model calls.
3. WHILE the Chat_Runner operates in Local_Mode, THE Chat_Runner SHALL make exactly 0 provider calls
   and 0 outbound network requests.
4. WHILE the Chat_Runner operates in Local_Mode, THE Chat_Runner SHALL preserve the Phase 1 phase
   sequence and synthesis output structure.
5. IF any operation attempts an outbound network request or provider call WHILE the Chat_Runner
   operates in Local_Mode, THEN THE Chat_Runner SHALL block the attempt, complete the run using
   provider-free defaults, retain the run output unchanged, and surface an indication that the
   network or provider call was blocked.

### Requirement 9: Control plane recording and refusal in external mode

**User Story:** As a Rector operator, I want every live step recorded and every blocker handled as a
structured outcome, so that the run never crashes and provider usage is auditable.

#### Acceptance Criteria

1. WHEN the Live_Skeptic finishes in External_Mode, whether it succeeds, returns a blocker, or falls
   back, THE Control_Plane SHALL record `ProviderCallMetadata` on the `SKEPTIC_REVIEW` event.
2. WHEN the Live_Synthesizer finishes in External_Mode, whether it succeeds, returns a blocker, or
   falls back, THE Control_Plane SHALL record `ProviderCallMetadata` on the `SYNTHESIZING` event.
3. IF a live step returns a Skeptic_Blocker, THEN THE Chat_Runner SHALL terminate the run in status
   `FAILED` rather than raising an unhandled error.
4. THE Live_Skeptic SHALL resolve to a structured Skeptic_Blocker outcome, without throwing, for any
   budget, provider, or validation failure.
5. THE Live_Synthesizer SHALL resolve to a `fallback` result, without throwing, for any budget,
   provider, or validation failure.
6. THE Healing_Loop SHALL resolve to a structured result, without throwing, for any failing DAG or
   Repair_Agent.
7. IF the Healing_Loop returns status `NEEDS_DECISION`, THEN THE Chat_Runner SHALL terminate the run
   in status `NEEDS_DECISION`.
8. IF the Healing_Loop returns status `FAILED`, THEN THE Chat_Runner SHALL terminate the run in
   status `FAILED` with all artifacts preserved.
