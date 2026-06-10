import { describe, expect, it } from "vitest";

import {
  runSLMPreprocessor,
  validateToolCallsWithSymbolicEngine,
} from "../src/orchestration/preprocessor";
import { triageUserMessage } from "../src/orchestration/triage";
import {
  DEFAULT_SPY_USAGE,
  SpyLLMProvider,
  generousBudget,
  makeContextPack,
  makeExternalRun,
} from "./support/byokArbitraries";

describe("preprocessor symbolic validation", () => {
  it("validateToolCallsWithSymbolicEngine blocks writes outside src/", () => {
    const result = validateToolCallsWithSymbolicEngine([
      { tool: "read_file", args: { path: "README.md" } },
      { tool: "write_file", args: { path: "lib/outside.ts" } },
      { tool: "write_file", args: { path: "src/inside.ts" } },
    ]);

    expect(result.allowed).toEqual([
      { tool: "read_file", args: { path: "README.md" } },
      { tool: "write_file", args: { path: "src/inside.ts" } },
    ]);
    expect(result.constraints.length).toBeGreaterThan(0);
    expect(result.constraints.some((hint) => hint.includes("src/"))).toBe(true);
  });

  it("runSLMPreprocessor removes symbolically blocked tool proposals", async () => {
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [
        {
          content: JSON.stringify({
            distilledContext: "Update config outside src",
            proposedToolCalls: [
              { tool: "write_file", args: { path: "config/app.json" } },
              { tool: "write_file", args: { path: "src/config/app.json" } },
            ],
            entities: ["config"],
            intent: "Update config",
            constraints: [],
          }),
        },
      ],
    });

    const triage = triageUserMessage("Update config");
    const contextPack = makeContextPack(triage, "Update config");
    const run = makeExternalRun(generousBudget());

    const result = await runSLMPreprocessor(
      { rawPrompt: "Update config", contextPack, triage },
      { slmProvider: provider, run }
    );

    expect(result.output.proposedToolCalls).toEqual([
      { tool: "write_file", args: { path: "src/config/app.json" } },
    ]);
    expect(result.output.constraints.length).toBeGreaterThan(0);
  });
});