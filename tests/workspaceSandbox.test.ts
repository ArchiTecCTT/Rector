/**
 * Workspace sandbox property tests (ORN-37).
 *
 * Property 2: No path escapes the workspace root.
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7
 *
 * The containment gate `resolveWithinWorkspace` is the single choke point every
 * file/patch operation passes through before any I/O. This property asserts the
 * design invariant directly:
 *
 *   ∀ workspaceRoot w, ∀ candidate path c (arbitrary relative, absolute,
 *   ".."-laden, or symlink target):
 *     resolveWithinWorkspace(w, c).ok = true
 *       ⟹ result.absolutePath = w ∨ result.absolutePath.startsWith(w + SEP)
 *     ∧ no read/list/write ever touched a path outside w.
 *
 * For every adversarial category the resolver must deny the path with the exact
 * `denialReason` defined by the fixed check order (empty → absolute → `..` →
 * symlink), withhold the resolved absolute path on denial, and never perform
 * out-of-root I/O. The workspace filesystem is injected via the in-memory
 * `WorkspaceFs` double, so no real disk, API key, or network is used.
 */
import nodePath from "node:path";
import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  MAX_CAPTURED_STREAM_BYTES,
  WORKSPACE_COMMAND_TIMEOUT_MS,
  resolveWithinWorkspace,
  WorkspaceSandboxAdapter,
  type CommandRunner,
  type CommandRunResult,
  type SandboxApproval,
} from "../src/sandbox";
import {
  ALLOWLISTED_COMMANDS,
  arbAdversarialPathCase,
  arbAllowlistedCommand,
  arbDestructiveCommand,
  arbSafeRelativePathCase,
  arbShellMetacharacterCommand,
  arbSymlinkEscapeCase,
  arbWorkspacePathCase,
  createWorkspaceFs,
  isWithinRoot,
  type CandidatePathCase,
} from "./support/byokArbitraries";

// A genuine absolute path on the host platform (POSIX or Windows). Using
// `path.resolve` keeps the fixture cross-platform: the injected `WorkspaceFs`
// normalizes to POSIX internally, while `resolveWithinWorkspace` uses the
// platform `node:path` for resolution.
const WORKSPACE_ROOT = nodePath.resolve("workspace-sandbox-fixture-root");

/**
 * Builds an injected in-memory workspace filesystem for a candidate case,
 * registering the symlink entry (pointing outside the root) when the case is a
 * symlink-escape so the realpath check can detect the escape.
 *
 * `resolveWithinWorkspace` extracts `fsImpl.realpathSync` as a standalone
 * reference (the production default is `node:fs.realpathSync`, a free function),
 * so the in-memory double's bound method is supplied explicitly to preserve
 * `this`. The same `fs` instance is returned for access-tracking assertions.
 */
function buildWorkspaceFs(testCase: CandidatePathCase) {
  const fs = createWorkspaceFs({ root: WORKSPACE_ROOT });
  if (testCase.symlink) {
    fs.addSymlink(testCase.symlink.linkRelativePath, testCase.symlink.targetAbsolutePath);
  }
  const fsImpl = { realpathSync: (path: string) => fs.realpathSync(path) };
  return { fs, fsImpl };
}

