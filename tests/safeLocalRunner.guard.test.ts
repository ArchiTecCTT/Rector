import { describe, expect, it } from "vitest";

import { WorkspaceSandboxAdapter } from "../src/sandbox";

const WORKSPACE_ROOT = process.cwd();
const FIXED_NOW = () => "2026-01-01T00:00:00.000Z";

describe("safe local runner guard", () => {
  it("keeps the default local workspace runner deterministic and process-free", async () => {
    const adapter = new WorkspaceSandboxAdapter({
      workspaceRoot: WORKSPACE_ROOT,
      allowlistedCommands: ["node"],
      now: FIXED_NOW,
    });

    const result = await adapter.operate({ kind: "RUN_COMMAND", command: "node", args: ["--version"] });

    expect(result.status).toBe("SUCCEEDED");
    // If a real node process ran, stdout would start with vX.Y.Z. The default
    // local mode returns the deterministic stub and never spawns a process.
    expect(result.stdout).toBe("node --version completed");
    expect(result.stdout).not.toMatch(/^v\d+\.\d+\.\d+/);
    expect(result.networkCalls).toBe(0);
  });

  it("denies arbitrary shell by default even when the command is allowlisted", async () => {
    const adapter = new WorkspaceSandboxAdapter({
      workspaceRoot: WORKSPACE_ROOT,
      allowlistedCommands: ["node"],
      now: FIXED_NOW,
    });

    const result = await adapter.execute({
      kind: "shell",
      command: "node",
      args: ["--version"],
      timeoutMs: 1_000,
    });

    expect(result.status).toBe("DENIED");
    expect(result.metadata.deniedReason).toBe("ARBITRARY_SHELL_DISABLED");
  });

  it("runs a vetted local command only when the safe local runner is explicitly enabled", async () => {
    const adapter = new WorkspaceSandboxAdapter({
      workspaceRoot: WORKSPACE_ROOT,
      allowlistedCommands: ["node"],
      safeLocalRunner: {
        enabled: true,
        commandMap: { node: process.execPath },
        envAllowlist: [],
      },
      policy: { maxRuntimeMs: 5_000 },
      now: FIXED_NOW,
    });

    const result = await adapter.operate({
      kind: "RUN_COMMAND",
      command: "node",
      args: ["--version"],
      timeoutMs: 5_000,
    });

    expect(result.status).toBe("SUCCEEDED");
    expect(result.stdout.trim()).toMatch(/^v\d+\.\d+\.\d+/);
    expect(result.networkCalls).toBe(0);
    expect(result.metadata.stdoutTruncated).toBe(false);
  });
});
