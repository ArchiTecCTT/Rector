import nodePath from "node:path";
import { describe, expect, it } from "vitest";

import {
  MAX_CAPTURED_STREAM_BYTES,
  WorkspaceSandboxAdapter,
  createSandboxPolicy,
  type CommandRunner,
} from "../src/sandbox";
import { evaluateSandboxRuntimeSafety } from "../src/security/budget";
import { createWorkspaceFs } from "./support/byokArbitraries";

const WORKSPACE_ROOT = nodePath.resolve("sandbox-policy-hardening-root");
const FIXED_NOW = () => "2026-01-01T00:00:00.000Z";

function countingRunner(result = { exitCode: 0, stdout: "ok", stderr: "" }) {
  let calls = 0;
  const runner: CommandRunner = async () => {
    calls += 1;
    return result;
  };
  return { runner, get calls() { return calls; } };
}

describe("sandbox policy hardening", () => {
  it("constructs an explicit deny-by-default policy", () => {
    const policy = createSandboxPolicy({}, { workspaceRoot: WORKSPACE_ROOT });

    expect(policy.allowedCommands).toEqual([]);
    expect(policy.networkAllowed).toBe(false);
    expect(policy.secretsInjectionAllowed).toBe(false);
    expect(policy.allowShellOperators).toBe(false);
    expect(policy.allowedCwdRoots).toEqual([WORKSPACE_ROOT]);
    expect(policy.maxStdoutBytes).toBe(MAX_CAPTURED_STREAM_BYTES);
    expect(policy.maxStderrBytes).toBe(MAX_CAPTURED_STREAM_BYTES);
  });

  it("blocks traversal before any read/list/write escapes the workspace", async () => {
    const fs = createWorkspaceFs({ root: WORKSPACE_ROOT });
    const adapter = new WorkspaceSandboxAdapter({ workspaceRoot: WORKSPACE_ROOT, fsImpl: fs, now: FIXED_NOW });

    const result = await adapter.operate({ kind: "READ_FILE", path: "../secret.txt" });

    expect(result.status).toBe("DENIED");
    expect(result.denialReason).toBe("PATH_ESCAPE");
    expect(result.resolvedPath).toBeUndefined();
    expect(fs.reads).toEqual([]);
    expect(fs.writes).toEqual([]);
    expect(fs.accessedOutsideRoot()).toEqual([]);
  });

  it("denies destructive and shell-looking commands before the runner is invoked", async () => {
    const runner = countingRunner();
    const adapter = new WorkspaceSandboxAdapter({
      workspaceRoot: WORKSPACE_ROOT,
      allowlistedCommands: ["npm:test"],
      commandRunner: runner.runner,
      now: FIXED_NOW,
    });

    const destructive = await adapter.operate({ kind: "RUN_COMMAND", command: "npm:test", args: ["&&", "rm", "-rf", "."] });
    const shellArg = await adapter.operate({ kind: "RUN_COMMAND", command: "npm:test", args: ["|", "cat"] });

    expect(destructive.status).toBe("DENIED");
    expect(destructive.denialReason).toBe("DESTRUCTIVE_COMMAND_BLOCKED");
    expect(shellArg.status).toBe("DENIED");
    expect(shellArg.denialReason).toBe("ARBITRARY_SHELL_DISABLED");
    expect(runner.calls).toBe(0);
  });

  it("disables network and secret/env injection by default", async () => {
    const runner = countingRunner();
    const adapter = new WorkspaceSandboxAdapter({
      workspaceRoot: WORKSPACE_ROOT,
      allowlistedCommands: ["npm:test"],
      commandRunner: runner.runner,
      now: FIXED_NOW,
    });

    const network = await adapter.operate({
      kind: "RUN_COMMAND",
      command: "npm:test",
      args: [],
      metadata: { network: true },
    });
    const secrets = await adapter.execute({
      kind: "local",
      command: "npm:test",
      args: [],
      timeoutMs: 1_000,
      env: { API_TOKEN: "token=SHOULD_NOT_RUN" },
    });

    expect(network.status).toBe("DENIED");
    expect(network.denialReason).toBe("NETWORK_DISABLED");
    expect(secrets.status).toBe("DENIED");
    expect(secrets.metadata.deniedReason).toBe("SECRETS_DISABLED");
    expect(runner.calls).toBe(0);
  });

  it("truncates and redacts captured output with truncation metadata", async () => {
    const oversizedSecret = `prefix token=SHOULD_NOT_LEAK ${"a".repeat(10_000)}`;
    const adapter = new WorkspaceSandboxAdapter({
      workspaceRoot: WORKSPACE_ROOT,
      allowlistedCommands: ["npm:test"],
      commandRunner: countingRunner({ exitCode: 0, stdout: oversizedSecret, stderr: oversizedSecret }).runner,
      policy: { maxStdoutBytes: 64, maxStderrBytes: 64 },
      now: FIXED_NOW,
    });

    const result = await adapter.operate({ kind: "RUN_COMMAND", command: "npm:test", args: [] });

    expect(result.status).toBe("SUCCEEDED");
    expect(new TextEncoder().encode(result.stdout).length).toBeLessThanOrEqual(64);
    expect(new TextEncoder().encode(result.stderr).length).toBeLessThanOrEqual(64);
    expect(result.metadata.stdoutTruncated).toBe(true);
    expect(result.metadata.stderrTruncated).toBe(true);
    expect(JSON.stringify(result)).not.toContain("SHOULD_NOT_LEAK");
    expect(JSON.stringify(result)).toContain("[REDACTED]");
  });

  it("turns runtime budget violations into safe structured denial results", async () => {
    const runner = countingRunner();
    const adapter = new WorkspaceSandboxAdapter({
      workspaceRoot: WORKSPACE_ROOT,
      allowlistedCommands: ["npm:test"],
      commandRunner: runner.runner,
      policy: { maxRuntimeMs: 50 },
      now: FIXED_NOW,
    });

    const result = await adapter.operate({ kind: "RUN_COMMAND", command: "npm:test", args: [], timeoutMs: 51 });
    const decision = evaluateSandboxRuntimeSafety({ runtimeMs: 51, maxRuntimeMs: 50 });

    expect(decision.status).toBe("denied");
    expect(decision.reasonCodes).toEqual(["SANDBOX_RUNTIME_BUDGET_EXCEEDED"]);
    expect(result.status).toBe("DENIED");
    expect(result.denialReason).toBe("RUNTIME_BUDGET_EXCEEDED");
    expect(result.metadata.safetyReasonCode).toBe("SANDBOX_RUNTIME_BUDGET_EXCEEDED");
    expect(runner.calls).toBe(0);
  });
});
