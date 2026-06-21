import { describe, expect, it } from "vitest";
import {
  compileAcceptedPlanToDag,
  type DagCompilerInput,
} from "../src/orchestration/dagCompiler";
import { type CrucibleDecision } from "../src/orchestration/crucible";
import { createFakePlan, type PlannerInput } from "../src/orchestration/planner";
import { triageUserMessage, type TriageResult } from "../src/orchestration/triage";
import type { ContextPack } from "../src/orchestration/contextBuilder";
import type { DagNode } from "../src/protocol/dag";

// Characterizes the createFakePlan -> accepted Crucible decision -> DAG compiler path.
// Destructive routing is driven by triage/planner keywords such as "delete", not by hand-built planner objects.
const NOW = "2026-01-01T00:00:00.000Z";

function contextPackFor(triage: TriageResult, intent = "Test user intent"): ContextPack {
  return {
    id: "ctx-dag-capability-test",
    createdAt: NOW,
    userIntentSummary: intent,
    conversationRef: { id: "conv-test", title: "DAG capability test", workspaceId: "local" },
    messageRefs: [
      {
        id: "msg-test",
        role: "user",
        status: "completed",
        createdAt: NOW,
      },
    ],
    relevantDocs: [],
    relevantMemory: [],
    constraints: ["No provider calls in DAG compiler capability tests"],
    availableProviders: { configured: [], unavailable: [], notes: [] },
    availableTools: { names: [], notes: [] },
    riskFlags: triage.riskFlags,
    triage,
    artifactHandles: [],
    inlineContext: [
      {
        kind: "chat-user-message",
        summary: intent,
        content: intent,
        hash: "hash-test",
        sizeBytes: intent.length,
      },
    ],
  };
}

function inputFor(content: string): PlannerInput {
  const triage = triageUserMessage(content);
  return {
    triage,
    contextPack: contextPackFor(triage, content),
    messageContent: content,
  };
}

function acceptedDecisionFor(content: string): DagCompilerInput {
  const plan = createFakePlan(inputFor(content));
  const decision: CrucibleDecision = {
    verdict: "ACCEPTED",
    reason: "accepted for DAG compiler capability test",
    acceptedPlan: plan,
    blockerFindings: [],
    round: 1,
    maxRounds: 2,
    createdAt: NOW,
  };

  return { runId: "run-dag-capability-test", crucibleDecision: decision, now: () => NOW };
}

function fileOperationNodeFor(content: string): DagNode {
  const dag = compileAcceptedPlanToDag(acceptedDecisionFor(content));
  const fileOperationNode = dag.nodes.find(
    (node) => node.type === "FILE_OPERATION" && node.metadata?.plannerTaskId === "code.edit"
  );

  if (!fileOperationNode) {
    throw new Error("Expected createFakePlan CODE_EDIT output to compile code.edit as a FILE_OPERATION node");
  }

  return fileOperationNode;
}

describe("DAG compiler capability policy", () => {
  it("allows file writes for non-destructive code edit plans", () => {
    const fileOperationNode = fileOperationNodeFor("Fix the TypeScript bug in src/api/server.ts and update tests.");

    expect(fileOperationNode.metadata?.capabilityPolicy).toMatchObject({
      allowFileWrite: true,
      approvalRequired: false,
      default: "deny",
      allowShell: false,
      allowProposedPatch: true,
    });
  });

  it("denies file writes for destructive code edit plans that require approval", () => {
    const fileOperationNode = fileOperationNodeFor("Delete obsolete source files in src/cleanup.ts and update tests.");

    expect(fileOperationNode.metadata?.capabilityPolicy).toMatchObject({
      allowFileWrite: false,
      approvalRequired: true,
    });
  });
});
