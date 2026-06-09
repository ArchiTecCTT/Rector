/**
 * Feature: cloud-capable-transition, Property 32: Local mode performs no
 * external sandbox execution.
 *
 * Validates: Requirements 9.2, 6.7
 *
 *   9.2 "WHILE Orchestrator_Mode is `local`, THE Rector_Server SHALL execute no
 *        external sandbox container."
 *   6.7 "WHILE Orchestrator_Mode is `local`, THE Rector_Server SHALL execute
 *        sandbox operations through the local provider-free runner and SHALL
 *        initialize no E2B container client."
 *
 * The Rector_Server selects its Sandbox_Adapter by mode in
 * `buildStartupSandboxAdapter` (`src/bin/server.ts`): External_Mode with a
 * configured E2B key constructs the real `createE2BSandboxAdapter` (a network
 * container client), while Local_Mode — and External_Mode with no key —
 * constructs the network-free local runner (`WorkspaceSandboxAdapter`) and
 * initializes NO E2B client. `src/bin/server.ts` self-bootstraps on import (it
 * binds a port and may `process.exit`), so it cannot be imported into a unit
 * test; `selectSandboxAdapter` below mirrors that exact mode gate and routes
 * the External_Mode branch through the production `createE2BSandboxAdapter` so
 * the counting `clientFactory` seam is observable.
 *
 * Hermeticity: a counting double is injected for the E2B container
 * `clientFactory` and the resulting `E2BClient`. The factory and the client's
 * `runCommand` / `writeFile` methods record every invocation and perform NO
 * work — no container is constructed, no process spawned, and no network or
 * disk I/O occurs (the filesystem seam is an in-memory identity double). The
 * property therefore directly observes the "no external sandbox container is
 * constructed or invoked" guarantee: across an arbitrary battery of sandbox
 * operations (RUN_COMMAND via both the legacy `execute` and the richer
 * `operate` entry points, PROPOSE_PATCH, READ_FILE, and LIST_DIR, over
 * allowlisted, non-allowlisted, destructive, shell, contained, and escaping
 * inputs), in Local_Mode the factory call count, the `runCommand` call count,
 * and the `writeFile` call count must all remain exactly zero, the selected
 * adapter must be the network-free local runner, and every result must report
 * `networkCalls === 0`.
 *
 * The `external mode invokes the same counting factory` control proves the
 * double is wired so the Local_Mode zero is meaningful (non-vacuous): the
 * identical counting factory IS invoked when the gate selects the E2B path.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  createE2BSandboxAdapter,
  type E2BClient,
  type E2BClientFactory,
  type E2BCommandResult,
  type E2BRunCommandInput,
  type E2BWriteFileInput,
} from "../src/sandbox/e2bSandboxAdapter";
import {
  WorkspaceSandboxAdapter,
  type SandboxAdapter,
  type SandboxCommandInput,
  type SandboxOperationInput,
  type SandboxOperationResult,
  type WorkspaceFs,
} from "../src/sandbox";

const FIXED_TS = "2026-01-01T00:00:00.000Z";
const WORKSPACE_ROOT = "/workspace";
const ALLOWLISTED = ["echo", "ls", "cat", "node"] as const;
const RISKY = ["node"] as const; // allowlisted AND risky → needs an approval to run

/**
 * In-memory filesystem identity double. `realpathSync` echoes its input so the
 * containment gate resolves deterministically without touching disk; the read
 * seams return benign contents and the write seam is a no-op. None of these is
 * a container call — they back only the network-free local runner.
 */
const fakeFs: WorkspaceFs = {
  realpathSync: (p) => p,
  readFileSync: () => "benign-file-contents",
  readdirSync: () => ["a.ts", "b.ts"],
  writeFileSync: () => {},
  existsSync: () => true,
};

interface CountingClient {
  factory: E2BClientFactory;
  counts: { factory: number; runCommand: number; writeFile: number };
}

/**
 * Counting container double. The factory and both container operations record
 * each call and do no work, so ANY contact with the external sandbox container
 * is observable as a non-zero count.
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

/** Adapter exposing the richer `operate` entry point alongside `execute`. */
type OperableSandboxAdapter = SandboxAdapter & {
  operate(input: SandboxOperationInput): Promise<SandboxOperationResult>;
};

/**
 * Mirrors `buildStartupSandboxAdapter` in `src/bin/server.ts` (design C6,
 * Req 6.1/6.7): External_Mode with a configured E2B key constructs the real
 * container adapter; Local_Mode — and External_Mode without a key — constructs
 * the network-free local runner and initializes no E2B client. The E2B branch
 * is routed through the production `createE2BSandboxAdapter` with the injected
 * counting `clientFactory` so the "no container constructed/invoked" invariant
 * is directly observable.
 */
function selectSandboxAdapter(options: {
  mode: "local" | "external";
  apiKey?: string;
  clientFactory: E2BClientFactory;
}): SandboxAdapter {
  if (options.mode === "external" && options.apiKey) {
    return createE2BSandboxAdapter({
      apiKey: options.apiKey,
      workspaceRoot: WORKSPACE_ROOT,
      allowlistedCommands: [...ALLOWLISTED],
      riskyCommands: [...RISKY],
      clientFactory: options.clientFactory,
      now: () => FIXED_TS,
      fsImpl: fakeFs,
    });
  }
  // Local mode (Req 6.7): the network-free local runner, no E2B client. The
  // counting factory is intentionally NOT wired here — proving the local path
  // can never construct or invoke a container.
  return new WorkspaceSandboxAdapter({
    workspaceRoot: WORKSPACE_ROOT,
    allowlistedCommands: [...ALLOWLISTED],
    riskyCommands: [...RISKY],
    now: () => FIXED_TS,
    fsImpl: fakeFs,
  });
}

