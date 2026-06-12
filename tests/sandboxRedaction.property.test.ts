import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { WorkspaceSandboxAdapter, type CommandRunner } from "../src/sandbox";

const WORKSPACE_ROOT = process.cwd();
const FIXED_NOW = () => "2026-01-01T00:00:00.000Z";

const secretArb = fc
  .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("")), {
    minLength: 8,
    maxLength: 32,
  })
  .map((chars) => chars.join(""));

describe("sandbox redaction property", () => {
  it("redacts secret-looking stdout/stderr before returning sandbox results", async () => {
    await fc.assert(
      fc.asyncProperty(secretArb, async (secret) => {
        const runner: CommandRunner = async () => ({
          exitCode: 0,
          stdout: `build ok token=${secret}`,
          stderr: `warning Bearer ${secret}`,
        });
        const adapter = new WorkspaceSandboxAdapter({
          workspaceRoot: WORKSPACE_ROOT,
          allowlistedCommands: ["npm:test"],
          commandRunner: runner,
          now: FIXED_NOW,
        });

        const result = await adapter.operate({ kind: "RUN_COMMAND", command: "npm:test", args: [] });
        const serialized = JSON.stringify(result);

        expect(result.status).toBe("SUCCEEDED");
        expect(serialized).not.toContain(secret);
        expect(result.stdout).toContain("token=[REDACTED]");
        expect(result.stderr).toContain("Bearer [REDACTED]");
        expect(result.networkCalls).toBe(0);
      }),
      { numRuns: 150 },
    );
  });
});
