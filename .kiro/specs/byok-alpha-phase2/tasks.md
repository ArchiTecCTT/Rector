# Implementation Plan: BYOK Alpha Phase 2 (ORN-35 → ORN-38)

## Overview

This plan turns the remaining deterministic phases of Rector's chat loop into a real
neuro-symbolic coding agent, in TypeScript, building on the Phase 1 primitives
(`evaluateBudget` in `src/security/budget.ts`, `redactString`/`redactSecrets` in
`src/security/redaction.ts`, the live-agent machinery in `src/orchestration/planner.ts`, the
`SandboxAdapter` contract and `isSafeRelativePath` in `src/sandbox/index.ts`, and the mode-aware
`runChat` in `src/orchestration/chatRunner.ts`). It adds a live skeptic (ORN-35), a live
synthesizer (ORN-36), a safe workspace executor (ORN-37), and a real bounded healing loop (ORN-38).

Work proceeds bottom-up so each step builds on the previous and ends wired into the external chat
runner: shared test generators, then the safe workspace executor and its DAG bridge (the only path
to real I/O), then the live skeptic and live synthesizer, then the bounded healing loop, and finally
the external-runner wiring plus cross-cutting redaction and regression coverage. The symbolic
control plane stays in charge throughout — budget preflight before any call, deterministic schema
validation, workspace containment, command allowlist/denylist, bounded healing, and redaction at
every trust boundary. Local provider-free mode stays the default and the `npm test` regression
baseline; no test requires an API key or real network. Property-based tests use `fast-check`
(already a dev dependency from Phase 1) and cover the 9 correctness properties from the design; all
provider interactions are mocked and the workspace filesystem is injected via `fsImpl`.

## Tasks

- [x] 1. Extend the shared property-test harness for Phase 2
  - [x] 1.1 Add Phase 2 fast-check arbitraries and test doubles
    - Extend `tests/support/byokArbitraries.ts` with: arbitrary relative/absolute/`..`-laden/symlink
      candidate paths, an injectable in-memory `WorkspaceFs` double (supporting `realpathSync`, read,
      list, write) with configurable symlink entries, arbitrary destructive vs allowlisted command
      strings, arbitrary failing DAGs and always-failing repair agents, valid `SkepticReviewDraft`
      and `SynthesisDraft` generators plus adversarial/malformed variants, and arbitrary key-like
      secret strings injectable into prompts, command output, file content, and failure messages
    - Reuse the existing spy `LLMProvider` double (invoke counter, scripted responses, estimate)
    - _Requirements: 8.3 (zero-network), 7.5 (enables secret-leak coverage P1–P9)_

