# Chunk 22 — Safe Code Execution

## Goal

Add a provider-free safe code execution boundary for Rector alpha. The default local executor must be hardened: no arbitrary shell, no network, no implicit filesystem writes, and no cloud sandbox calls.

## Scope

Implement only local deterministic contracts and stubs:

- Sandbox adapter contract for command execution and patch artifacts.
- Hardened safe local executor with an allowlist of fake/local commands.
- Deny arbitrary shell commands by default.
- File-write operations require explicit approval metadata and return approval-gate metadata when missing.
- Patch artifact schema for proposed file changes without applying them.
- E2B and Depot sandbox adapter stubs that expose manifests but never perform network calls.
- Unit tests covering shell denial, allowed fake/local commands, approval-required file writes, patch artifact schema validation, and no-network behavior.

## Out of Scope

- Real shell execution.
- Applying file writes or patches to disk.
- Real E2B/Depot API calls.
- Container isolation, seccomp, VM isolation, or production sandboxing.
- Wiring the executor into the chat brainstem beyond exported contracts.

## Design

Add `src/sandbox/index.ts` with:

- `SandboxCommandSchema` for structured commands: `kind`, `command`, `args`, optional `cwd`, `env`, `timeoutMs`, `metadata`.
- `PatchArtifactSchema` for proposed patches with file path, operation, unified diff, approval status, and metadata.
- `SandboxExecutionResultSchema` with status, exit code, stdout/stderr, duration, networkCalls fixed at `0`, artifacts, and approval gates.
- `SandboxAdapter` interface and provider metadata.
- `SafeLocalSandboxAdapter` implementation.
- `createE2BSandboxAdapterStub()` and `createDepotSandboxAdapterStub()` stubs.

Allowlisted local commands are deterministic only:

- `fake:echo` echoes args.
- `fake:test-pass` returns a successful fake test result.
- `local:propose-patch` returns a patch artifact and requires `metadata.approval.fileWriteApproved === true` before marking the proposal approved.

All denied commands return structured denial results; they do not throw for normal policy denial.

## Test Plan

Follow TDD:

1. Add failing tests in `tests/safeCodeExecution.test.ts` for denied arbitrary shell.
2. Add allowed fake command test.
3. Add file-write approval gate test.
4. Add patch artifact schema validation test.
5. Add E2B/Depot no-network stub tests using `globalThis.fetch` spy.
6. Run focused test, full `npm test`, and `npm run build`.

## Acceptance Criteria

- Arbitrary shell is denied by default.
- Only documented fake/local commands can succeed.
- File-write proposals surface explicit approval gate metadata when not approved.
- Patch artifacts are schema-validated and do not apply to disk.
- E2B/Depot stubs perform zero network calls.
- Public exports make sandbox contracts available to later chunks.
