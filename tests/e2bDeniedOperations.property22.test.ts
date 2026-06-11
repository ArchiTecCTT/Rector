/**
 * Feature: cloud-capable-transition, Property 22: Denied operations never spawn
 * a container process.
 *
 * Validates: Requirements 6.6
 *
 *   "IF a Sandbox_Operation is denied by the command allowlist, the destructive
 *    denylist, or a missing approval, THEN THE E2B_Sandbox_Adapter SHALL return
 *    a `DENIED` or `NEEDS_APPROVAL` Sandbox_Execution_Result without spawning a
 *    container process."
 *
 * The E2B adapter runs the WorkspaceSandboxAdapter policy gates (path
 * containment, command allowlist, destructive denylist, arbitrary-shell gate,
 * and approval gates) BEFORE it ever contacts the container. This property
 * drives the real `createE2BSandboxAdapter` over a broad space of operations
 * that every gate must reject — non-allowlisted commands, destructive denylist
 * signatures, arbitrary-shell invocations, risky commands missing their
 * approval, and PROPOSE_PATCH operations that either escape the workspace or
 * lack a FILE_WRITE approval — through both the `operate` and legacy `execute`
 * entry points.
 *
 * Hermeticity: a counting double is injected for the container `clientFactory`
 * and the resulting `E2BClient`. The factory and the client's `runCommand` /
 * `writeFile` methods record every invocation and perform NO work — no
 * container is ever constructed, no process spawned, and no network or disk I/O
 * occurs (the filesystem seam is an in-memory identity double). The property
 * therefore directly observes the "no container process" guarantee: for every
 * denied operation the factory call count, the `runCommand` call count, and the
 * `writeFile` call count must all be exactly zero, and the result status must
 * be `DENIED` or `NEEDS_APPROVAL`.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  createE2BSandboxAdapter,
  type E2BClient,
  type E2BCommandResult,
  type E2BRunCommandInput,
  type E2BSandboxOptions,
  type E2BWriteFileInput,
} from "../src/sandbox/e2bSandboxAdapter";
import type {
  SandboxCommandInput,
  SandboxOperationInput,
  WorkspaceFs,
} from "../src/sandbox";

const FIXED_TS = "2026-01-01T00:00:00.000Z";
const WORKSPACE_ROOT = "/workspace";
const ALLOWLISTED = ["echo", "ls", "cat", "node"] as const;
const RISKY = ["node"] as const; // allowlisted AND risky → needs an approval to run

/**
 * In-memory filesystem identity double. `realpathSync` echoes its input so the
 * containment gate resolves deterministically without touching disk; the
 * read/write/list seams throw because a denied operation must never reach them.
 */
const fakeFs: WorkspaceFs = {
  realpathSync: (p) => p,
  readFileSync: () => {
    throw new Error("readFileSync must not be called for a denied operation");
  },
  readdirSync: () => {
    throw new Error("readdirSync must not be called for a denied operation");
  },
  writeFileSync: () => {
    throw new Error("writeFileSync must not be called for a denied operation");
  },
  existsSync: () => true,
};

interface CountingClient {
  factory: E2BSandboxOptions["clientFactory"];
  counts: { factory: number; runCommand: number; writeFile: number };
}

/**
 * Counting container double. The factory and both container operations record
 * each call and do no work, so any contact with the container is observable as
 * a non-zero count.
 */
