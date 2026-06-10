import { describe, expect, it } from "vitest";

import { DEFAULT_PREPROCESSOR_RULES } from "../src/symbolic/defaultRules";
import { SimpleRuleEngine, type Rule } from "../src/symbolic/symbolicEngine";

describe("symbolic engine", () => {
  const engine = new SimpleRuleEngine();

  it("blocks write_file when path does not start with src/", () => {
    const result = engine.evaluate(DEFAULT_PREPROCESSOR_RULES, {
      tool: "write_file",
      args: { path: "lib/outside.ts" },
    });

    expect(result.blocked).toBe(true);
    expect(result.matched.some((rule) => rule.id === "write-file-src-only")).toBe(true);
  });

  it("allows write_file when path starts with src/", () => {
    const result = engine.evaluate(DEFAULT_PREPROCESSOR_RULES, {
      tool: "write_file",
      args: { path: "src/api/server.ts" },
    });

    expect(result.blocked).toBe(false);
    expect(result.actions.some((action) => action.startsWith("suggest:"))).toBe(true);
  });

  it("does not block non-write tools", () => {
    const result = engine.evaluate(DEFAULT_PREPROCESSOR_RULES, {
      tool: "read_file",
      args: { path: "README.md" },
    });

    expect(result.blocked).toBe(false);
    expect(result.matched).toEqual([]);
  });

  it("respects rule priority ordering", () => {
    const rules: Rule[] = [
      { id: "low", condition: "tool === 'write_file'", action: "suggest:low", priority: 1 },
      { id: "high", condition: "tool === 'write_file'", action: "suggest:high", priority: 10 },
    ];

    const result = engine.evaluate(rules, { tool: "write_file", args: { path: "src/a.ts" } });
    expect(result.matched[0]?.id).toBe("high");
  });
});