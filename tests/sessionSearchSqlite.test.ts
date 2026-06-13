import { afterEach, describe, expect, it } from "vitest";
import {
  SqlRectorStore,
  createSqliteDriver,
  searchSessions,
  type SqlDriver,
} from "../src/store";

function clock(): () => string {
  let tick = 0;
  const base = Date.parse("2026-06-13T01:00:00.000Z");
  return () => new Date(base + tick++ * 1000).toISOString();
}

describe("SqlRectorStore session search", () => {
  const openDrivers = new Set<SqlDriver>();

  function makeStore(): { driver: SqlDriver; store: SqlRectorStore } {
    const driver = createSqliteDriver({ path: ":memory:" });
    openDrivers.add(driver);
    return { driver, store: new SqlRectorStore({ driver, now: clock() }) };
  }

  afterEach(() => {
    for (const driver of openDrivers) {
      try {
        driver.close();
      } catch {
        /* already closed */
      }
    }
    openDrivers.clear();
  });

  it("finds a keyword through SQLite FTS5", async () => {
    const { store } = makeStore();
    const conversation = await store.createConversation({
      title: "FTS session",
      workspaceId: "ws-sql",
      retentionPolicy: "session",
    });
    await store.createMessage({
      conversationId: conversation.id,
      role: "user",
      content: "Track the basalt migration behavior",
      status: "complete",
      redactionState: "none",
    });

    const hits = await searchSessions(store, { query: "basalt", workspaceId: "ws-sql" });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.conversationId).toBe(conversation.id);
    expect(hits[0]?.snippet).toContain("basalt");
  });

  it("redacts secrets before FTS indexing and does not match raw secret substrings", async () => {
    const { driver, store } = makeStore();
    const conversation = await store.createConversation({
      title: "Secret search",
      workspaceId: "ws-secret",
      retentionPolicy: "session",
    });
    await store.createMessage({
      conversationId: conversation.id,
      role: "user",
      content: "Store token=sk-hidden-needle before indexing",
      status: "complete",
      redactionState: "none",
    });

    const rawSecretHits = await searchSessions(store, {
      query: "sk-hidden-needle",
      workspaceId: "ws-secret",
    });
    const tokenHits = await searchSessions(store, { query: "token", workspaceId: "ws-secret" });
    const indexed = driver.all<{ content: string }>("SELECT content FROM messages_fts");

    expect(rawSecretHits).toEqual([]);
    expect(tokenHits).toHaveLength(1);
    expect(indexed.map((row) => row.content).join("\n")).not.toContain("sk-hidden-needle");
    expect(indexed.map((row) => row.content).join("\n")).toContain("[REDACTED]");
  });

  it("isolates FTS search by workspace", async () => {
    const { store } = makeStore();
    const alpha = await store.createConversation({
      title: "Alpha",
      workspaceId: "ws-alpha",
      retentionPolicy: "session",
    });
    const beta = await store.createConversation({
      title: "Beta",
      workspaceId: "ws-beta",
      retentionPolicy: "session",
    });
    for (const conversation of [alpha, beta]) {
      await store.createMessage({
        conversationId: conversation.id,
        role: "user",
        content: "Shared citrine keyword",
        status: "complete",
        redactionState: "none",
      });
    }

    const hits = await searchSessions(store, { query: "citrine", workspaceId: "ws-alpha" });

    expect(hits.map((hit) => hit.conversationId)).toEqual([alpha.id]);
  });

  it("updates the FTS index when a message changes", async () => {
    const { store } = makeStore();
    const conversation = await store.createConversation({
      title: "Update",
      workspaceId: "ws-update",
      retentionPolicy: "session",
    });
    const message = await store.createMessage({
      conversationId: conversation.id,
      role: "user",
      content: "Initial amber term",
      status: "complete",
      redactionState: "none",
    });

    expect(await searchSessions(store, { query: "amber", workspaceId: "ws-update" })).toHaveLength(1);

    await store.updateMessage(message.id, { content: "Replacement cobalt term" });

    expect(await searchSessions(store, { query: "amber", workspaceId: "ws-update" })).toEqual([]);
    expect(await searchSessions(store, { query: "cobalt", workspaceId: "ws-update" })).toHaveLength(1);
  });
});
