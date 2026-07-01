import { describe, expect, it } from "vitest";

import {
  buildStructuredRepairUserMessage,
  harnessScenarioRoleCard,
  inferHarnessScenarioIdFromContextPack,
  PLANNER_STRICT_JSON_CARD,
  STRICT_JSON_OUTPUT_HABITS,
} from "../../src/orchestration/strictJsonPromptCards";
import type { ContextPack } from "../../src/orchestration/contextBuilder";
import { triageUserMessage } from "../../src/orchestration/triage";

function contextPackWithTitle(title: string): ContextPack {
  const triage = triageUserMessage("Harness smoke");
  return {
    id: "ctx-harness",
    createdAt: "2026-01-01T00:00:00.000Z",
    userIntentSummary: "Harness smoke",
    conversationRef: { id: "conv-harness", title, workspaceId: "zai-live-harness" },
    messageRefs: [],
    relevantDocs: [],
    relevantMemory: [],
    constraints: [],
    availableProviders: { configured: [], unavailable: [], notes: [] },
    availableTools: { names: [], notes: [] },
    riskFlags: triage.riskFlags,
    triage,
    artifactHandles: [],
    inlineContext: [],
  };
}

describe("strictJsonPromptCards", () => {
  it("infers harness scenario id from conversation title", () => {
    expect(inferHarnessScenarioIdFromContextPack(contextPackWithTitle("Z.ai harness B2"))).toBe("B2");
    expect(inferHarnessScenarioIdFromContextPack(contextPackWithTitle("Regular chat"))).toBeUndefined();
  });

  it("includes B2 dependency guidance in planner harness card", () => {
    const card = harnessScenarioRoleCard("B2", "planner");
    expect(card).toContain("tasks[].dependencies");
    expect(card).toContain("tasks[].id");
  });

  it("includes B3 safety guidance for planner and skeptic", () => {
    expect(harnessScenarioRoleCard("B3", "planner")).toContain("Refuse");
    expect(harnessScenarioRoleCard("B3", "skeptic")).toContain("BLOCKER");
  });

  it("builds repair message with paths, enums, and full-regeneration instruction", () => {
    const message = buildStructuredRepairUserMessage("tasks[0].dependencies: Invalid reference", {
      role: "planner",
      issuePaths: ["tasks.0.dependencies"],
      allowedTaskIds: ["T1", "T2"],
    });

    expect(message).toContain("Failed schema paths: tasks.0.dependencies");
    expect(message).toContain("Allowed task ids for dependencies and gates: T1, T2");
    expect(message).toContain("Allowed values for riskLevel:");
    expect(message).toContain("exactly one repair attempt");
    expect(message).toContain("FULL JSON object");
  });

  it("keeps shared habit and planner cards compact and schema-neutral", () => {
    expect(STRICT_JSON_OUTPUT_HABITS).toContain("No markdown");
    expect(PLANNER_STRICT_JSON_CARD).toContain("task id");
    expect(STRICT_JSON_OUTPUT_HABITS.length).toBeLessThan(900);
  });
});