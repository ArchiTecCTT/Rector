import { describe, expect, it } from "vitest";

import { RectorFactSchema, toolCallToFact, toolDefinitionToFact, toolEventSinkInputToFacts, toolResultToFacts } from "../../src/facts";
import { toolError, toolSuccess, type ToolSchemaDefinition } from "../../src/tools/types";

const OPTIONS = { runId: "run-tool", createdAt: "2026-06-28T00:00:00.000Z" };

function expectValidFacts(facts: readonly unknown[]) {
  for (const fact of facts) expect(RectorFactSchema.safeParse(fact).success).toBe(true);
}

describe("ToolRegistry fact adapter", () => {
  it("preserves tool definition risk, approval, and sandbox flags", () => {
    const definition: ToolSchemaDefinition = {
      name: "workspace.write_file",
      description: "Write a file",
      inputSchema: { type: "object" },
      risk: "destructive",
      requiresApproval: true,
      requiresSandbox: true,
    };

    const fact = toolDefinitionToFact(definition, OPTIONS);

    expectValidFacts([fact]);
    expect(fact.toolName).toBe("workspace.write_file");
    expect(fact.risk).toBe("destructive");
    expect(fact.requiresApproval).toBe(true);
    expect(fact.requiresSandbox).toBe(true);
  });

  it("redacts tool call args before durable fact emission", () => {
    const fact = toolCallToFact({
      callId: "call-secret-1",
      toolName: "http.fetch",
      args: { url: "https://user:pass@example.com/path", apiKey: "sk-live-secret" },
      options: OPTIONS,
    });

    expectValidFacts([fact]);
    expect(fact.callId).toBe("call-secret-1");
    expect(fact.args).toMatchObject({ url: "https://[REDACTED]@example.com/path", apiKey: "[REDACTED]" });
    expect(fact.redactionState).toBe("redacted");
  });

  it("distinguishes handler failure from successful tool result", () => {
    const successFacts = toolResultToFacts({ callId: "call-ok", result: toolSuccess("rg.search", { matches: 2 }), options: OPTIONS });
    const failureFacts = toolResultToFacts({
      callId: "call-fail",
      result: toolError("rg.search", "POLICY_DENIED", "Tool is denied", { details: { denied: ["rg.search"] } }),
      options: OPTIONS,
    });

    expectValidFacts([...successFacts, ...failureFacts]);
    expect(successFacts).toHaveLength(1);
    expect(successFacts[0]?.kind).toBe("tool_result");
    expect(failureFacts.map((fact) => fact.kind)).toEqual(["tool_result", "tool_failure"]);
    const failure = failureFacts.find((fact) => fact.kind === "tool_failure");
    expect(failure?.kind).toBe("tool_failure");
    if (failure?.kind === "tool_failure") {
      expect(failure.code).toBe("POLICY_DENIED");
      expect(failure.trust.level).toBe("rejected");
    }
  });

  it("converts budget event sink payloads into warning facts", () => {
    const facts = toolEventSinkInputToFacts({
      callId: "call-budget",
      options: OPTIONS,
      event: {
        type: "RUN_BUDGET_EXHAUSTED",
        phase: "EXECUTING",
        payload: { toolName: "rg.search", reason: "tool_call_budget_exhausted" },
      },
    });

    expectValidFacts(facts);
    expect(facts[0]?.kind).toBe("capability_warning");
    if (facts[0]?.kind === "capability_warning") expect(facts[0].warning).toBe("tool_call_budget_exhausted");
  });
});