- [ ] 2. Safe workspace path resolution and command enforcement (ORN-37)
  - [x] 2.1 Implement `resolveWithinWorkspace` and sandbox operation schemas
    - In `src/sandbox/index.ts`: add `SandboxOperationKindSchema`, `SandboxDenialReasonSchema`,
      `SandboxOperationSchema`, `SandboxOperationResultSchema`, `SandboxApprovalSchema`, and the pure
      `resolveWithinWorkspace(workspaceRoot, candidatePath, fsImpl?)` containment check
    - Apply checks in the fixed order empty-path (`INVALID_PATH`) → absolute (`ABSOLUTE_PATH`) →
      `..` segment (`PATH_ESCAPE`) → symlink realpath escape (`SYMLINK_ESCAPE`); reuse
      `isSafeRelativePath` as the first cheap gate; on success return an absolute path equal to or a
      descendant of the workspace root; perform no I/O on a denied path
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

  - [ ] 2.2 Write property test for workspace-root containment
    - **Property 2: No path escapes the workspace root**
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7**
    - Add to `tests/workspaceSandbox.test.ts`; generate adversarial paths and injected `fsImpl`
      symlinks; assert each is denied with the correct `denialReason`, the resolved path (when ok) is
      contained, and no read/list/write touched an out-of-root path

  - [ ] 2.3 Implement `WorkspaceSandboxAdapter.operate`
    - In `src/sandbox/index.ts`: add `WorkspaceSandboxOptions` and `WorkspaceSandboxAdapter`
      (`metadata.localOnly = true`, `networkAccess = false`) with `operate(operation)`
    - Support `READ_FILE`, `LIST_DIR`, `PROPOSE_PATCH` (emit a `PatchArtifact`, never write without a
      matching `FILE_WRITE` approval → `NEEDS_APPROVAL`), and `RUN_COMMAND`; deny `kind:"shell"` or
      shell metacharacters (`ARBITRARY_SHELL_DISABLED`), off-allowlist commands
      (`COMMAND_NOT_ALLOWLISTED`), and destructive-denylist commands (`DESTRUCTIVE_COMMAND_BLOCKED`,
      precedence over allowlist); require a matching `SandboxApproval` for risky writes/commands
      (`NEEDS_APPROVAL`); enforce a 60s command timeout (`COMMAND_TIMEOUT`, capture partial output);
      capture `stdout`/`stderr` as artifacts bounded to 262144 bytes; set `networkCalls` to 0;
      withhold `resolvedPath` on denial; redact `stdout`/`stderr`/`fileContent` and every artifact
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 7.2_

  - [ ] 2.4 Write property test for destructive-command precedence
    - **Property 3: Destructive commands are always blocked**
    - **Validates: Requirements 4.3**
    - Add to `tests/workspaceSandbox.test.ts`; generate destructive command/arg combinations
      (including ones also on the allowlist); assert `status === "DENIED"`,
      `denialReason === "DESTRUCTIVE_COMMAND_BLOCKED"`, and the injected command runner ran 0 times

  - [ ] 2.5 Write property test for arbitrary-shell denial
    - **Property 4: Arbitrary shell is denied by default**
    - **Validates: Requirements 4.1**
    - Add to `tests/workspaceSandbox.test.ts`; for any `kind:"shell"` operation assert
      `status === "DENIED"` and `denialReason === "ARBITRARY_SHELL_DISABLED"` with no process spawned

  - [ ] 2.6 Write unit tests for allowlist, approval, timeout, and capture
    - Cover off-allowlist denial, `NEEDS_APPROVAL` for unapproved writes/commands and the unapproved
      `PatchArtifact`, command timeout with partial-output capture, stream truncation at 262144 bytes,
      `networkCalls: 0`, and `READ_FILE`/`LIST_DIR` success paths
    - Add to `tests/workspaceSandbox.test.ts`
    - _Requirements: 4.2, 4.4, 4.5, 4.6, 4.7, 4.8_

- [ ] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. DAG-to-sandbox execution bridge (ORN-37)
  - [ ] 4.1 Implement `executeDagThroughSandbox` and `ExecutionArtifact`
    - Create `src/orchestration/sandboxExecutor.ts` mapping DAG nodes to `SandboxOperationInput`s and
      driving them through `WorkspaceSandboxAdapter.operate` (the only bridge to real I/O); add
      `ExecutionArtifactSchema` and record redacted, length-bounded `preview`s on EXECUTING/VALIDATING
      payloads; keep `executorSimulator` as the local default and only split modes if needed
    - _Requirements: 4.7, 4.8, 7.2_

  - [ ] 4.2 Write unit tests for the sandbox execution bridge
    - Cover node→operation mapping for each kind, artifact recording shape, and that denied/needs-
      approval operations surface as structured results (no throw)
    - Add to `tests/sandboxExecutor.test.ts`
    - _Requirements: 4.7, 4.8_