describe("Property 2: no path escapes the workspace root", () => {
  // Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7
  it("resolves contained paths and denies every escape with the correct reason, never touching out-of-root paths", () => {
    fc.assert(
      fc.property(arbWorkspacePathCase(), (testCase) => {
        const { fs, fsImpl } = buildWorkspaceFs(testCase);

        const result = resolveWithinWorkspace(WORKSPACE_ROOT, testCase.path, fsImpl);

        if (testCase.expectedDenial === null) {
          // Req 3.6: a successful resolution returns an absolute path equal to,
          // or a descendant of, the workspace root.
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(isWithinRoot(WORKSPACE_ROOT, result.absolutePath)).toBe(true);
          }
        } else {
          // Reqs 3.2/3.3/3.4/3.5: denial carries the reason for the FIRST failed
          // check in the fixed order (empty → absolute → `..` → symlink).
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.reason).toBe(testCase.expectedDenial);
          }
          // Req 3.7: the resolved absolute path is withheld on denial.
          expect("absolutePath" in result).toBe(false);
        }

        // Reqs 3.1/3.5: containment is decided before any I/O, and resolution
        // never reads, lists, or writes a path outside the workspace root.
        expect(fs.accessedOutsideRoot()).toEqual([]);
        // The gate is side-effect-free with respect to the workspace contents.
        expect(fs.writes).toEqual([]);
        expect(fs.reads).toEqual([]);
        expect(fs.lists).toEqual([]);
      }),
      { numRuns: 500 }
    );
  });

  // Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.7
  it("denies every adversarial path (empty, absolute, `..`, symlink-escape) with no out-of-root access", () => {
    fc.assert(
      fc.property(arbAdversarialPathCase(), (testCase) => {
        const { fs, fsImpl } = buildWorkspaceFs(testCase);

        const result = resolveWithinWorkspace(WORKSPACE_ROOT, testCase.path, fsImpl);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe(testCase.expectedDenial);
        }
        // No resolved path is leaked for a denied operation.
        expect("absolutePath" in result).toBe(false);
        expect(fs.accessedOutsideRoot()).toEqual([]);
      }),
      { numRuns: 500 }
    );
  });

  // Validates: Requirement 3.5 — symlink realpath escape is denied even though
  // the candidate is a syntactically safe relative path.
  it("denies a safe-looking relative path whose realpath resolves outside the root via a symlink", () => {
    fc.assert(
      fc.property(arbSymlinkEscapeCase(), (testCase) => {
        const { fs, fsImpl } = buildWorkspaceFs(testCase);

        const result = resolveWithinWorkspace(WORKSPACE_ROOT, testCase.path, fsImpl);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe("SYMLINK_ESCAPE");
        }
        expect("absolutePath" in result).toBe(false);
        // The escaping realpath was resolved but never read/listed/written.
        expect(fs.accessedOutsideRoot()).toEqual([]);
      }),
      { numRuns: 500 }
    );
  });

  // Validates: Requirement 3.6 — a contained relative path resolves to a
  // workspace-rooted absolute path.
  it("resolves safe relative paths to a contained absolute path", () => {
    fc.assert(
      fc.property(arbSafeRelativePathCase(), (testCase) => {
        const { fs, fsImpl } = buildWorkspaceFs(testCase);

        const result = resolveWithinWorkspace(WORKSPACE_ROOT, testCase.path, fsImpl);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(isWithinRoot(WORKSPACE_ROOT, result.absolutePath)).toBe(true);
        }
        expect(fs.accessedOutsideRoot()).toEqual([]);
      }),
      { numRuns: 300 }
    );
  });
});

/**
 * Property 3: Destructive commands are always blocked.
 *
 * Validates: Requirements 4.3
 *
 * The destructive denylist is the highest-precedence gate in
 * `WorkspaceSandboxAdapter.operate`: a known-destructive command/arg signature
 * (rm -rf, del /f, format, mkfs, dd, git clean -fdx, a fork bomb, ...) is denied
 * before the allowlist, the arbitrary-shell gate, and the approval gate are even
 * consulted. The design invariant asserted here is:
 *
 *   ∀ destructive command/arg signature d (including one whose program token is
 *   also on the allowlist):
 *     operate({ kind: "RUN_COMMAND", command: d.command, args: d.args })
 *       ⟹ status = "DENIED"
 *        ∧ denialReason = "DESTRUCTIVE_COMMAND_BLOCKED"
 *        ∧ the injected command runner ran 0 times (no process is spawned).
 *
 * A counting `CommandRunner` double is injected so the "spawn no process"
 * guarantee (Req 4.3) is directly observable; the adapter is configured with the
 * full allowlist so the denylist's precedence over the allowlist is exercised.
 */

