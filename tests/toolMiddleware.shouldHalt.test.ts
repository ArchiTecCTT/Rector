import { describe, expect, it } from "vitest";

import { shouldHalt } from "../src/tools";
import { ToolResultSchema, toolError, toolSuccess } from "../src/tools/types";

describe("shouldHalt", () => {
  it("locks the parsed ToolResult halt truth table", () => {
    const cases = [
      {
        name: "defaults halt and middlewareHalt to false for a successful result",
        result: ToolResultSchema.parse({ ok: true, toolName: "t", output: {} }),
        expected: false,
      },
      {
        name: "halts when halt is true",
        result: ToolResultSchema.parse({ ok: true, toolName: "t", output: {}, halt: true }),
        expected: true,
      },
      {
        name: "halts when middlewareHalt is true",
        result: ToolResultSchema.parse({ ok: true, toolName: "t", output: {}, middlewareHalt: true }),
        expected: true,
      },
      {
        name: "halts when ok is false",
        result: ToolResultSchema.parse({ ok: false, toolName: "t", output: {} }),
        expected: true,
      },
      {
        name: "does not halt when every halt flag is explicitly false",
        result: ToolResultSchema.parse({ ...toolSuccess("t"), halt: false, middlewareHalt: false }),
        expected: false,
      },
      {
        name: "halts for a parsed toolError helper result",
        result: toolError("t", "TOOL_HANDLER_FAILED", "failed"),
        expected: true,
      },
    ];

    for (const testCase of cases) {
      expect(shouldHalt(testCase.result), testCase.name).toBe(testCase.expected);
    }
  });
});
