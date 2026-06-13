import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { ToolRegistry, type ToolRegistryEntry } from "../src/tools";

const TOOL_NAMES = [
  "alpha.tool",
  "beta.tool",
  "gamma.tool",
  "delta.tool",
  "epsilon.tool",
] as const;

describe("ToolRegistry properties", () => {
  it("lists registered tool names and dispatch never throws for registered or unknown names", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.constantFrom(...TOOL_NAMES), { minLength: 1, maxLength: TOOL_NAMES.length }),
        fc.constantFrom(...TOOL_NAMES, "unknown.tool"),
        async (names, dispatchName) => {
          const registry = new ToolRegistry();
          for (const name of names) {
            registry.register(entry(name));
          }

          const listed = registry.list().map((tool) => tool.name);
          for (const name of names) {
            expect(listed).toContain(name);
          }

          let result;
          try {
            result = await registry.dispatch(dispatchName, {}, {
              runId: "run-property",
              nodeId: "node-property",
              conversationId: "conversation-property",
            });
          } catch (error) {
            throw new Error(`dispatch threw unexpectedly: ${String(error)}`);
          }
          expect(result).toMatchObject({ ok: expect.any(Boolean) });
        },
      ),
      { numRuns: 100 },
    );
  });
});

function entry(name: string): ToolRegistryEntry {
  return {
    definition: {
      name,
      description: `${name} property tool`,
      inputSchema: {},
      risk: "low",
      requiresApproval: false,
      requiresSandbox: false,
    },
    source: "builtin",
    handler: async () => ({ ok: true, toolName: name, output: { name } }),
  };
}
