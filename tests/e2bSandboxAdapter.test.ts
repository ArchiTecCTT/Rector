/**
 * E2B Sandbox_Adapter container happy-path and failure-mode unit tests
 * (cloud-capable-transition, task 9.5).
 *
 * Validates: Requirements 6.1, 6.2, 6.3, 6.9, 6.10
 *
 * `createE2BSandboxAdapter` runs every operation through the workspace policy
 * gates first, then contacts an injectable container client. These example
 * tests pin down the four behaviors task 9.5 calls out, using a deterministic
 * in-memory client double and an injected in-memory `WorkspaceFs`, so no
 * container is ever spawned, no API key is used, and no network call is made:
 *
 *   1. an approved `RUN_COMMAND` executes via the injected client and the
 *      captured exit code / stdout / stderr are surfaced (Req 6.2, 6.4-ish);
 *   2. an approved `PROPOSE_PATCH` applies via the injected client `writeFile`
 *      (Req 6.3);
 *   3. a client-init failure returns a redacted failure result and spawns no
 *      container process (Req 6.1, 6.9);
 *   4. a patch-apply failure returns a redacted failure result and leaves the
 *      target file unchanged (Req 6.10).
 */
import nodePath from "node:path";
import { describe, it, expect } from "vitest";

import {
  createE2BSandboxAdapter,
  type E2BClient,
  type E2BClientFactory,
  type E2BCommandResult,
  type E2BRunCommandInput,
  type E2BWriteFileInput,
} from "../src/sandbox/e2bSandboxAdapter";
import {
  type SandboxAdapter,
  type SandboxApproval,
  type SandboxOperationInput,
  type SandboxOperationResult,
  type WorkspaceFs,
} from "../src/sandbox";
import { ALLOWLISTED_COMMANDS, createWorkspaceFs } from "./support/byokArbitraries";

// An absolute, cross-platform workspace root used as the containment boundary.
const WORKSPACE_ROOT = nodePath.resolve("e2b-sandbox-adapter-fixture-root");
const FIXED_NOW = () => "2026-01-01T00:00:00.000Z";

// A key-like secret composed only of URL/JSON-safe characters so a leaked
// substring is reliably searchable and the redaction layer's inline-secret
// pattern (`token=<value>`) replaces it with the fixed placeholder.
const SECRET = "sk-TESTSECRET0123456789ABCDEF";

/**
 * The richer `operate` entry point is implemented by the adapter but is not
 * part of the public `SandboxAdapter` contract; this local type exposes it for
 * the tests.
 */
type OperableAdapter = SandboxAdapter & {
  operate(input: SandboxOperationInput): Promise<SandboxOperationResult>;
};

/**
 * Builds an injected in-memory `WorkspaceFs` with method wrappers (arrow
 * closures) so the resolver's extracted `realpathSync` reference keeps its
 * binding. No real disk is touched.
 */
function buildFsImpl(files: Record<string, string> = {}): WorkspaceFs {
  const store = createWorkspaceFs({ root: WORKSPACE_ROOT, files });
  return {
    realpathSync: (p) => store.realpathSync(p),
    readFileSync: (p) => store.readFileSync(p),
    readdirSync: (p) => store.readdirSync(p),
    writeFileSync: (p, d) => store.writeFileSync(p, d),
    existsSync: () => true,
  };
}

interface SpyClientOptions {
  commandResult?: E2BCommandResult;
  runCommandError?: Error;
  writeFileError?: Error;
  initialFiles?: Record<string, string>;
}

interface SpyClientHandle {
  client: E2BClient;
  runCommandCalls: number;
  writeFileCalls: number;
  lastCommand?: E2BRunCommandInput;
  lastWrite?: E2BWriteFileInput;
  files: Map<string, string>;
}

/**
 * A deterministic, in-memory `E2BClient` double. It records how many times each
 * surface was invoked and the most recent inputs, returns a scripted command
 * result, and tracks an in-memory file map so "the target file is unchanged"
 * can be asserted directly. It spawns no process and makes no network call.
 */
