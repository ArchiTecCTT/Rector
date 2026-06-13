import { describe, expect, it } from "vitest";

import {
  compressContextLineage,
  evaluateContextPressure,
  summarizeDeterministic,
} from "../src/orchestration/contextCompression";
import { buildContextPack, createContextMaterial } from "../src/orchestration/contextBuilder";
import { triageUserMessage } from "../src/orchestration/triage";
import { InMemoryRectorStore } from "../src/store/inMemoryRectorStore";

const NOW = "2026-01-01T00:00:00.000Z";

async function compressionFixture() {
  const store = new InMemoryRectorStore({ now: () => NOW });
  const conversation = await store.createConversation({
    title: "compression fixture",
    workspaceId: "local",
    retentionPolicy: "session",
  });
  const userMessage = await store.createMessage({
    conversationId: conversation.id,
    role: "user",
    content: "Summarize the current context.",
    status: "created",
    redactionState: "none",
  });
  await store.createMessage({
    conversationId: conversation.id,
    role: "assistant",
    content: "Previous answer with token=sk-context-compression-secret-0123456789",
    status: "completed",
    redactionState: "none",
  });
  const triage = triageUserMessage(userMessage.content);
  const material = await createContextMaterial(store, {
    kind: "large-context",
    content: `${"important context ".repeat(80)} secret=sk-context-compression-secret-0123456789`,
    thresholdBytes: 10_000,
  });
  const contextPack = await buildContextPack(store, {
    conversation,
    messages: await store.listMessages(conversation.id),
    userMessage,
    triage,
    materials: [material],
    contextBudget: { tierBudget: { maxContextChars: 200 } },
  });
  const run = await store.createRun({
    conversationId: conversation.id,
    userMessageId: userMessage.id,
    status: "running",
    phase: "CONTEXT_BUILDING",
    route: triage.route,
    complexity: triage.complexity,
    budget: {
      maxUsd: 1,
      maxInputTokens: 100_000,
      maxOutputTokens: 20_000,
      maxModelCalls: 4,
      maxRuntimeMs: 60_000,
      maxHealingAttempts: 2,
      allowedProviders: [],
      approvalRequiredAboveUsd: 0,
    },
    costEstimate: { usd: 0 },
    tokenEstimate: { input: 0, output: 0 },
    traceId: "trace-compression",
    attempts: 1,
    healingAttempts: 0,
    validationAttempts: 0,
  });

  return { store, conversation, run, contextPack };
}

describe("context compression", () => {
  it("produces deterministic redacted summaries", () => {
    const messages = [
      {
        role: "user",
        content: "Authorization: Bearer sk-compression-summary-secret-0123456789",
        createdAt: NOW,
      },
    ];

    const first = summarizeDeterministic(messages, []);
    const second = summarizeDeterministic(messages, []);

    expect(first).toBe(second);
    expect(first).not.toContain("sk-compression-summary-secret-0123456789");
  });

  it("detects context pressure against the tier budget", async () => {
    const { contextPack } = await compressionFixture();
    const pressure = evaluateContextPressure(contextPack, { maxContextChars: 200 });

    expect(pressure.tier).toBe("context");
    expect(pressure.exceeded).toBe(true);
    expect(pressure.overByChars).toBeGreaterThan(0);
  });

  it("forks a child conversation and preserves parent messages", async () => {
    const { store, conversation, run, contextPack } = await compressionFixture();
    const parentMessagesBefore = await store.listMessages(conversation.id);

    const result = await compressContextLineage({
      conversationId: conversation.id,
      runId: run.id,
      contextPack,
      store,
      now: () => NOW,
      tierBudget: { maxContextChars: 200 },
    });

    const child = await store.getConversation(result.childConversationId);
    const artifact = await store.getArtifact(result.summaryArtifactId);
    const parentMessagesAfter = await store.listMessages(conversation.id);
    const childMessages = await store.listMessages(result.childConversationId);
    const events = await store.listEvents(run.id);

    expect(child).toMatchObject({
      parentConversationId: conversation.id,
      compressionGeneration: 1,
      compressionSummaryArtifactId: result.summaryArtifactId,
    });
    expect(artifact?.kind).toBe("CONTEXT_SUMMARY");
    expect(parentMessagesAfter).toHaveLength(parentMessagesBefore.length);
    expect(childMessages.length).toBeGreaterThan(0);
    expect(JSON.stringify(childMessages)).not.toContain("sk-context-compression-secret-0123456789");
    expect(result.newContextPack.conversationRef.id).toBe(result.childConversationId);
    expect(events.some((event) => event.type === "CONTEXT_COMPRESSED")).toBe(true);
  });
});
