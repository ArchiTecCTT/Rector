import { describe, it, expect } from "vitest";
import {
  buildPlannerPrompt,
  buildPlannerRepairPrompt,
  PLANNER_SYSTEM_RULES,
  PLANNER_JSON_CONTRACT,
} from "../src/orchestration/prompts";
import { type PlannerInput } from "../src/orchestration/planner";
import { triageUserMessage, type TriageResult } from "../src/orchestration/triage";
import type { ContextPack } from "../src/orchestration/contextBuilder";

function contextPackFor(triage: TriageResult, intent = "Test user intent"): ContextPack {
  return {
    id: "ctx-test",
    createdAt: "2026-01-01T00:00:00.000Z",
    userIntentSummary: intent,
    conversationRef: { id: "conv-test", title: "Prompt test", workspaceId: "local" },
    messageRefs: [
      { id: "msg-test", role: "user", status: "completed", createdAt: "2026-01-01T00:00:00.000Z" },
    ],
    relevantDocs: [],
    relevantMemory: [],
    constraints: ["No provider calls in prompt tests"],
    availableProviders: { configured: [], unavailable: [], notes: [] },
    availableTools: { names: [], notes: [] },
    riskFlags: triage.riskFlags,
    triage,
    artifactHandles: [],
    inlineContext: [],
  };
}

function inputFor(content: string): PlannerInput {
  const triage = triageUserMessage(content);
  return { triage, contextPack: contextPackFor(triage, content), messageContent: content };
}

describe("planner prompt construction", () => {
  it("builds a system + user prompt with rules, contract, and context", () => {
    const messages = buildPlannerPrompt(inputFor("Fix the bug in src/api/server.ts and update tests."));

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain(PLANNER_SYSTEM_RULES);
    expect(messages[0].content).toContain(PLANNER_JSON_CONTRACT);

    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toContain("Fix the bug in src/api/server.ts");
    // Triage route is embedded in the serialized context so the model honors the routing decision.
    expect(messages[1].content).toContain("CODE_EDIT");
  });

  it("documents the JSON contract fields the validator enforces", () => {
    const messages = buildPlannerPrompt(inputFor("Explain Rector"));
    const systemContent = messages[0].content;

    for (const field of ["goal", "assumptions", "tasks", "dependencies", "validation", "riskLevel", "approvalGates"]) {
      expect(systemContent).toContain(`"${field}"`);
    }
    expect(systemContent).toContain("approval gate");
  });

  it("validates input against PlannerInputSchema before building a prompt", () => {
    const invalid = { triage: { route: "NOPE" }, contextPack: {} } as unknown as PlannerInput;
    expect(() => buildPlannerPrompt(invalid)).toThrow();
  });

  it("builds a repair prompt that replays context and includes the prior output and error", () => {
    const input = inputFor("Add pagination to the /users endpoint and update tests.");
    const priorContent = '{"goal": "incomplete"}';
    const errorSummary = "tasks: Required";

    const messages = buildPlannerRepairPrompt(input, priorContent, errorSummary);

    expect(messages).toHaveLength(4);
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
    expect(messages[2]).toEqual({ role: "assistant", content: priorContent });
    expect(messages[3].role).toBe("user");
    expect(messages[3].content).toContain(errorSummary);
    expect(messages[3].content).toContain("ONLY the corrected JSON object");
  });

  it("reuses the same system rules and context message in the repair prompt", () => {
    const input = inputFor("Refactor the planner module and add tests.");
    const initial = buildPlannerPrompt(input);
    const repair = buildPlannerRepairPrompt(input, "bad output", "riskLevel: Invalid enum value");

    expect(repair[0]).toEqual(initial[0]);
    expect(repair[1]).toEqual(initial[1]);
  });

  it("falls back to intent then context summary when messageContent is absent", () => {
    const triage = triageUserMessage("Plan a migration");
    const input: PlannerInput = {
      triage,
      contextPack: contextPackFor(triage, "Context summary intent"),
      intent: "Explicit intent text",
    };

    const messages = buildPlannerPrompt(input);
    expect(messages[1].content).toContain("Explicit intent text");
  });
});
