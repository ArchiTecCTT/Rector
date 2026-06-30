import { describe, expect, it } from "vitest";
import { createDefaultToolRegistry } from "../../src/tools";
import { toolSuccess, type ToolRegistryEntry } from "../../src/tools/types";
import {
  buildToolGraph,
  type BuildToolGraphInput,
} from "../../src/cartographer/toolGraphAdapter";

describe("toolGraphAdapter", () => {
  it("builds Tool nodes from ToolRegistry.snapshot() with required properties", () => {
    const registry = createDefaultToolRegistry();
    const input: BuildToolGraphInput = {
      snapshotId: "snap:tool-1",
      toolEntries: registry.snapshot(),
    };
    const res = buildToolGraph(input);
    expect(res.nodes.length).toBeGreaterThan(0);
    const echo = res.nodes.find((n) => n.label === "simulator.echo");
    expect(echo).toBeUndefined();
    const validate = res.nodes.find((n) => n.label === "workspace.validate");
    expect(validate).toBeDefined();
    expect(validate?.properties.productionAdmission).toBe("production");
    expect(validate?.properties.fakeValidationWarning).toBeUndefined();
    // No edges from tool definitions alone
    expect(res.edges.length).toBe(0);
  });

  it("never marks simulator.echo as production", () => {
    const res = buildToolGraph({ snapshotId: "s", toolEntries: [simulatorEchoEntry()] });
    const echo = res.nodes.find((n) => n.label === "simulator.echo");
    expect(echo?.properties.productionAdmission).not.toBe("production");
  });

  it("preserves module source and moduleId from registry entries", () => {
    const moduleEntry: ToolRegistryEntry = {
      definition: {
        name: "module.synthetic_tool",
        description: "Synthetic module tool for graph adapter tests",
        inputSchema: { type: "object", properties: {} },
        risk: "low",
        requiresApproval: false,
        requiresSandbox: false,
      },
      source: "module",
      moduleId: "synthetic-module",
      handler: async () => toolSuccess("module.synthetic_tool"),
    };
    const res = buildToolGraph({ snapshotId: "s", toolEntries: [moduleEntry] });
    const node = res.nodes.find((n) => n.label === "module.synthetic_tool");
    expect(node?.properties.toolSource).toBe("module");
    expect(node?.properties.moduleId).toBe("synthetic-module");
  });

  it("still accepts tools definitions without entries for compatibility", () => {
    const registry = createDefaultToolRegistry();
    const defs = registry.list();
    const res = buildToolGraph({ snapshotId: "s", tools: defs });
    expect(res.nodes.length).toBeGreaterThan(0);
    expect(res.nodes.every((n) => n.properties.toolSource === "builtin")).toBe(true);
  });
});

function simulatorEchoEntry(): ToolRegistryEntry {
  return {
    definition: {
      name: "simulator.echo",
      description: "Deterministic simulator-only echo tool used by graph-adapter tests.",
      inputSchema: { type: "object", additionalProperties: true },
      risk: "low",
      requiresApproval: false,
      requiresSandbox: false,
    },
    source: "builtin",
    handler: async () => toolSuccess("simulator.echo"),
  };
}