/** A `CommandRunner` double that records how many times it was invoked. */
function createCountingCommandRunner(): { runner: CommandRunner; readonly calls: number } {
  let calls = 0;
  const handle = {
    runner: (async ({ command, args }) => {
      calls += 1;
      return { exitCode: 0, stdout: [command, ...args].join(" "), stderr: "" };
    }) as CommandRunner,
    get calls() {
      return calls;
    },
  };
  return handle;
}

describe("Property 3: destructive commands are always blocked", () => {
  // Validates: Requirement 4.3
  it("denies every destructive command with DESTRUCTIVE_COMMAND_BLOCKED and never spawns a process, even on the allowlist", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Mix plain destructive signatures with ones whose program token is also
        // allowlisted, so the denylist's precedence over the allowlist is proven.
        fc.oneof(arbDestructiveCommand(), arbDestructiveCommand({ alsoAllowlisted: true })),
        async (commandCase) => {
          const counting = createCountingCommandRunner();
          const adapter = new WorkspaceSandboxAdapter({
            workspaceRoot: WORKSPACE_ROOT,
            // Full allowlist + every destructive program token allowlisted: the
            // destructive gate must still win.
            allowlistedCommands: [...ALLOWLISTED_COMMANDS, commandCase.command],
            commandRunner: counting.runner,
            now: () => "2026-01-01T00:00:00.000Z",
          });

          const result = await adapter.operate({
            kind: "RUN_COMMAND",
            command: commandCase.command,
            args: commandCase.args,
          });

          // Req 4.3: the destructive denylist denies the operation outright.
          expect(result.status).toBe("DENIED");
          expect(result.denialReason).toBe("DESTRUCTIVE_COMMAND_BLOCKED");
          // Req 4.3: no process is spawned — the injected runner ran 0 times.
          expect(counting.calls).toBe(0);
          // The denied result is contained and network-free; no resolved path leaks.
          expect(result.networkCalls).toBe(0);
          expect(result.resolvedPath).toBeUndefined();
        },
      ),
      { numRuns: 500 },
    );
  });
});

/**
 * Property 4: Arbitrary shell is denied by default.
 *
 * Validates: Requirements 4.1
 *
 * Arbitrary shell execution is refused by `WorkspaceSandboxAdapter.operate`
 * before any process is spawned. A `RUN_COMMAND` is treated as an arbitrary
 * shell request in two ways: an explicit shell kind carried on the operation
 * metadata (`metadata.kind === "shell"` or `metadata.shell === true`), or a
 * command string containing shell metacharacters (`;`, `|`, `&`, `$(...)`,
 * backticks, redirects, globs, ...). The design invariant asserted here is:
 *
 *   ∀ RUN_COMMAND operation o that requests shell interpretation
 *   (explicit shell kind ∨ shell metacharacters in the command string):
 *     operate(o) ⟹ status = "DENIED"
 *                ∧ denialReason = "ARBITRARY_SHELL_DISABLED"
 *                ∧ the injected command runner ran 0 times (no process spawned)
 *                ∧ no resolved path is leaked
 *                ∧ networkCalls = 0.
 *
 * The explicit-shell channel uses commands whose program token is on the
 * allowlist, so denial is driven solely by the shell request ("denied by
 * default") and not by allowlist membership. A counting `CommandRunner` double
 * is injected so the "spawn no process" guarantee (Req 4.1) is directly
 * observable.
 */