function createCountingClient(): CountingClient {
  const counts = { factory: 0, runCommand: 0, writeFile: 0 };
  const client: E2BClient = {
    runCommand(_input: E2BRunCommandInput): E2BCommandResult {
      counts.runCommand += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    writeFile(_input: E2BWriteFileInput): void {
      counts.writeFile += 1;
    },
  };
  return {
    counts,
    factory: (_apiKey: string) => {
      counts.factory += 1;
      return client;
    },
  };
}

// --- Denied-operation generators -------------------------------------------

type DeniedCase =
  | { entry: "operate"; input: SandboxOperationInput }
  | { entry: "execute"; input: SandboxCommandInput };

const timeoutArb = fc.integer({ min: 1, max: 3_600_000 });
const argsArb = fc.array(fc.string({ maxLength: 12 }), { maxLength: 4 });

// Commands that are NOT in the allowlist, carry no shell metacharacters, and
// are not destructive — they must be rejected as COMMAND_NOT_ALLOWLISTED.
const nonAllowlistedArb = fc.constantFrom("pwd", "whoami", "date", "env", "git", "python", "make", "go");

// Destructive signatures the denylist must block even when the program is
// allowlisted (the denylist has the highest precedence).
const destructiveArb = fc.constantFrom<{ command: string; args: string[] }>(
  { command: "rm", args: ["-rf", "."] },
  { command: "rm", args: ["-fr", "build"] },
  { command: "dd", args: ["if=/dev/zero", "of=/dev/sda"] },
  { command: "mkfs.ext4", args: ["/dev/sda1"] },
  { command: "format", args: ["C:"] },
  { command: "shutdown", args: ["now"] },
  { command: ":(){", args: [":|:&"] }, // fork-bomb signature
  { command: "echo", args: ["&&", "rm", "-rf", "."] }, // destructive token among args
);

// Arbitrary-shell invocations (metacharacters in the program string).
const shellArb = fc.constantFrom("echo;ls", "ls|cat", "cat>out", "echo`whoami`", "ls&", "echo$(pwd)");

// Safe relative paths that pass containment but have no FILE_WRITE approval.
const safeRelPathArb = fc.constantFrom("src/a.ts", "lib/b.js", "docs/c.md", "pkg/mod/d.json");

// Paths that escape the workspace (absolute / parent-traversal / blank).
const escapePathArb = fc.constantFrom("/etc/passwd", "../../secret", "..\\win", "C:\\win\\system32", "   ");

const contentArb = fc.string({ maxLength: 64 });
const patchOpArb = fc.constantFrom("add" as const, "update" as const, "delete" as const);

const deniedCaseArb: fc.Arbitrary<DeniedCase> = fc.oneof(
  // RUN_COMMAND: not allowlisted (via operate and execute).
  fc.tuple(nonAllowlistedArb, argsArb, timeoutArb, fc.boolean()).map(([command, args, timeoutMs, viaExecute]) =>
    viaExecute
      ? { entry: "execute", input: { command, args, timeoutMs } }
      : { entry: "operate", input: { kind: "RUN_COMMAND", command, args, timeoutMs } },
  ),
  // RUN_COMMAND: destructive denylist (via operate and execute).
  fc.tuple(destructiveArb, timeoutArb, fc.boolean()).map(([{ command, args }, timeoutMs, viaExecute]) =>
    viaExecute
      ? { entry: "execute", input: { command, args, timeoutMs } }
      : { entry: "operate", input: { kind: "RUN_COMMAND", command, args, timeoutMs } },
  ),
  // RUN_COMMAND: arbitrary shell invocation.
  fc.tuple(shellArb, argsArb, timeoutArb, fc.boolean()).map(([command, args, timeoutMs, viaExecute]) =>
    viaExecute
      ? { entry: "execute", input: { command, args, timeoutMs } }
      : { entry: "operate", input: { kind: "RUN_COMMAND", command, args, timeoutMs } },
  ),
  // RUN_COMMAND: allowlisted-but-risky command with no recorded approval → NEEDS_APPROVAL.
  fc.tuple(argsArb, timeoutArb, fc.boolean()).map(([args, timeoutMs, viaExecute]) =>
    viaExecute
      ? { entry: "execute", input: { command: "node", args, timeoutMs } }
      : { entry: "operate", input: { kind: "RUN_COMMAND", command: "node", args, timeoutMs } },
  ),
  // PROPOSE_PATCH: workspace escape → DENIED.
  fc.tuple(escapePathArb, patchOpArb, contentArb).map(([path, operation, content]) => ({
    entry: "operate" as const,
    input: { kind: "PROPOSE_PATCH", path, operation, content },
  })),
  // PROPOSE_PATCH: contained path but missing FILE_WRITE approval → NEEDS_APPROVAL.
  fc.tuple(safeRelPathArb, patchOpArb, contentArb).map(([path, operation, content]) => ({
    entry: "operate" as const,
    input: { kind: "PROPOSE_PATCH", path, operation, content },
  })),
);

describe("E2B_Sandbox_Adapter — Property 22: denied operations never spawn a container process (Req 6.6)", () => {
  it("returns DENIED/NEEDS_APPROVAL with zero container construction or invocation", async () => {
    await fc.assert(
      fc.asyncProperty(deniedCaseArb, async (testCase) => {
        const { factory, counts } = createCountingClient();
        const adapter = createE2BSandboxAdapter({
          apiKey: "secret-api-key",
          workspaceRoot: WORKSPACE_ROOT,
          allowlistedCommands: [...ALLOWLISTED],
          riskyCommands: [...RISKY],
          approvals: [], // no approvals on record
          clientFactory: factory,
          now: () => FIXED_TS,
          fsImpl: fakeFs,
        });

        const status =
          testCase.entry === "execute"
            ? (await adapter.execute(testCase.input)).status
            : (await (adapter as { operate(input: SandboxOperationInput): Promise<{ status: string }> }).operate(
                testCase.input,
              )).status;

        // The operation must be rejected, never executed.
        expect(["DENIED", "NEEDS_APPROVAL"]).toContain(status);

        // No container client was constructed and neither container operation ran.
        expect(counts.factory).toBe(0);
        expect(counts.runCommand).toBe(0);
        expect(counts.writeFile).toBe(0);
      }),
      { numRuns: 200 },
    );
  });
});
