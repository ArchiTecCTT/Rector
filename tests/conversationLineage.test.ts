import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { InMemoryRectorStore } from "../src/store";

function clock(): () => string {
  let tick = 0;
  const base = Date.parse("2026-06-13T02:00:00.000Z");
  return () => new Date(base + tick++ * 1000).toISOString();
}

describe("conversation lineage", () => {
  it("returns the parent-child chain ordered from root to current", async () => {
    const store = new InMemoryRectorStore({ now: clock() });
    const root = await store.createConversation({
      title: "Root",
      workspaceId: "ws-lineage",
      retentionPolicy: "session",
    });
    const child = await store.createConversation({
      title: "Child",
      workspaceId: "ws-lineage",
      parentConversationId: root.id,
      compressionGeneration: 1,
      retentionPolicy: "session",
    });
    const grandchild = await store.createConversation({
      title: "Grandchild",
      workspaceId: "ws-lineage",
      parentConversationId: child.id,
      compressionGeneration: 2,
      retentionPolicy: "session",
    });

    const lineage = await store.getConversationLineage(grandchild.id);

    expect(lineage.map((conversation) => conversation.id)).toEqual([root.id, child.id, grandchild.id]);
  });

  it("rejects lineage cycles on update", async () => {
    const store = new InMemoryRectorStore({ now: clock() });
    const root = await store.createConversation({
      title: "Root",
      workspaceId: "ws-cycle",
      retentionPolicy: "session",
    });
    const child = await store.createConversation({
      title: "Child",
      workspaceId: "ws-cycle",
      parentConversationId: root.id,
      compressionGeneration: 1,
      retentionPolicy: "session",
    });

    await expect(store.updateConversation(root.id, { parentConversationId: child.id })).rejects.toThrow(/cycle/i);
  });

  it("rejects chains deeper than the lineage guard", async () => {
    const store = new InMemoryRectorStore({ now: clock() });
    let parent = await store.createConversation({
      title: "Root",
      workspaceId: "ws-depth",
      retentionPolicy: "session",
    });
    for (let generation = 1; generation < 10; generation += 1) {
      parent = await store.createConversation({
        title: `Gen ${generation}`,
        workspaceId: "ws-depth",
        parentConversationId: parent.id,
        compressionGeneration: generation,
        retentionPolicy: "session",
      });
    }

    await expect(
      store.createConversation({
        title: "Too deep",
        workspaceId: "ws-depth",
        parentConversationId: parent.id,
        compressionGeneration: 10,
        retentionPolicy: "session",
      }),
    ).rejects.toThrow(/maximum depth/i);
  });

  it("property: acyclic parent assignments walk without duplicate conversations", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: -1, max: 7 }), { minLength: 1, maxLength: 8 }),
        async (parentChoices) => {
          const store = new InMemoryRectorStore({ now: clock() });
          const ids: string[] = [];

          for (let i = 0; i < parentChoices.length; i += 1) {
            const parentIndex = parentChoices[i] >= 0 && parentChoices[i] < i ? parentChoices[i] : undefined;
            const conversation = await store.createConversation({
              title: `Node ${i}`,
              workspaceId: "ws-property",
              parentConversationId: parentIndex === undefined ? undefined : ids[parentIndex],
              compressionGeneration: parentIndex === undefined ? 0 : 1,
              retentionPolicy: "session",
            });
            ids.push(conversation.id);
          }

          for (const id of ids) {
            const lineage = await store.getConversationLineage(id);
            const lineageIds = lineage.map((conversation) => conversation.id);
            expect(new Set(lineageIds).size).toBe(lineageIds.length);
            expect(lineageIds.at(-1)).toBe(id);
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});