function createSpyClient(options: SpyClientOptions = {}): SpyClientHandle {
  const handle: SpyClientHandle = {
    client: {} as E2BClient,
    runCommandCalls: 0,
    writeFileCalls: 0,
    files: new Map(Object.entries(options.initialFiles ?? {})),
  };

  handle.client = {
    runCommand(input: E2BRunCommandInput): E2BCommandResult {
      handle.runCommandCalls += 1;
      handle.lastCommand = input;
      if (options.runCommandError) throw options.runCommandError;
      return options.commandResult ?? { exitCode: 0, stdout: "", stderr: "" };
    },
    writeFile(input: E2BWriteFileInput): void {
      handle.writeFileCalls += 1;
      handle.lastWrite = input;
      // Throw BEFORE mutating so a failed apply leaves the file map unchanged.
      if (options.writeFileError) throw options.writeFileError;
      handle.files.set(input.path, input.content);
    },
  };

  return handle;
}

describe("E2B Sandbox_Adapter: approved RUN_COMMAND (Reqs 6.2, 6.4)", () => {
  it("executes an approved, allowlisted command via the injected client and captures stdout/stderr", async () => {
    const spy = createSpyClient({
      commandResult: { exitCode: 0, stdout: "tests passed", stderr: "warning: none" },
    });
    const adapter = createE2BSandboxAdapter({
      apiKey: "e2b-test-key",
      workspaceRoot: WORKSPACE_ROOT,
      allowlistedCommands: [...ALLOWLISTED_COMMANDS],
      clientFactory: () => spy.client,
      now: FIXED_NOW,
      fsImpl: buildFsImpl(),
    }) as OperableAdapter;

    const result = await adapter.operate({ kind: "RUN_COMMAND", command: "npm:test", args: ["--run"] });

    // Req 6.2: the cleared command executed inside the (injected) container.
    expect(result.status).toBe("SUCCEEDED");
    expect(spy.runCommandCalls).toBe(1);
    expect(spy.lastCommand?.command).toBe("npm:test");
    expect(spy.lastCommand?.args).toEqual(["--run"]);
    expect(spy.lastCommand?.cwd).toBe(WORKSPACE_ROOT);
    // The captured streams are surfaced in the result.
    expect(result.stdout).toBe("tests passed");
    expect(result.stderr).toBe("warning: none");
    expect(result.networkCalls).toBe(0);
  });

  it("captures the container exit code on the execution result", async () => {
    const spy = createSpyClient({
      commandResult: { exitCode: 7, stdout: "out", stderr: "boom" },
    });
    const adapter = createE2BSandboxAdapter({
      apiKey: "e2b-test-key",
      workspaceRoot: WORKSPACE_ROOT,
      allowlistedCommands: [...ALLOWLISTED_COMMANDS],
      clientFactory: () => spy.client,
      now: FIXED_NOW,
      fsImpl: buildFsImpl(),
    });

    const result = await adapter.execute({ kind: "local", command: "npm:test", args: [], timeoutMs: 1_000 });

    // Req 6.4: the command exit code, stdout, and stderr are captured.
    expect(spy.runCommandCalls).toBe(1);
    expect(result.exitCode).toBe(7);
    expect(result.status).toBe("FAILED");
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("boom");
    expect(result.networkCalls).toBe(0);
  });
});

