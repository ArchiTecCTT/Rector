import { describe, expect, it, vi } from "vitest";

import { ToolRegistry, runToolWithMiddleware, shouldHalt, type ToolRegistryEntry } from "../src/tools";
import type { Budget } from "../src/store/schemas";

function makeRegistry(handler = vi.fn(async () => ({ ok: true, toolName: "test.tool", output: { ok: true } }))) {
  const registry = new ToolRegistry();
  registry.register({
    definition: {
      name: "test.tool",
      description: "middleware test tool",
      inputSchema: {},
      risk: "low",
      requiresApproval: false,
      requiresSandbox: false,
    },
    source: "builtin",
    handler,
  } satisfies ToolRegistryEntry);
  return { registry, handler };
}

describe("tool middleware", () => {
  it("blocks workspace.write_file without FILE_WRITE approval before handler execution", async () => {
    const handler = vi.fn(async () => ({ ok: true, toolName: "workspace.write_file", output: {} }));
    const registry = new ToolRegistry();
    registry.register({
      definition: {
        name: "workspace.write_file",
        description: "write",
        inputSchema: {},
        risk: "destructive",
        requiresApproval: true,
        requiresSandbox: true,
      },
      source: "builtin",
      handler,
    });

    const result = await runToolWithMiddleware(registry, "workspace.write_file", { path: "src/app.ts", content: "x" }, context());

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PERMISSION_DENIED");
    expect(result.middlewareHalt).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it("blocks exhausted budget before the handler", async () => {
    const { registry, handler } = makeRegistry();
    const result = await runToolWithMiddleware(registry, "test.tool", {}, {
      ...context(),
      budget: { ...budget(), maxModelCalls: 0 },
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("BUDGET_EXCEEDED");
    expect(shouldHalt(result)).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it("redacts input and output at event boundaries and records middleware order", async () => {
    const secret = "sk-toolmiddlewaresecret0123456789abcdef";
    const events: unknown[] = [];
    const handler = vi.fn(async () => ({
      ok: true,
      toolName: "test.tool",
      output: { token: secret },
    }));
    const { registry } = makeRegistry(handler);

    const result = await runToolWithMiddleware(registry, "test.tool", { apiKey: secret }, {
      ...context(),
      appendRunEvent: (event) => events.push(event),
    });

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(result.metadata.middlewareTrace).toEqual([
      "budget",
      "redactionInput",
      "approval",
      "policy",
      "handler",
      "redactionOutput",
      "trace",
    ]);
  });

  it("policy denial halts before the handler", async () => {
    const { registry, handler } = makeRegistry();
    const result = await runToolWithMiddleware(registry, "test.tool", {}, {
      ...context(),
      toolPolicy: { allowed: ["other.tool"] },
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("POLICY_DENIED");
    expect(result.middlewareHalt).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });
});

function context() {
  return {
    runId: "run-middleware",
    nodeId: "node-middleware",
    conversationId: "conversation-middleware",
  };
}

function budget(): Budget {
  return {
    maxUsd: 1,
    maxInputTokens: 1_000,
    maxOutputTokens: 1_000,
    maxModelCalls: 4,
    maxRuntimeMs: 60_000,
    maxHealingAttempts: 1,
    allowedProviders: [],
    approvalRequiredAboveUsd: 0,
  };
}