describe("Property 4: arbitrary shell is denied by default", () => {
  // Validates: Requirement 4.1 — an explicit shell-kind request is denied even
  // when the underlying program is otherwise allowlisted.
  it("denies any explicit shell-kind operation with ARBITRARY_SHELL_DISABLED and never spawns a process", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbAllowlistedCommand(),
        // Both ways the design signals an explicit shell invocation.
        fc.constantFrom<Record<string, unknown>>({ kind: "shell" }, { shell: true }),
        async (commandCase, shellMetadata) => {
          const counting = createCountingCommandRunner();
          const adapter = new WorkspaceSandboxAdapter({
            workspaceRoot: WORKSPACE_ROOT,
            // Fully allowlisted: only the shell request can cause the denial.
            allowlistedCommands: [...ALLOWLISTED_COMMANDS],
            commandRunner: counting.runner,
            now: () => "2026-01-01T00:00:00.000Z",
          });

          const result = await adapter.operate({
            kind: "RUN_COMMAND",
            command: commandCase.command,
            args: commandCase.args,
            metadata: shellMetadata,
          });

          // Req 4.1: arbitrary shell is denied by default.
          expect(result.status).toBe("DENIED");
          expect(result.denialReason).toBe("ARBITRARY_SHELL_DISABLED");
          // Req 4.1: no process is spawned — the injected runner ran 0 times.
          expect(counting.calls).toBe(0);
          // The denied result is contained and network-free; no resolved path leaks.
          expect(result.networkCalls).toBe(0);
          expect(result.resolvedPath).toBeUndefined();
        },
      ),
      { numRuns: 500 },
    );
  });

  // Validates: Requirement 4.1 — a command string carrying shell metacharacters
  // is treated as an arbitrary shell request and denied.
  it("denies any command string carrying shell metacharacters with ARBITRARY_SHELL_DISABLED and never spawns a process", async () => {
    await fc.assert(
      fc.asyncProperty(arbShellMetacharacterCommand(), async (commandCase) => {
        const counting = createCountingCommandRunner();
        const adapter = new WorkspaceSandboxAdapter({
          workspaceRoot: WORKSPACE_ROOT,
          allowlistedCommands: [...ALLOWLISTED_COMMANDS],
          commandRunner: counting.runner,
          now: () => "2026-01-01T00:00:00.000Z",
        });

        const result = await adapter.operate({
          kind: "RUN_COMMAND",
          command: commandCase.command,
          args: commandCase.args,
        });

        // Req 4.1: a metacharacter-laced command implies shell interpretation
        // and is denied.
        expect(result.status).toBe("DENIED");
        expect(result.denialReason).toBe("ARBITRARY_SHELL_DISABLED");
        // Req 4.1: no process is spawned — the injected runner ran 0 times.
        expect(counting.calls).toBe(0);
        expect(result.networkCalls).toBe(0);
        expect(result.resolvedPath).toBeUndefined();
      }),
      { numRuns: 500 },
    );
  });
});

/**
 * Unit tests for the WorkspaceSandboxAdapter policy gates (ORN-37, task 2.6).
 *
 * Validates: Requirements 4.2, 4.4, 4.5, 4.6, 4.7, 4.8
 *
 * These example-based tests complement the Property 2/3/4 tests above by
 * pinning down the remaining `operate()` outcomes that the properties do not
 * exhaustively cover:
 *   - off-allowlist denial (Req 4.2) with no process spawned,
 *   - `NEEDS_APPROVAL` for an unapproved write and an unapproved risky command,
 *     plus the unapproved `PatchArtifact` shape (Reqs 4.4, 4.5),
 *   - the 60s command timeout with partial-output capture (Req 4.6),
 *   - stdout/stderr truncation at 262144 bytes (Req 4.7),
 *   - `networkCalls: 0` on every command result (Req 4.8),
 *   - the `READ_FILE` / `LIST_DIR` success paths.
 *
 * Everything is mock-only: the workspace filesystem is injected via the
 * in-memory `WorkspaceFs` double and the command runner is a deterministic
 * double, so no real disk, process, API key, or network is used.
 */
const FIXED_NOW = () => "2026-01-01T00:00:00.000Z";

/**
 * A configurable `CommandRunner` double that records its call count and the
 * arguments of the most recent invocation, and returns a scripted result.
 */