- [ ] 5. Live skeptic agent with budget preflight and single repair (ORN-35)
  - [ ] 5.1 Implement skeptic prompt builders
    - In `src/orchestration/prompts.ts`: add `buildSkepticPrompt(input)` (system rules + JSON contract
      for `{ verdict, findings }` + redacted plan/context) and
      `buildSkepticRepairPrompt(input, priorContent, errorSummary)`
    - _Requirements: 1.1, 1.5_

  - [ ] 5.2 Implement `runLiveSkeptic`
    - In `src/orchestration/skeptic.ts`: add `LiveSkepticStatus`, `SkepticReviewDraftSchema`,
      `SkepticBlockerSchema`, `LiveSkepticResult`, `LiveSkepticInput`, `LiveSkepticDeps`, and
      `runLiveSkeptic`; keep `reviewPlanWithSkeptic`
    - Run `evaluateBudget` preflight before each `provider.invoke` (including the repair call);
      request `json_object`; parse and validate against `SkepticReviewDraftSchema`; stamp
      `reviewedPlanId`/`planGoal` from the planner output and `createdAt` from the clock; recompute
      `verdict` from finding severities (any `BLOCKER` → `BLOCKED`, else any finding →
      `NEEDS_REVISION`, else `SOUND`); `SkepticReviewSchema.parse` the assembled review; issue exactly
      one repair prompt then return `SKEPTIC_INVALID` (`attempts = 2`, no third call); bound each
      invocation to 60s counting a timeout as one attempt; emit `BUDGET_DENIED`/`PROVIDER_ERROR`
      blockers; accumulate `LLMUsage`; redact `message`/`details`; never throw
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 6.1, 6.3, 6.5, 6.6, 7.1, 9.4_

  - [ ] 5.3 Write property test for skeptic schema conformance or structured blocker
    - **Property 7: Live skeptic output always conforms to the schema or yields a structured blocker**
    - **Validates: Requirements 1.1, 1.3, 1.5, 1.6, 9.4**
    - Add to `tests/liveSkeptic.test.ts`; for arbitrary valid/malformed/schema-invalid provider
      outputs assert `runLiveSkeptic` never throws, an `ok` review passes `SkepticReviewSchema` with a
      severity-derived verdict, malformed cases yield `SKEPTIC_INVALID` after exactly one repair, and
      `count(provider.invoke) <= 2`

  - [ ] 5.4 Write property test for skeptic budget preflight
    - **Property 8: Budget denial precedes the network call (skeptic)**
    - **Validates: Requirements 6.1, 6.3**
    - Add to `tests/liveSkeptic.test.ts`; for arbitrary sub-threshold budgets assert a `BUDGET_DENIED`
      blocker, provider cost 0 USD, and the spy `invoke` count exactly 0

  - [ ] 5.5 Write unit tests for `runLiveSkeptic`
    - Valid first try, valid after repair, verdict recomputation overriding a dishonest model verdict,
      `PROVIDER_ERROR` mapping with redacted message/details and no raw body, 60s timeout counted as
      one attempt, usage accumulation, and the crucible accepting the `ok` review unchanged
    - Add to `tests/liveSkeptic.test.ts`
    - _Requirements: 1.2, 1.3, 1.4, 1.7, 1.8, 1.9, 6.5, 7.1_

- [ ] 6. Live synthesizer agent with evidence citations and fallback (ORN-36)
  - [ ] 6.1 Implement synthesizer prompt builders and synthesis schema relaxation
    - In `src/orchestration/prompts.ts`: add `buildSynthesizerPrompt(input)` and
      `buildSynthesizerRepairPrompt(input, priorContent, errorSummary)`
    - Relax `BrainstemSynthesis.providerCalls` from the literal `0` to a non-negative integer
      (additive) so real provider usage can be recorded
    - _Requirements: 2.1, 2.4_

  - [ ] 6.2 Implement `runLiveSynthesizer`
    - In `src/orchestration/synthesizer.ts`: add `LiveSynthesisStatus`, `SynthesisCitationSchema`,
      `SynthesisDraftSchema`, `LiveSynthesisResult`, `LiveSynthesizerDeps`, and `runLiveSynthesizer`;
      keep `synthesizeChatBrainstemResponse`
    - Redact every `BrainstemSynthesisInput` field before prompt construction; budget preflight before
      each call; request `json_object`; validate against `SynthesisDraftSchema`; require non-empty
      `citations` (each referencing an execution artifact or validation result) whenever the run
      carried execution/validation evidence, routing a citation-free answer to repair-then-fallback;
      one repair prompt, at most two calls; on any budget/provider/validation/post-repair failure set
      `status:"fallback"` and return the deterministic synthesis (cost 0 USD on budget denial);
      include failed validation output rather than omitting it; redact the assembled
      `response`/`citations` before returning; never throw
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 6.2, 6.4, 7.5_

  - [ ] 6.3 Write property test for synthesizer budget preflight and fallback
    - **Property 8: Budget denial precedes the network call (synthesizer)**
    - **Validates: Requirements 6.2, 6.4**
    - Add to `tests/liveSynthesizer.test.ts`; for arbitrary sub-threshold budgets assert
      `status === "fallback"`, the deterministic synthesis is returned, provider cost 0 USD, and the
      spy `invoke` count exactly 0

  - [ ] 6.4 Write unit tests for `runLiveSynthesizer`
    - Valid first try with citations, citation-free answer rejected → repair → fallback, fallback on
      provider error and post-repair non-conformance, redaction of input and assembled
      `response`/`citations`, and failed validation output preserved in the answer
    - Add to `tests/liveSynthesizer.test.ts`
    - _Requirements: 2.2, 2.3, 2.5, 2.6, 2.7, 2.8_

