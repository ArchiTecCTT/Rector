import { describe, expect, it } from "vitest";
import { createDefaultToolRegistry } from "../../src/tools";
import {
  buildToolGraph,
  type BuildToolGraphInput,
} from "../../src/cartographer/toolGraphAdapter";

describe("toolGraphAdapter", () => {
  it("builds Tool nodes from ToolRegistry.list() with required properties", () => {
    const registry = createDefaultToolRegistry();
    const defs = registry.list();
    const input: BuildToolGraphInput = {
      snapshotId: "snap:tool-1",
      tools: defs,
    };
    const res = buildToolGraph(input);
    expect(res.nodes.length).toBeGreaterThan(0);
    const echo = res.nodes.find((n) => n.label === "simulator.echo");
    expect(echo).toBeDefined();
    expect(echo?.kind).toBe("Tool");
    expect(echo?.properties.productionAdmission).toBe("test_only");
    expect(echo?.properties.toolSource).toBe("builtin");
    const validate = res.nodes.find((n) => n.label === "workspace.validate");
    expect(validate).toBeDefined();
    expect(validate?.properties.productionAdmission).toBe("production");
    expect(String(validate?.properties.fakeValidationWarning ?? "")).toContain("fake-validation");
    // No edges from tool definitions alone
    expect(res.edges.length).toBe(0);
  });

  it("never marks simulator.echo as production", () => {
    const registry = createDefaultToolRegistry();
    const defs = registry.list();
    const res = buildToolGraph({ snapshotId: "s", tools: defs });
    const echo = res.nodes.find((n) => n.label === "simulator.echo");
    expect(echo?.properties.productionAdmission).not.toBe("production");
  });
});