function createScriptedCommandRunner(result: CommandRunResult): {
  runner: CommandRunner;
  readonly calls: number;
  readonly lastInput: { command: string; args: string[]; cwd: string; timeoutMs: number } | undefined;
} {
  let calls = 0;
  let lastInput: { command: string; args: string[]; cwd: string; timeoutMs: number } | undefined;
  return {
    runner: (async (input) => {
      calls += 1;
      lastInput = input;
      return result;
    }) as CommandRunner,
    get calls() {
      return calls;
    },
    get lastInput() {
      return lastInput;
    },
  };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

describe("WorkspaceSandboxAdapter: allowlist enforcement (Req 4.2)", () => {
  it("denies a command that is not on the allowlist with COMMAND_NOT_ALLOWLISTED and spawns no process", async () => {
    const counting = createScriptedCommandRunner({ exitCode: 0, stdout: "", stderr: "" });
    const adapter = new WorkspaceSandboxAdapter({
      workspaceRoot: WORKSPACE_ROOT,
      allowlistedCommands: ["npm:test"],
      commandRunner: counting.runner,
      now: FIXED_NOW,
    });

    const result = await adapter.operate({ kind: "RUN_COMMAND", command: "python", args: ["script.py"] });

    expect(result.status).toBe("DENIED");
    expect(result.denialReason).toBe("COMMAND_NOT_ALLOWLISTED");
    // No process is spawned for an off-allowlist command.
    expect(counting.calls).toBe(0);
    // Denied results are contained and network-free; no resolved path leaks.
    expect(result.networkCalls).toBe(0);
    expect(result.resolvedPath).toBeUndefined();
  });

  it("runs an allowlisted, non-risky command and captures its streams", async () => {
    const counting = createScriptedCommandRunner({ exitCode: 0, stdout: "build ok", stderr: "" });
    const adapter = new WorkspaceSandboxAdapter({
      workspaceRoot: WORKSPACE_ROOT,
      allowlistedCommands: [...ALLOWLISTED_COMMANDS],
      commandRunner: counting.runner,
      now: FIXED_NOW,
    });

    const result = await adapter.operate({ kind: "RUN_COMMAND", command: "npm:build", args: ["--ci"] });

    expect(result.status).toBe("SUCCEEDED");
    expect(result.denialReason).toBeUndefined();
    expect(result.stdout).toBe("build ok");
    expect(counting.calls).toBe(1);
    // Req 4.8: every command result reports zero network calls.
    expect(result.networkCalls).toBe(0);
  });
});

describe("WorkspaceSandboxAdapter: approval gating (Reqs 4.4, 4.5)", () => {
  it("returns NEEDS_APPROVAL and an unapproved PatchArtifact for an unapproved write, performing no write", async () => {
    const fs = createWorkspaceFs({ root: WORKSPACE_ROOT });
    const adapter = new WorkspaceSandboxAdapter({
      workspaceRoot: WORKSPACE_ROOT,
      fsImpl: fs,
      now: FIXED_NOW,
    });

    const result = await adapter.operate({
      kind: "PROPOSE_PATCH",
      path: "src/new-file.ts",
      operation: "add",
      content: "export const added = true;\n",
    });

    // Req 4.4: a mutating write without a matching approval is not performed.
    expect(result.status).toBe("NEEDS_APPROVAL");
    expect(result.denialReason).toBe("NEEDS_APPROVAL");
    // Req 4.5: an unapproved PatchArtifact is emitted (no write).
    expect(result.artifacts).toHaveLength(1);
    const artifact = result.artifacts[0];
    expect(artifact.kind).toBe("PATCH");
    expect(artifact.approval.approved).toBe(false);
    expect(artifact.path).toBe("src/new-file.ts");
    // The unapproved gate is surfaced and no file was written.
    expect(result.approvalGates).toHaveLength(1);
    expect(result.approvalGates[0]?.approved).toBe(false);
    expect(fs.writes).toEqual([]);
  });

  it("applies the write when a matching FILE_WRITE approval is present", async () => {
    const fs = createWorkspaceFs({ root: WORKSPACE_ROOT });
    const approvals: SandboxApproval[] = [
      { id: "approval-write-1", scope: "FILE_WRITE", target: "src/new-file.ts", approvedBy: "tester" },
    ];
    const adapter = new WorkspaceSandboxAdapter({
      workspaceRoot: WORKSPACE_ROOT,
      fsImpl: fs,
      approvals,
      now: FIXED_NOW,
    });

    const result = await adapter.operate({
      kind: "PROPOSE_PATCH",
      path: "src/new-file.ts",
      operation: "add",
      content: "export const added = true;\n",
    });

    expect(result.status).toBe("SUCCEEDED");
    expect(result.artifacts[0]?.approval.approved).toBe(true);
    // The contained write was performed exactly once.
    expect(fs.writes).toHaveLength(1);
    expect(isWithinRoot(WORKSPACE_ROOT, fs.writes[0]!.path)).toBe(true);
    expect(fs.writes[0]!.data).toBe("export const added = true;\n");
  });

  it("returns NEEDS_APPROVAL for an unapproved risky command and spawns no process", async () => {
    const counting = createScriptedCommandRunner({ exitCode: 0, stdout: "", stderr: "" });
    const adapter = new WorkspaceSandboxAdapter({
      workspaceRoot: WORKSPACE_ROOT,
      allowlistedCommands: [...ALLOWLISTED_COMMANDS],
      riskyCommands: ["npm:test"],
      commandRunner: counting.runner,
      now: FIXED_NOW,
    });

    const result = await adapter.operate({ kind: "RUN_COMMAND", command: "npm:test", args: [] });

    // Req 4.4: a risky command lacking a matching COMMAND approval is gated.
    expect(result.status).toBe("NEEDS_APPROVAL");
    expect(result.denialReason).toBe("NEEDS_APPROVAL");
    expect(counting.calls).toBe(0);
    expect(result.networkCalls).toBe(0);
  });

  it("runs a risky command when a matching COMMAND approval is present", async () => {
    const counting = createScriptedCommandRunner({ exitCode: 0, stdout: "tests passed", stderr: "" });
    const approvals: SandboxApproval[] = [
      { id: "approval-cmd-1", scope: "COMMAND", target: "npm:test", approvedBy: "tester" },
    ];
    const adapter = new WorkspaceSandboxAdapter({
      workspaceRoot: WORKSPACE_ROOT,
      allowlistedCommands: [...ALLOWLISTED_COMMANDS],
      riskyCommands: ["npm:test"],
      approvals,
      commandRunner: counting.runner,
      now: FIXED_NOW,
    });

    const result = await adapter.operate({ kind: "RUN_COMMAND", command: "npm:test", args: [] });

    expect(result.status).toBe("SUCCEEDED");
    expect(result.stdout).toBe("tests passed");
    expect(counting.calls).toBe(1);
  });
});

describe("WorkspaceSandboxAdapter: command timeout and capture (Reqs 4.6, 4.7, 4.8)", () => {
  it("denies a timed-out command with COMMAND_TIMEOUT and captures the partial output", async () => {
    const counting = createScriptedCommandRunner({
      exitCode: 124,
      stdout: "partial stdout before termination",
      stderr: "partial stderr before termination",
      timedOut: true,
    });
    const adapter = new WorkspaceSandboxAdapter({
      workspaceRoot: WORKSPACE_ROOT,
      allowlistedCommands: [...ALLOWLISTED_COMMANDS],
      commandRunner: counting.runner,
      now: FIXED_NOW,
    });

    const result = await adapter.operate({ kind: "RUN_COMMAND", command: "npm:test", args: [] });

    // Req 4.6: a timeout terminates the process and denies the operation.
    expect(result.status).toBe("DENIED");
    expect(result.denialReason).toBe("COMMAND_TIMEOUT");
    // Req 4.6: the partial output produced before termination is preserved.
    expect(result.stdout).toBe("partial stdout before termination");
    expect(result.stderr).toBe("partial stderr before termination");
    expect(result.networkCalls).toBe(0);
  });

  it("defaults to the 60s timeout when the operation omits timeoutMs", async () => {
    const counting = createScriptedCommandRunner({ exitCode: 0, stdout: "", stderr: "" });
    const adapter = new WorkspaceSandboxAdapter({
      workspaceRoot: WORKSPACE_ROOT,
      allowlistedCommands: [...ALLOWLISTED_COMMANDS],
      commandRunner: counting.runner,
      now: FIXED_NOW,
    });

    await adapter.operate({ kind: "RUN_COMMAND", command: "npm:build", args: [] });

    expect(counting.lastInput?.timeoutMs).toBe(WORKSPACE_COMMAND_TIMEOUT_MS);
    expect(WORKSPACE_COMMAND_TIMEOUT_MS).toBe(60_000);
  });

  it("truncates captured stdout and stderr to 262144 bytes (Req 4.7)", async () => {
    const oversized = "a".repeat(MAX_CAPTURED_STREAM_BYTES + 50_000);
    const counting = createScriptedCommandRunner({ exitCode: 0, stdout: oversized, stderr: oversized });
    const adapter = new WorkspaceSandboxAdapter({
      workspaceRoot: WORKSPACE_ROOT,
      allowlistedCommands: [...ALLOWLISTED_COMMANDS],
      commandRunner: counting.runner,
      now: FIXED_NOW,
    });

    const result = await adapter.operate({ kind: "RUN_COMMAND", command: "npm:build", args: [] });

    expect(result.status).toBe("SUCCEEDED");
    // Each captured stream is bounded to the hard 256 KiB cap.
    expect(byteLength(result.stdout)).toBeLessThanOrEqual(MAX_CAPTURED_STREAM_BYTES);
    expect(byteLength(result.stderr)).toBeLessThanOrEqual(MAX_CAPTURED_STREAM_BYTES);
    // The excess was actually truncated, not passed through.
    expect(result.stdout.length).toBeLessThan(oversized.length);
    expect(result.networkCalls).toBe(0);
  });
});

describe("WorkspaceSandboxAdapter: read and list success paths", () => {
  it("reads a contained file and returns its (redacted) content with a contained resolvedPath", async () => {
    const fs = createWorkspaceFs({
      root: WORKSPACE_ROOT,
      files: { "src/index.ts": "export const value = 42;\n" },
    });
    const adapter = new WorkspaceSandboxAdapter({
      workspaceRoot: WORKSPACE_ROOT,
      fsImpl: fs,
      now: FIXED_NOW,
    });

    const result = await adapter.operate({ kind: "READ_FILE", path: "src/index.ts" });

    expect(result.status).toBe("SUCCEEDED");
    expect(result.fileContent).toBe("export const value = 42;\n");
    expect(result.resolvedPath).toBeDefined();
    expect(isWithinRoot(WORKSPACE_ROOT, result.resolvedPath!)).toBe(true);
    expect(result.networkCalls).toBe(0);
  });

  it("lists a contained directory and returns its entries", async () => {
    const fs = createWorkspaceFs({
      root: WORKSPACE_ROOT,
      dirs: { src: ["index.ts", "util.ts", "types.ts"] },
    });
    const adapter = new WorkspaceSandboxAdapter({
      workspaceRoot: WORKSPACE_ROOT,
      fsImpl: fs,
      now: FIXED_NOW,
    });

    const result = await adapter.operate({ kind: "LIST_DIR", path: "src" });

    expect(result.status).toBe("SUCCEEDED");
    expect(result.entries).toEqual(["index.ts", "util.ts", "types.ts"]);
    expect(result.resolvedPath).toBeDefined();
    expect(isWithinRoot(WORKSPACE_ROOT, result.resolvedPath!)).toBe(true);
    expect(result.networkCalls).toBe(0);
  });
});
