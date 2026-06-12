import { describe, expect, it } from "vitest";
import { buildContextPack, createContextMaterial, type ContextMaterial } from "../src/orchestration/contextBuilder";
import { triageUserMessage } from "../src/orchestration/triage";
import { InMemoryRectorStore } from "../src/store/inMemoryRectorStore";
import type { MemoryEntry } from "../src/store";

const NOW = "2026-06-12T00:00:00.000Z";

async function harness(prompt = "Use alpha memory") {
  const store = new InMemoryRectorStore({ now: () => NOW });
  const conversation = await store.createConversation({
    title: "Context hardening",
    workspaceId: "local",
    retentionPolicy: "session",
  });
  const message = await store.createMessage({
    conversationId: conversation.id,
    role: "user",
    content: prompt,
    status: "completed",
    redactionState: "none",
  });
  return { store, conversation, message, triage: triageUserMessage(prompt) };
}

function memory(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: "mem-default",
    layer: "episodic",
    content: "default memory",
    timestamp: "2026-06-01T00:00:00.000Z",
    lastMentioned: "2026-06-01T00:00:00.000Z",
    accessCount: 0,
    tags: [],
    source: "system",
    metadata: {},
    ...overrides,
  };
}

describe("context builder hardening", () => {
  it("externalizes over-budget inline context into artifact handles", async () => {
    const { store, conversation, message, triage } = await harness("Summarize context");
    const material = await createContextMaterial(store, {
      kind: "large-inline",
      content: "safe content ".repeat(50),
      thresholdBytes: 10_000,
    });

    const pack = await buildContextPack(store, {
      conversation,
      messages: [message],
      userMessage: message,
      triage,
      materials: [material],
      contextBudget: { maxInlineChars: 40, maxArtifactHandles: 2 },
      now: () => NOW,
    });

    expect(pack.inlineContext).toHaveLength(0);
    expect(pack.artifactHandles).toHaveLength(1);
    expect(pack.artifactHandles[0].summary).toContain("safe content");
    expect(JSON.stringify(pack)).not.toContain("safe content ".repeat(30));
  });

  it("caps artifact handles and provider/tool notes deterministically", async () => {
    const { store, conversation, message, triage } = await harness("Need capped context");
    const materials: ContextMaterial[] = [];
    for (const id of ["one", "two", "three"]) {
      materials.push({
        artifactHandle: {
          artifactId: id,
          kind: "test",
          uri: `memory://artifact/${id}`,
          summary: id,
          hash: id,
          sizeBytes: 1,
          piiState: "unknown",
          retentionPolicy: "session",
        },
      });
    }

    const pack = await buildContextPack(store, {
      conversation,
      messages: [message],
      userMessage: message,
      triage,
      materials,
      providerInfo: { configured: ["b"], unavailable: ["a"], notes: ["n1", "n2", "n3"] },
      toolInfo: { names: ["z"], notes: ["t1", "t2"] },
      contextBudget: { maxArtifactHandles: 2, maxProviderNotes: 1, maxToolNotes: 1 },
      now: () => NOW,
    });

    expect(pack.artifactHandles.map((handle) => handle.artifactId)).toEqual(["one", "two"]);
    expect(pack.availableProviders.notes).toEqual(["n1"]);
    expect(pack.availableTools.notes).toEqual(["t1"]);
  });

  it("ranks memory deterministically with the injected clock and max memory cap", async () => {
    const { store, conversation, message, triage } = await harness("alpha decision");
    const pack = await buildContextPack(store, {
      conversation,
      messages: [message],
      userMessage: message,
      triage,
      memoryEntries: [
        memory({ id: "old-alpha", content: "alpha stale note", timestamp: "2024-01-01T00:00:00.000Z", lastMentioned: "2024-01-01T00:00:00.000Z", tags: ["stale"] }),
        memory({ id: "recent-alpha", content: "alpha current note", timestamp: "2026-06-12T00:00:00.000Z", lastMentioned: "2026-06-12T00:00:00.000Z", accessCount: 3, source: "user-note", tags: ["note"] }),
        memory({ id: "other", content: "unrelated", timestamp: "2026-06-12T00:00:00.000Z", lastMentioned: "2026-06-12T00:00:00.000Z" }),
      ],
      contextBudget: { maxMemoryEntries: 1 },
      now: () => NOW,
    });

    expect(pack.memoryContext).toHaveLength(1);
    expect(pack.memoryContext?.[0]).toContain("recently you noted: alpha current note");
  });

  it("redacts inline context before it enters the context pack", async () => {
    const { store, conversation, message, triage } = await harness("Use attached secret-free context");
    const material = await createContextMaterial(store, {
      kind: "secret-inline",
      content: "token=supersecret-value should not leak",
      thresholdBytes: 10_000,
    });

    const pack = await buildContextPack(store, {
      conversation,
      messages: [message],
      userMessage: message,
      triage,
      materials: [material],
      now: () => NOW,
    });

    expect(pack.inlineContext[0].content).toContain("token=[REDACTED]");
    expect(JSON.stringify(pack)).not.toContain("supersecret-value");
  });
});