- [ ] 7. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 8. Bounded validation and healing loop over real failures (ORN-38)
  - [ ] 8.1 Extend healing schemas and the repair-agent contract
    - In `src/orchestration/validationHealing.ts`: add `APPLY_PATCH` to `HealingActionTypeSchema`
      (additive), add `HealingRoundRecordSchema`, `RepairPatchProposal`, and the `LiveRepairAgent`
      type; extend `ValidateAndHealExecutionInput` with optional `repairAgent`, `sandbox`,
      `contextPack`, and `run`; add the additive `rounds: HealingRoundRecord[]` field to
      `HealingLoopResultSchema`
    - _Requirements: 5.1, 5.6_

  - [ ] 8.2 Implement bounded live repair in `validateAndHealExecution`
    - Reuse `classifyExecutionFailures` and the `maxHealingAttempts` bound (configured 1–10); when a
      `repairAgent` and `sandbox` are provided and the failure is safe to auto-heal (not `PERMISSION`,
      not otherwise unsafe), redact the failed output, request a patch proposal, and apply it ONLY via
      `sandbox.operate({ kind: "PROPOSE_PATCH", ... })` with an approval; re-run validation and append
      exactly one `HealingRoundRecord` per round (`repairApplied === true` ⟹ `patchArtifactId` set to
      the emitted `PatchArtifact` id); return `SUCCEEDED` on re-validation pass with artifacts
      preserved, `NEEDS_DECISION` on unsafe/`PERMISSION` failures without a repair, and `FAILED` with
      the final result, preserved artifacts, and a redacted explanation on exhaustion; when no
      `repairAgent`/`sandbox` is provided, heal deterministically by retrying the node (Phase 1
      behaviour); preserve failed validation output; never write files directly or via shell; never
      throw
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.7, 5.8, 5.9, 5.10, 5.11, 7.3_

  - [ ] 8.3 Write property test for bounded healing
    - **Property 5: Healing rounds are always bounded**
    - **Validates: Requirements 5.1**
    - Add to `tests/validationHealing.test.ts`; with an always-failing repair agent and executor over
      arbitrary failing DAGs and bounds, assert termination, `status === "FAILED"`,
      `rounds.length <= boundedAttempts(maxHealingAttempts)`, executor invocations within bound, and
      all artifacts preserved

  - [ ] 8.4 Write property test for patch provenance
    - **Property 9: Patches are applied only through the safe executor**
    - **Validates: Requirements 5.3, 5.6, 5.11**
    - Add to `tests/validationHealing.test.ts`; for arbitrary healing runs that apply a repair, assert
      every `HealingRoundRecord` with `repairApplied === true` carries a `patchArtifactId` equal to a
      `PatchArtifact` id emitted by `input.sandbox`, and no file write occurred outside
      `sandbox.operate`

  - [ ] 8.5 Write unit tests for the healing loop
    - Deterministic retry fallback when no repair agent/sandbox, `NEEDS_DECISION` on `PERMISSION`
      failures, `SUCCEEDED` after a successful patch, failed validation output preserved, and the
      redacted explanation on exhaustion
    - Add to `tests/validationHealing.test.ts`
    - _Requirements: 5.2, 5.4, 5.5, 5.7, 5.8, 5.9, 5.10, 7.3_

