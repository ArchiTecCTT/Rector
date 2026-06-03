import { describe, it, expect } from "vitest";
import { buildContextPack, createContextMaterial } from "../src/orchestration/contextBuilder";
import { triageUserMessage, TRIAGE_ROUTES } from "../src/orchestration/triage";
import { InMemoryRectorStore } from "../src/store/inMemoryRectorStore";

describe("triage heuristic baseline", () => {
  it("routes simple direct answers", () => {
    const result = triageUserMessage("What is Rector?");
    expect(result.route).toBe(TRIAGE_ROUTES.DIRECT_ANSWER);
    expect(result.complexity).toBe("low");
    expect(result.confidence).toBeGreaterThan(0.5);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("routes plan-only requests", () => {
    const result = triageUserMessage("Create an implementation plan for adding login, but do not edit files.");
    expect(result.route).toBe(TRIAGE_ROUTES.PLAN_ONLY);
    expect(result.reasons).toContain("planning intent detected");
  });

  it("routes code-edit requests", () => {
    const result = triageUserMessage("Fix the TypeScript bug in src/api/server.ts and update tests.");
    expect(result.route).toBe(TRIAGE_ROUTES.CODE_EDIT);
    expect(result.riskFlags).toContain("code_change");
  });

  it("routes research requests", () => {
    const result = triageUserMessage("Research current options for vector databases and compare sources.");
    expect(result.route).toBe(TRIAGE_ROUTES.RESEARCH);
    expect(result.riskFlags).toContain("external_research");
  });

  it("routes long-running requests", () => {
    const result = triageUserMessage("Build the entire feature end-to-end, run all tests, benchmark, iterate, and deploy.");
    expect(result.route).toBe(TRIAGE_ROUTES.LONG_RUNNING);
    expect(result.complexity).toBe("high");
    expect(result.riskFlags).toContain("long_running");
  });

  it("routes unclear requests to clarification", () => {
    const result = triageUserMessage("Can you do the thing?");
    expect(result.route).toBe(TRIAGE_ROUTES.NEEDS_CLARIFICATION);
    expect(result.riskFlags).toContain("ambiguous_request");
  });
});

describe("context pack builder", () => {
  it("stores oversized context as artifact handles without raw oversized content", async () => {
    const store = new InMemoryRectorStore({ now: () => "2026-01-01T00:00:00.000Z" });
    const conversation = await store.createConversation({
      title: "Artifacts",
      workspaceId: "local",
      retentionPolicy: "session",
    });
    const message = await store.createMessage({
      conversationId: conversation.id,
      role: "user",
      content: "Please summarize attached content",
      status: "completed",
      redactionState: "none",
    });
    const largeContent = "x".repeat(128);

    const material = await createContextMaterial(store, {
      kind: "test-large-content",
      content: largeContent,
      summary: "large test payload",
      thresholdBytes: 32,
      retentionPolicy: "session",
      piiState: "unknown",
    });

    expect(material.inlineContent).toBeUndefined();
    expect(material.artifactHandle).toBeDefined();
    expect(material.artifactHandle?.sizeBytes).toBe(128);
    expect(await store.getArtifact(material.artifactHandle!.artifactId)).toBeDefined();

    const triage = triageUserMessage(message.content);
    const pack = await buildContextPack(store, {
      conversation,
      messages: [message],
      userMessage: message,
      triage,
      materials: [material],
    });

    const serialized = JSON.stringify(pack);
    expect(pack.artifactHandles).toHaveLength(1);
    expect(pack.inlineContext).toHaveLength(0);
    expect(serialized).not.toContain(largeContent);
  });
});
