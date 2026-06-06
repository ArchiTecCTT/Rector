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

import { resolveWithinWorkspace, WorkspaceSandboxAdapter, type CommandRunner } from "../src/sandbox";
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
