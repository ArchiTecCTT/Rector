import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  InMemoryRectorStore,
  buildSessionSnippet,
  searchSessions,
} from "../src/store";

function clock(): () => string {
  let tick = 0;
  const base = Date.parse("2026-06-13T00:00:00.000Z");
  return () => new Date(base + tick++ * 1000).toISOString();
}

describe("InMemoryRectorStore session search", () => {
  it("finds messages with the keyword fallback", async () => {
    const store = new InMemoryRectorStore({ now: clock() });
    const conversation = await store.createConversation({
      title: "Searchable session",
      workspaceId: "ws-search",
      retentionPolicy: "session",
    });
    await store.createMessage({
      conversationId: conversation.id,
      role: "user",
      content: "Investigate the phoenix retry path",
      status: "complete",
      redactionState: "none",
    });

    const hits = await searchSessions(store, { query: "phoenix", workspaceId: "ws-search" });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.conversationId).toBe(conversation.id);
    expect(hits[0]?.snippet).toContain("phoenix");
  });

  it("returns an empty recent list when the workspace has no conversations", async () => {
    const store = new InMemoryRectorStore({ now: clock() });

    await expect(searchSessions(store, { query: "", workspaceId: "missing" })).resolves.toEqual([]);
  });

  it("returns empty-query recents by most recent activity", async () => {
    const store = new InMemoryRectorStore({ now: clock() });
    const older = await store.createConversation({
      title: "Older",
      workspaceId: "ws-recents",
      retentionPolicy: "session",
    });
    await store.createMessage({
      conversationId: older.id,
      role: "user",
      content: "Older activity",
      status: "complete",
      redactionState: "none",
    });
    const newer = await store.createConversation({
      title: "Newer",
      workspaceId: "ws-recents",
      retentionPolicy: "session",
    });

    const hits = await searchSessions(store, { query: "", workspaceId: "ws-recents" });

    expect(hits.map((hit) => hit.conversationId)).toEqual([newer.id, older.id]);
  });

  it("property: search snippets are capped at 300 characters", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 1000 }),
        fc.string({ maxLength: 1000 }),
        (prefix, suffix) => {
          const snippet = buildSessionSnippet(`${prefix} needle ${suffix}`, "needle");
          expect(snippet.length).toBeLessThanOrEqual(300);
        },
      ),
      { numRuns: 50 },
    );
  });
});
