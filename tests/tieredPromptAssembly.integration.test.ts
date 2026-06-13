import { describe, expect, it } from "vitest";

import { buildContextPack, createContextMaterial, type ContextPack } from "../src/orchestration/contextBuilder";
import { runChat, type ChatRunArgs } from "../src/orchestration/chatRunner";
import { PlannerOutputSchema } from "../src/orchestration/planner";
import { triageUserMessage } from "../src/orchestration/triage";
import { createInMemoryObservabilityTrace } from "../src/observability";
import type { ModelRouter, ModelSelection } from "../src/providers/llm";
import { InMemoryRectorStore } from "../src/store/inMemoryRectorStore";
import {
  DEFAULT_SPY_USAGE,
  SpyLLMProvider,
  planToJson,
  skepticDraftToJson,
  synthesisDraftToJson,
} from "./support/byokArbitraries";

const SPY_PLAN = PlannerOutputSchema.parse({
  goal: "Answer the user question from available conversation context",
  assumptions: ["User expects a concise synthesis, not changes."],
  tasks: [
    {
      id: "answer.synthesize",
      title: "Synthesize direct answer",
      description: "Use available conversation context to produce a concise response.",
      dependencies: [],
      expectedArtifacts: ["Assistant answer"],
      validation: ["Answer addresses the stated question"],
      risk: "low",
      approvalRequired: false,
    },
  ],
  dependencies: [],
  validation: { summary: "Direct answer plan stays non-executing", checks: ["Confirm response is grounded in context"] },
  riskLevel: "low",
  approvalGates: [],
});

async function buildTieredArgs(
  store: InMemoryRectorStore,
  prompt: string,
  options: { maxContextChars?: number; includePromptTiers?: boolean } = {},
): Promise<ChatRunArgs & { parentConversationId: string; contextPack: ContextPack }> {
  const conversation = await store.createConversation({
    title: "tiered prompt integration",
    workspaceId: "local",
    retentionPolicy: "session",
  });
  const userMessage = await store.createMessage({
    conversationId: conversation.id,
    role: "user",
    content: prompt,
    status: "created",
    redactionState: "none",
  });
  const triage = triageUserMessage(prompt);
  const material = await createContextMaterial(store, {
    kind: "large-context",
    content: "important context ".repeat(120),
    thresholdBytes: 10_000,
  });
  const contextPack = await buildContextPack(store, {
    conversation,
    messages: await store.listMessages(conversation.id),
    userMessage,
    triage,
    materials: [material],
    contextBudget: options.maxContextChars
      ? { tierBudget: { maxContextChars: options.maxContextChars } }
      : undefined,
    includePromptTiers: options.includePromptTiers,
  });

  return {
    parentConversationId: conversation.id,
    conversationId: conversation.id,
    userMessageId: userMessage.id,
    prompt,
    triage,
    contextPack,
    observability: createInMemoryObservabilityTrace({ provider: "spy" }),
  };
}

function scriptedRouter(provider: SpyLLMProvider): ModelRouter {
  return {
    select(): ModelSelection {
      return {
        provider,
        modelRoute: "flagship",
        model: provider.metadata.models.flagship,
        reason: "tiered prompt integration selects the scripted spy provider",
      };
    },
  };
}

function spyProvider(): SpyLLMProvider {
  return new SpyLLMProvider({
    estimate: DEFAULT_SPY_USAGE,
    onOverflow: "repeat-last",
    responses: [
      {
        content: JSON.stringify({
          distilledContext: "distilled context",
          proposedToolCalls: [],
          entities: [],
          intent: "Explain",
          constraints: [],
        }),
      },
      { content: planToJson(SPY_PLAN) },
      { content: skepticDraftToJson({ verdict: "SOUND", findings: [] }) },
      {
        content: synthesisDraftToJson({
          response: "Completed the tiered prompt run.",
          citations: [{ kind: "artifact", ref: "task:answer.synthesize", detail: "ok" }],
        }),
      },
    ],
  });
}

describe("tiered prompt assembly integration", () => {
  it("emits context budget events and sends tiered system prompts to the spy provider", async () => {
    const store = new InMemoryRectorStore();
    const provider = spyProvider();
    const args = await buildTieredArgs(store, "Explain Rector's configured orchestration.", {
      includePromptTiers: true,
    });

    const { run } = await runChat(store, args, { router: scriptedRouter(provider), sandboxConfigured: true });
    const events = await store.listEvents(run.id);
    const providerPayload = JSON.stringify(provider.requests);

    expect(args.contextPack.promptTiers?.stableHash).toMatch(/^[a-f0-9]{64}$/);
    expect(events.some((event) => event.type === "CONTEXT_BUDGET_EVALUATED")).toBe(true);
    expect(providerPayload).toContain("[stable tier]");
    expect(providerPayload).toContain("[context tier]");
    expect(providerPayload).toContain("[volatile tier]");
  });

  it("forks a child conversation when the context tier exceeds budget", async () => {
    const store = new InMemoryRectorStore();
    const provider = spyProvider();
    const args = await buildTieredArgs(store, "Explain Rector's configured orchestration.", {
      maxContextChars: 200,
    });

    const { run } = await runChat(store, args, { router: scriptedRouter(provider), sandboxConfigured: true });
    const child = await store.getConversation(run.conversationId);
    const events = await store.listEvents(run.id);

    expect(args.contextPack.compressionRecommended).toBe(true);
    expect(run.conversationId).not.toBe(args.parentConversationId);
    expect(run.contextCompressionApplied).toBe(true);
    expect(child?.parentConversationId).toBe(args.parentConversationId);
    expect(child?.compressionGeneration).toBe(1);
    expect(events.some((event) => event.type === "CONTEXT_COMPRESSED")).toBe(true);
  });
});
