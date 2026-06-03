import { describe, expect, it, vi } from "vitest";
import {
  PatchArtifactSchema,
  SafeLocalSandboxAdapter,
  SandboxExecutionResultSchema,
  createDepotSandboxAdapterStub,
  createE2BSandboxAdapterStub,
} from "../src/sandbox";

const NOW = "2026-01-01T00:00:00.000Z";

describe("safe code execution sandbox", () => {
  it("denies arbitrary shell commands by default", async () => {
    const sandbox = new SafeLocalSandboxAdapter({ now: () => NOW });

    const result = await sandbox.execute({
      kind: "shell",
      command: "npm",
      args: ["test"],
      timeoutMs: 1_000,
    });

    expect(result).toMatchObject({
      status: "DENIED",
      exitCode: 126,
      networkCalls: 0,
      approvalGates: [],
    });
    expect(result.stderr).toContain("denied");
    expect(result.metadata).toMatchObject({ deniedReason: "ARBITRARY_SHELL_DISABLED" });
  });

  it("executes allowlisted fake local commands only", async () => {
    const sandbox = new SafeLocalSandboxAdapter({ now: () => NOW });

    const result = await sandbox.execute({
      kind: "fake",
      command: "fake:echo",
      args: ["hello", "safe", "world"],
      timeoutMs: 1_000,
    });

    expect(result).toMatchObject({
      status: "SUCCEEDED",
      exitCode: 0,
      stdout: "hello safe world",
      stderr: "",
      networkCalls: 0,
    });
    expect(SandboxExecutionResultSchema.parse(result)).toEqual(result);
  });

  it("requires explicit file-write approval metadata before approving a proposed patch", async () => {
    const sandbox = new SafeLocalSandboxAdapter({ now: () => NOW });

    const result = await sandbox.execute({
      kind: "local",
      command: "local:propose-patch",
      args: ["src/example.ts", "export const value = 1;"],
      timeoutMs: 1_000,
    });

    expect(result.status).toBe("NEEDS_APPROVAL");
    expect(result.exitCode).toBe(0);
    expect(result.networkCalls).toBe(0);
    expect(result.approvalGates).toEqual([
      {
        id: "approval:file-write:src/example.ts",
        type: "FILE_WRITE",
        required: true,
        approved: false,
        reason: "File write proposals require explicit approval metadata before execution.",
        metadata: { path: "src/example.ts", operation: "update" },
      },
    ]);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]).toMatchObject({
      kind: "PATCH",
      path: "src/example.ts",
      approval: { required: true, approved: false },
    });
  });

  it("validates patch artifact schema for approved proposed writes without applying them", async () => {
    const sandbox = new SafeLocalSandboxAdapter({ now: () => NOW });

    const result = await sandbox.execute({
      kind: "local",
      command: "local:propose-patch",
      args: ["src/example.ts", "export const value = 2;"],
      timeoutMs: 1_000,
      metadata: { approval: { fileWriteApproved: true, approvedBy: "local-test" } },
    });

    expect(result.status).toBe("SUCCEEDED");
    expect(result.approvalGates[0]).toMatchObject({ type: "FILE_WRITE", approved: true });
    const artifact = PatchArtifactSchema.parse(result.artifacts[0]);
    expect(artifact).toMatchObject({
      kind: "PATCH",
      path: "src/example.ts",
      operation: "update",
      unifiedDiff: expect.stringContaining("+export const value = 2;"),
      approval: {
        required: true,
        approved: true,
        approvedBy: "local-test",
      },
    });
  });

  it("keeps E2B and Depot adapter stubs network-free", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const e2b = createE2BSandboxAdapterStub({ now: () => NOW });
    const depot = createDepotSandboxAdapterStub({ now: () => NOW });

    await expect(e2b.execute({ kind: "fake", command: "fake:test-pass", timeoutMs: 1_000 })).resolves.toMatchObject({
      status: "DENIED",
      exitCode: 126,
      networkCalls: 0,
      metadata: { provider: "e2b", stub: true },
    });
    await expect(depot.execute({ kind: "fake", command: "fake:test-pass", timeoutMs: 1_000 })).resolves.toMatchObject({
      status: "DENIED",
      exitCode: 126,
      networkCalls: 0,
      metadata: { provider: "depot", stub: true },
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("denies non-allowlisted fake/local commands", async () => {
    const sandbox = new SafeLocalSandboxAdapter({ now: () => NOW });

    // 1. Unsupported fake command
    const fakeResult = await sandbox.execute({
      kind: "fake",
      command: "fake:unsupported-command",
      args: ["hello"],
      timeoutMs: 1_000,
    });
    expect(fakeResult).toMatchObject({
      status: "DENIED",
      exitCode: 126,
      networkCalls: 0,
    });
    expect(fakeResult.stderr).toContain("denied");
    expect(fakeResult.metadata).toMatchObject({ deniedReason: "COMMAND_NOT_ALLOWLISTED" });

    // 2. Unsupported local command
    const localResult = await sandbox.execute({
      kind: "local",
      command: "local:unsupported-command",
      args: ["hello"],
      timeoutMs: 1_000,
    });
    expect(localResult).toMatchObject({
      status: "DENIED",
      exitCode: 126,
      networkCalls: 0,
    });
    expect(localResult.stderr).toContain("denied");
    expect(localResult.metadata).toMatchObject({ deniedReason: "COMMAND_NOT_ALLOWLISTED" });
  });

  it("rejects unsafe paths in local:propose-patch command execution", async () => {
    const sandbox = new SafeLocalSandboxAdapter({ now: () => NOW });

    const unsafePaths = [
      "/etc/passwd",
      "C:\\Windows\\System32\\cmd.exe",
      "D:/some/file.txt",
      "../../etc/passwd",
      "src/../../etc/passwd",
      "./src/example.ts",
      "src/./example.ts",
      "..\\..\\etc\\passwd",
      "src\\..\\..\\etc\\passwd",
    ];

    for (const unsafePath of unsafePaths) {
      const result = await sandbox.execute({
        kind: "local",
        command: "local:propose-patch",
        args: [unsafePath, "export const val = 1;"],
        timeoutMs: 1_000,
      });

      expect(result).toMatchObject({
        status: "DENIED",
        exitCode: 126,
        networkCalls: 0,
      });
      expect(result.stderr).toContain("denied");
      expect(result.metadata).toMatchObject({ deniedReason: "UNSAFE_PATH" });
    }
  });

  it("rejects unsafe paths in PatchArtifactSchema zod schema parsing", () => {
    const unsafePaths = [
      "/etc/passwd",
      "C:\\Windows\\System32\\cmd.exe",
      "D:/some/file.txt",
      "../../etc/passwd",
      "src/../../etc/passwd",
      "./src/example.ts",
      "src/./example.ts",
      "..\\..\\etc\\passwd",
      "src\\..\\..\\etc\\passwd",
    ];

    for (const unsafePath of unsafePaths) {
      const parseResult = PatchArtifactSchema.safeParse({
        kind: "PATCH",
        id: `patch:test-id`,
        path: unsafePath,
        operation: "update",
        unifiedDiff: "--- a/test\n+++ b/test\n",
        createdAt: NOW,
        approval: {
          required: true,
          approved: false,
        },
      });

      expect(parseResult.success).toBe(false);
      if (!parseResult.success) {
        expect(parseResult.error.errors[0].message).toContain("path must be a safe relative file path");
      }
    }
  });
});
