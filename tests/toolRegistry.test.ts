import { describe, expect, it, vi } from "vitest";

import { ToolRegistry, type ToolRegistryEntry } from "../src/tools";

function entry(name: string, handler = vi.fn(async () => ({ ok: true, toolName: name, output: { name } }))) {
  return {
    definition: {
      name,
      description: `${name} test tool`,
      inputSchema: {},
      risk: "low",
      requiresApproval: false,
      requiresSandbox: false,
    },
    source: "builtin",
    handler,
  } satisfies ToolRegistryEntry;
}

describe("ToolRegistry", () => {
  it("throws on duplicate registration", () => {
    const registry = new ToolRegistry();
    registry.register(entry("test.echo"));

    expect(() => registry.register(entry("test.echo"))).toThrow("Tool already registered");
  });

  it("returns TOOL_UNAVAILABLE without calling the handler when checkFn is false", async () => {
    const handler = vi.fn(async () => ({ ok: true, toolName: "test.blocked", output: {} }));
    const registry = new ToolRegistry();
    registry.register({ ...entry("test.blocked", handler), checkFn: () => false });

    const result = await registry.dispatch("test.blocked", {}, baseContext());

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("TOOL_UNAVAILABLE");
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns a structured error for an unknown tool without throwing", async () => {
    const registry = new ToolRegistry();

    const result = await registry.dispatch("missing.tool", {}, baseContext());

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("TOOL_NOT_FOUND");
    expect(result.halt).toBe(true);
  });

  it("runs async handlers and redacts thrown handler errors", async () => {
    const secret = "sk-toolregistrysecret0123456789abcdef";
    const registry = new ToolRegistry();
    registry.register(entry("test.throws", vi.fn(async () => {
      throw new Error(`failed with token=${secret}`);
    })));

    const result = await registry.dispatch("test.throws", {}, baseContext());

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("TOOL_HANDLER_FAILED");
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("lists registered definitions by name", () => {
    const registry = new ToolRegistry();
    registry.register(entry("z.tool"));
    registry.register(entry("a.tool"));

    expect(registry.list().map((tool) => tool.name)).toEqual(["a.tool", "z.tool"]);
  });
});

function baseContext() {
  return {
    runId: "run-tools",
    nodeId: "node-tools",
    conversationId: "conversation-tools",
  };
}