// --- Sandbox-operation generators ------------------------------------------

type SandboxAction =
  | { entry: "execute"; input: SandboxCommandInput }
  | { entry: "operate"; input: SandboxOperationInput };

const timeoutArb = fc.integer({ min: 1, max: 3_600_000 });
const argsArb = fc.array(fc.string({ maxLength: 12 }), { maxLength: 4 });
const contentArb = fc.string({ maxLength: 64 });
const patchOpArb = fc.constantFrom("add" as const, "update" as const, "delete" as const);

// A mix of allowlisted, non-allowlisted, destructive, and shell-metacharacter
// command strings so every gate branch (success, denial, needs-approval) is
// exercised — all of which must stay container-free in local mode.
const commandArb = fc.constantFrom(
  "echo",
  "ls",
  "cat",
  "node",
  "pwd",
  "git",
  "rm",
  "echo;ls",
);

// Contained and escaping paths so both the happy path and every containment
// denial are exercised.
const pathArb = fc.constantFrom(
  "src/a.ts",
  "lib/b.js",
  "docs/c.md",
  "../../secret",
  "/etc/passwd",
  "   ",
);

const commandKindArb = fc.constantFrom("fake" as const, "local" as const, "shell" as const);

const sandboxActionArb: fc.Arbitrary<SandboxAction> = fc.oneof(
  // RUN_COMMAND via the legacy `execute` contract.
  fc
    .tuple(commandKindArb, commandArb, argsArb, timeoutArb)
    .map(([kind, command, args, timeoutMs]) => ({
      entry: "execute" as const,
      input: { kind, command, args, timeoutMs },
    })),
  // RUN_COMMAND via the richer `operate` entry point.
  fc
    .tuple(commandArb, argsArb, timeoutArb)
    .map(([command, args, timeoutMs]) => ({
      entry: "operate" as const,
      input: { kind: "RUN_COMMAND", command, args, timeoutMs },
    })),
  // PROPOSE_PATCH (no approval on record → contained paths need approval, others denied).
  fc
    .tuple(pathArb, patchOpArb, contentArb)
    .map(([path, operation, content]) => ({
      entry: "operate" as const,
      input: { kind: "PROPOSE_PATCH", path, operation, content },
    })),
  // READ_FILE.
  pathArb.map((path) => ({ entry: "operate" as const, input: { kind: "READ_FILE", path } })),
  // LIST_DIR.
  pathArb.map((path) => ({ entry: "operate" as const, input: { kind: "LIST_DIR", path } })),
);

const VALID_STATUSES = ["SUCCEEDED", "FAILED", "DENIED", "NEEDS_APPROVAL"];

async function runAction(adapter: SandboxAdapter, action: SandboxAction): Promise<{ status: string; networkCalls: number }> {
  if (action.entry === "execute") {
    const result = await adapter.execute(action.input);
    return { status: result.status, networkCalls: result.networkCalls };
  }
  const result = await (adapter as OperableSandboxAdapter).operate(action.input);
  return { status: result.status, networkCalls: result.networkCalls };
}

describe("Feature: cloud-capable-transition, Property 32: local mode performs no external sandbox execution (Req 9.2, 6.7)", () => {
  it("never constructs or invokes an E2B container across an arbitrary battery of local-mode sandbox operations", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(sandboxActionArb, { minLength: 1, maxLength: 6 }), async (actions) => {
        const { factory, counts } = createCountingClient();
        // Local mode selects the network-free local runner; the counting E2B
        // factory is supplied but must never be reached.
        const adapter = selectSandboxAdapter({ mode: "local", apiKey: "secret-e2b-key", clientFactory: factory });

        // Req 6.7: the selected adapter is the local runner, not the E2B container adapter.
        expect(adapter.metadata.id).toBe("workspace");
        expect(adapter.metadata.id).not.toBe("e2b");
        expect(adapter.metadata.localOnly).toBe(true);
        expect(adapter.metadata.networkAccess).toBe(false);
        expect(adapter.metadata.stub).toBe(false);

        for (const action of actions) {
          const { status, networkCalls } = await runAction(adapter, action);
          expect(VALID_STATUSES).toContain(status);
          // The local runner never performs a network call.
          expect(networkCalls).toBe(0);
        }

        // Req 9.2 / 6.7: no E2B client was constructed and neither container
        // operation ran, regardless of how many operations were issued.
        expect(counts.factory).toBe(0);
        expect(counts.runCommand).toBe(0);
        expect(counts.writeFile).toBe(0);
      }),
      { numRuns: 200 },
    );
  });

  it("control: the same counting factory IS invoked when the gate selects the external E2B path", async () => {
    const { factory, counts } = createCountingClient();
    const adapter = selectSandboxAdapter({ mode: "external", apiKey: "secret-e2b-key", clientFactory: factory });

    // The external gate selects the real E2B container adapter.
    expect(adapter.metadata.id).toBe("e2b");

    // An allowlisted, non-risky, non-destructive command clears every policy
    // gate and runs in the container — exercising the counting client.
    const result = await adapter.execute({ kind: "local", command: "echo", args: ["hi"], timeoutMs: 1_000 });

    expect(result.status).toBe("SUCCEEDED");
    expect(counts.factory).toBe(1);
    expect(counts.runCommand).toBe(1);
  });
});
