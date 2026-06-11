import { describe, it, expect } from "vitest";
import {
  buildPlannerPrompt,
  buildPlannerRepairPrompt,
  buildRepairPrompt,
  buildSkepticPrompt,
  buildSkepticRepairPrompt,
  buildSynthesizerPrompt,
  PLANNER_SYSTEM_RULES,
  PLANNER_JSON_CONTRACT,
  SKEPTIC_SYSTEM_RULES,
  SKEPTIC_JSON_CONTRACT,
  sanitizeMemoryContextForPrompt,
  type SkepticPromptInput,
} from "../src/orchestration/prompts";
import { createFakePlan, type PlannerInput, type PlannerOutput } from "../src/orchestration/planner";
import { arbitratePlanWithCrucible } from "../src/orchestration/crucible";
import { reviewPlanWithSkeptic } from "../src/orchestration/skeptic";
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

function skepticInputFor(content: string): SkepticPromptInput {
  const planner = inputFor(content);
  const plannerOutput = createFakePlan(planner);
  return { plannerOutput, contextPack: planner.contextPack, triage: planner.triage };
}

describe("skeptic prompt construction", () => {
  it("builds a system + user prompt with rules, contract, and the plan to critique", () => {
    const messages = buildSkepticPrompt(skepticInputFor("Fix the bug in src/api/server.ts and update tests."));

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain(SKEPTIC_SYSTEM_RULES);
    expect(messages[0].content).toContain(SKEPTIC_JSON_CONTRACT);

    expect(messages[1].role).toBe("user");
    // The serialized plan goal and triage route are embedded so the model critiques the real plan.
    expect(messages[1].content).toContain("CODE_EDIT");
    expect(messages[1].content).toContain("code.edit");
  });

  it("documents the draft JSON contract fields the validator enforces", () => {
    const systemContent = buildSkepticPrompt(skepticInputFor("Explain Rector")).at(0)!.content;

    for (const field of ["verdict", "findings", "severity", "category", "message", "evidence", "recommendation"]) {
      expect(systemContent).toContain(`"${field}"`);
    }
    expect(systemContent).toContain("BLOCKER");
  });

  it("validates input against the schema before building a prompt", () => {
    const invalid = { plannerOutput: { goal: "" }, contextPack: {} } as unknown as SkepticPromptInput;
    expect(() => buildSkepticPrompt(invalid)).toThrow();
  });

  it("redacts secrets embedded in the plan before they reach the prompt", () => {
    const base = skepticInputFor("Investigate the leak and update tests.");
    const plannerOutput: PlannerOutput = {
      ...base.plannerOutput,
      goal: "Rotate the leaked credential token=supersecret123 found in logs",
    };

    const messages = buildSkepticPrompt({ ...base, plannerOutput });

    expect(messages[1].content).not.toContain("supersecret123");
    expect(messages[1].content).toContain("token=[REDACTED]");
  });

  it("builds a repair prompt that replays context and includes the prior draft and error", () => {
    const input = skepticInputFor("Add pagination to the /users endpoint and update tests.");
    const priorContent = '{"verdict": "SOUND"}';
    const errorSummary = "findings: Required";

    const messages = buildSkepticRepairPrompt(input, priorContent, errorSummary);

    expect(messages).toHaveLength(4);
    expect(messages[2]).toEqual({ role: "assistant", content: priorContent });
    expect(messages[3].role).toBe("user");
    expect(messages[3].content).toContain(errorSummary);
    expect(messages[3].content).toContain("ONLY the corrected JSON object");
  });

  it("reuses the same system rules and context message in the repair prompt", () => {
    const input = skepticInputFor("Refactor the planner module and add tests.");
    const initial = buildSkepticPrompt(input);
    const repair = buildSkepticRepairPrompt(input, "bad output", "verdict: Invalid enum value");

    expect(repair[0]).toEqual(initial[0]);
    expect(repair[1]).toEqual(initial[1]);
  });
});

const MEMORY_NOTE = "3 days ago you noted: prefer integration tests for API changes";

function contextPackWithMemory(triage: TriageResult, intent = "Test user intent"): ContextPack {
  return {
    ...contextPackFor(triage, intent),
    memoryContext: [MEMORY_NOTE],
  };
}

describe("memoryContext prompt injection", () => {
  it("includes memoryContext in planner prompts when present", () => {
    const triage = triageUserMessage("Fix the flaky login test");
    const input: PlannerInput = {
      triage,
      contextPack: contextPackWithMemory(triage, "Fix the flaky login test"),
      messageContent: "Fix the flaky login test",
    };

    const messages = buildPlannerPrompt(input);
    expect(messages[1].content).toContain('"memoryContext"');
    expect(messages[1].content).toContain(MEMORY_NOTE);
  });

  it("includes memoryContext in skeptic prompts when present", () => {
    const planner = inputFor("Fix the flaky login test");
    planner.contextPack = contextPackWithMemory(planner.triage, "Fix the flaky login test");
    const messages = buildSkepticPrompt({
      plannerOutput: createFakePlan(planner),
      contextPack: planner.contextPack,
      triage: planner.triage,
    });

    expect(messages[1].content).toContain('"memoryContext"');
    expect(messages[1].content).toContain(MEMORY_NOTE);
  });

  it("includes memoryContext in synthesizer prompts when present", () => {
    const planner = inputFor("Fix the flaky login test");
    planner.contextPack = contextPackWithMemory(planner.triage, "Fix the flaky login test");
    const plannerOutput = createFakePlan(planner);
    const skepticReview = reviewPlanWithSkeptic(plannerOutput, planner.contextPack);
    const crucibleDecision = arbitratePlanWithCrucible({
      plannerOutput,
      skepticReview,
      now: () => "2026-01-01T00:00:00.000Z",
    });

    const messages = buildSynthesizerPrompt({
      traceId: "trace-memory-context",
      triage: planner.triage,
      contextPack: planner.contextPack,
      plannerOutput,
      skepticReview,
      crucibleDecision,
    });

    expect(messages[1].content).toContain('"memoryContext"');
    expect(messages[1].content).toContain(MEMORY_NOTE);
  });

  it("includes memoryContext in repair prompts when present", () => {
    const triage = triageUserMessage("Fix the flaky login test");
    const messages = buildRepairPrompt({
      classification: "test_failure",
      failedOutput: "AssertionError: expected 200",
      contextPack: contextPackWithMemory(triage, "Fix the flaky login test"),
    });

    expect(messages[1].content).toContain('"memoryContext"');
    expect(messages[1].content).toContain(MEMORY_NOTE);
  });

  it("omits memoryContext when absent", () => {
    const messages = buildPlannerPrompt(inputFor("Explain Rector"));
    expect(messages[1].content).not.toContain('"memoryContext"');
  });

  it("caps memoryContext entries and line length for prompt safety", () => {
    const longLine = "x".repeat(300);
    const sanitized = sanitizeMemoryContextForPrompt([
      longLine,
      ...Array.from({ length: 10 }, (_, index) => `entry-${index}`),
    ]);

    expect(sanitized).toHaveLength(8);
    expect(sanitized?.every((line) => line.length <= 200)).toBe(true);
    expect(sanitized?.[0]).toBe("x".repeat(200));
    expect(sanitized?.[7]).toBe("entry-6");
  });
});
