import { describe, expect, it } from "vitest";

import {
  checkE2BSandboxReadiness,
  createE2BSandboxAdapter,
  type E2BClient,
} from "../src/sandbox/e2bSandboxAdapter";

const FIXED_NOW = () => "2026-01-01T00:00:00.000Z";
const WORKSPACE_ROOT = "/workspace";

describe("E2B adapter hardening", () => {
  it("reports readiness only when API key, explicit external network mode, and timeout are present", () => {
    expect(checkE2BSandboxReadiness({ apiKey: "", networkMode: "external", defaultTimeoutMs: 1_000 })).toMatchObject({
      ready: false,
      reasonCodes: ["E2B_API_KEY_MISSING"],
    });
    expect(checkE2BSandboxReadiness({ apiKey: "key", defaultTimeoutMs: 1_000 })).toMatchObject({
      ready: false,
      reasonCodes: ["E2B_NETWORK_MODE_NOT_EXTERNAL"],
    });
    expect(checkE2BSandboxReadiness({ apiKey: "key", networkMode: "external" })).toMatchObject({
      ready: false,
      reasonCodes: ["E2B_TIMEOUT_MISSING"],
    });
    expect(checkE2BSandboxReadiness({ apiKey: "key", networkMode: "external", defaultTimeoutMs: 1_000 })).toMatchObject({
      ready: true,
      reasonCodes: [],
    });
  });

  it("applies configurable stream caps and redacts captured container output", async () => {
    const secret = "E2BSECRET123456";
    const stdout = `token=${secret} ${"a".repeat(200)}`;
    const stderr = `Bearer ${secret} ${"b".repeat(200)}`;
    const client: E2BClient = {
      runCommand: () => ({ exitCode: 0, stdout, stderr }),
      writeFile: () => {},
    };
    const adapter = createE2BSandboxAdapter({
      apiKey: "e2b-test-key",
      networkMode: "external",
      workspaceRoot: WORKSPACE_ROOT,
      allowlistedCommands: ["echo"],
      defaultTimeoutMs: 1_000,
      maxStdoutBytes: 32,
      maxStderrBytes: 32,
      clientFactory: () => client,
      now: FIXED_NOW,
    });

    const result = await adapter.execute({ kind: "local", command: "echo", args: [], timeoutMs: 1_000 });

    expect(result.status).toBe("SUCCEEDED");
    expect(new TextEncoder().encode(result.stdout).length).toBeLessThanOrEqual(32);
    expect(new TextEncoder().encode(result.stderr).length).toBeLessThanOrEqual(32);
    expect(result.metadata.stdoutTruncated).toBe(true);
    expect(result.metadata.stderrTruncated).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).toContain("[REDACTED]");
    expect(result.networkCalls).toBe(0);
  });

  it.skipIf(process.env.RECTOR_E2B_LIVE_SMOKE !== "1" || !process.env.E2B_API_KEY)(
    "optional live smoke is gated by RECTOR_E2B_LIVE_SMOKE=1 and E2B_API_KEY",
    async () => {
      const readiness = checkE2BSandboxReadiness({
        apiKey: process.env.E2B_API_KEY ?? "",
        networkMode: "external",
        defaultTimeoutMs: 5_000,
      });
      expect(readiness.ready).toBe(true);
    },
  );
});