describe("E2B Sandbox_Adapter: approved PROPOSE_PATCH (Req 6.3)", () => {
  it("applies an approved patch via the injected client writeFile", async () => {
    const spy = createSpyClient();
    const approvals: SandboxApproval[] = [
      { id: "approval-write-1", scope: "FILE_WRITE", target: "src/app.ts", approvedBy: "tester" },
    ];
    const adapter = createE2BSandboxAdapter({
      apiKey: "e2b-test-key",
      workspaceRoot: WORKSPACE_ROOT,
      approvals,
      clientFactory: () => spy.client,
      now: FIXED_NOW,
      fsImpl: buildFsImpl(),
    }) as OperableAdapter;

    const result = await adapter.operate({
      kind: "PROPOSE_PATCH",
      path: "src/app.ts",
      operation: "update",
      content: "export const x = 1;\n",
    });

    // Req 6.3: the approved file change is applied inside the (injected) container.
    expect(result.status).toBe("SUCCEEDED");
    expect(spy.writeFileCalls).toBe(1);
    expect(spy.lastWrite?.content).toBe("export const x = 1;\n");
    // The write targets the contained, resolved path.
    expect(spy.lastWrite?.path).toBe(result.resolvedPath);
    expect(spy.files.get(spy.lastWrite!.path)).toBe("export const x = 1;\n");
    expect(result.networkCalls).toBe(0);
    // The command surface was never touched for a patch.
    expect(spy.runCommandCalls).toBe(0);
  });
});

describe("E2B Sandbox_Adapter: client-init failure (Reqs 6.1, 6.9)", () => {
  it("returns a redacted failure result and spawns no container process", async () => {
    // The factory throws with a message that embeds a secret in a redactable form.
    let factoryCalls = 0;
    const failingFactory: E2BClientFactory = () => {
      factoryCalls += 1;
      throw new Error(`E2B client init failed for token=${SECRET}`);
    };
    const adapter = createE2BSandboxAdapter({
      apiKey: "e2b-test-key",
      workspaceRoot: WORKSPACE_ROOT,
      allowlistedCommands: [...ALLOWLISTED_COMMANDS],
      clientFactory: failingFactory,
      now: FIXED_NOW,
      fsImpl: buildFsImpl(),
    }) as OperableAdapter;

    const result = await adapter.operate({ kind: "RUN_COMMAND", command: "npm:test", args: [] });

    // Req 6.9: client init failed — a failure result is returned.
    expect(result.status).toBe("FAILED");
    // Req 6.1/6.9: the client factory was consulted but produced no client, so
    // no container process was ever spawned.
    expect(factoryCalls).toBe(1);
    // The redacted error replaces the secret with the fixed placeholder.
    expect(result.stderr).toContain("[REDACTED]");
    expect(result.stderr).not.toContain(SECRET);
    expect(result.networkCalls).toBe(0);
  });
});

describe("E2B Sandbox_Adapter: patch-apply failure (Req 6.10)", () => {
  it("returns a redacted failure result and leaves the target file unchanged", async () => {
    // The client is constructed successfully but its writeFile rejects, with a
    // secret embedded in the (redactable) error message.
    const spy = createSpyClient({
      writeFileError: new Error(`disk write rejected for token=${SECRET}`),
      initialFiles: { [`${WORKSPACE_ROOT}/src/app.ts`]: "export const original = true;\n" },
    });
    const approvals: SandboxApproval[] = [
      { id: "approval-write-1", scope: "FILE_WRITE", target: "src/app.ts", approvedBy: "tester" },
    ];
    const adapter = createE2BSandboxAdapter({
      apiKey: "e2b-test-key",
      workspaceRoot: WORKSPACE_ROOT,
      approvals,
      clientFactory: () => spy.client,
      now: FIXED_NOW,
      fsImpl: buildFsImpl(),
    }) as OperableAdapter;

    const result = await adapter.operate({
      kind: "PROPOSE_PATCH",
      path: "src/app.ts",
      operation: "update",
      content: "export const original = false;\n",
    });

    // Req 6.10: the apply failed — a redacted failure result is returned.
    expect(result.status).toBe("FAILED");
    expect(result.stderr).toContain("[REDACTED]");
    expect(result.stderr).not.toContain(SECRET);
    // Req 6.10: the write was attempted but the target file is left unchanged.
    expect(spy.writeFileCalls).toBe(1);
    expect(spy.files.get(`${WORKSPACE_ROOT}/src/app.ts`)).toBe("export const original = true;\n");
    expect(result.networkCalls).toBe(0);
  });
});