- [ ] 9. Wire the live agents and safe executor into the external chat runner
  - [ ] 9.1 Integrate Phase 2 steps into `runExternalChatRun`
    - In `src/orchestration/chatRunner.ts`: swap the heuristic skeptic for `runLiveSkeptic`, route the
      EXECUTING/VALIDATING/HEALING phases through `executeDagThroughSandbox` +
      `validateAndHealExecution` with the live repair agent and `WorkspaceSandboxAdapter`, and produce
      the final answer via `runLiveSynthesizer`; record `ProviderCallMetadata` on the `SKEPTIC_REVIEW`
      and `SYNTHESIZING` events; on a `SkepticBlocker` terminate the run `FAILED`; map healing
      `NEEDS_DECISION`/`FAILED` to the matching run status with artifacts preserved; pass provider
      metadata, execution artifacts, and healing payloads through `redactSecrets` before persistence;
      keep the local path byte-for-byte unchanged
    - _Requirements: 9.1, 9.2, 9.3, 9.7, 9.8, 7.4, 7.6, 8.1, 8.4_

  - [ ] 9.2 Write unit tests for control-plane recording and refusal
    - Cover `ProviderCallMetadata` on `SKEPTIC_REVIEW`/`SYNTHESIZING`, skeptic blocker → `FAILED`,
      healing `NEEDS_DECISION` → `NEEDS_DECISION`, healing `FAILED` → `FAILED` with artifacts, and
      that no live failure escapes as an unhandled throw
    - Add to `tests/chatRunner.test.ts`
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8_

- [ ] 10. Cross-cutting redaction and regression coverage
  - [ ] 10.1 Write property test for no-secret-leak across the external loop
    - **Property 6: No secret appears in any artifact, event, trace, response, or error**
    - **Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5, 7.6**
    - Add to `tests/byokRedaction.test.ts`; inject an arbitrary secret into prompts, command output,
      file content, and failure messages; drive the full external loop with a mocked provider and
      injected `fsImpl`; assert the secret substring is absent from every persisted event, artifact,
      sandbox result, skeptic review, synthesis response/citation, blocker, and thrown error

  - [ ] 10.2 Write property test for local-mode regression baseline
    - **Property 1: Local mode output is unchanged (regression baseline)**
    - **Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5**
    - Add to `tests/chatRunner.test.ts`; for arbitrary prompts assert the local-mode phase sequence,
      output field set, section ordering, `costEstimate.usd === 0`, `actualCost.modelCalls === 0`, and
      zero provider/network calls match the Phase 1 baseline

  - [ ] 10.3 Write external-mode end-to-end integration test
    - Drive a full external run through `createApp` with an injected mocked `ModelRouter`/provider and
      `WorkspaceSandboxAdapter` (planner → live skeptic → crucible → DAG → safe executor → bounded
      healing → live synthesizer); assert provider/cost metadata on the events, citations present, and
      no secret leakage in the HTTP response body (supertest)
    - Add `tests/byokExternalE2E.test.ts`
    - _Requirements: 9.1, 9.2, 2.2, 7.5_

- [ ] 11. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP; they are all test sub-tasks.
- `fast-check` is already a dev dependency from Phase 1; all provider interactions are mocked and the
  workspace filesystem is injected via `fsImpl`, so no API key and no real network are needed for
  `npm test`.
- Each property sub-task references a specific property from the design and the requirements clause it
  validates, placed close to the implementation it checks to catch errors early.
- Schema changes are additive (`APPLY_PATCH`, `HealingRoundRecord`, `rounds[]`, the `providerCalls`
  relaxation) to preserve backward compatibility and the Phase 1 local path.
- The local path stays byte-for-byte the current deterministic baseline; external mode differs only
  in the live skeptic/synthesizer steps, the safe executor, the real healing loop, and the recorded
  provider/cost metadata.
- Checkpoints validate incrementally; the full verification set is `npm test`, `npm run build`, and
  `npm run check`.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "5.1"] },
    { "id": 1, "tasks": ["2.2", "2.3", "6.1"] },
    { "id": 2, "tasks": ["2.4", "2.5", "2.6", "4.1", "5.2"] },
    { "id": 3, "tasks": ["4.2", "5.3", "5.4", "5.5", "6.2"] },
    { "id": 4, "tasks": ["6.3", "6.4", "8.1"] },
    { "id": 5, "tasks": ["8.2"] },
    { "id": 6, "tasks": ["8.3", "8.4", "8.5", "9.1"] },
    { "id": 7, "tasks": ["9.2", "10.1", "10.2", "10.3"] }
  ]
}
```
