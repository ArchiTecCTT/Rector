import { describe, expect, it, vi } from "vitest";
import {
  AlgoliaSearchAdapter,
  ChromaMemoryAdapter,
  CitationSchema,
  InMemoryTruthLibrary,
  ProvenanceSchema,
  TruthItemSchema,
  TruthStatus,
} from "../src/memory";
import { buildContextPack } from "../src/orchestration/contextBuilder";
import { triageUserMessage } from "../src/orchestration/triage";
import { InMemoryRectorStore } from "../src/store/inMemoryRectorStore";

describe("truth library schemas", () => {
  it("validates truth statuses, provenance, and citations", () => {
    expect(TruthStatus.options).toEqual(["TRUSTED", "UNVERIFIED", "REJECTED"]);

    const provenance = ProvenanceSchema.parse({
      source: "architecture-doc",
      sourceType: "file",
      actor: "worker",
      observedAt: "2026-01-01T00:00:00.000Z",
      citations: [
        {
          title: "Architecture",
          uri: "file://docs/architecture.md",
          quote: "Local first",
        },
      ],
    });

    expect(provenance.citations).toHaveLength(1);
    expect(() =>
      TruthItemSchema.parse({
        id: "bad-status",
        title: "Bad",
        content: "Bad content",
        status: "MAYBE",
        provenance,
      })
    ).toThrow();
  });

  it("CitationSchema rejects empty citation object", () => {
    // Empty citation should throw
    expect(() => CitationSchema.parse({})).toThrow();

    // Citation with only retrievedAt should throw
    expect(() => CitationSchema.parse({ retrievedAt: "2026-01-01T00:00:00.000Z" })).toThrow();

    // Citation with at least one required field should pass
    const valid = CitationSchema.parse({ title: "Valid" });
    expect(valid.title).toBe("Valid");
  });
});

describe("in-memory truth library", () => {
  it("upserts, filters, and scores deterministic keyword search", () => {
    const library = new InMemoryTruthLibrary({ now: () => "2026-01-01T00:00:00.000Z" });

    library.upsert({
      id: "trusted-plan",
      kind: "doc",
      title: "Rector planner architecture",
      content: "The planner compiles safe local DAG tasks with validation evidence.",
      status: "TRUSTED",
      provenance: { source: "docs/architecture.md", sourceType: "file" },
      tags: ["planner", "architecture"],
    });
    library.upsert({
      id: "unverified-note",
      kind: "memory",
      title: "Planner brainstorm",
      content: "Maybe use speculative planner memories later.",
      status: "UNVERIFIED",
      provenance: { source: "chat", sourceType: "user" },
      tags: ["planner"],
    });
    library.upsert({
      id: "rejected-note",
      kind: "memory",
      title: "Rejected planner claim",
      content: "The planner already makes live provider calls.",
      status: "REJECTED",
      provenance: { source: "stale-doc", sourceType: "file" },
      tags: ["planner", "stale"],
    });

    const results = library.search({ query: "planner architecture", tags: ["planner"] });

    expect(results.map((result) => result.item.id)).toEqual(["trusted-plan", "unverified-note"]);
    expect(results[0].score).toBeGreaterThan(results[1].score);
    expect(results[0].matchedTerms).toEqual(["architecture", "planner"]);

    expect(library.search({ query: "planner", statuses: ["TRUSTED"] }).map((result) => result.item.id)).toEqual([
      "trusted-plan",
    ]);
    expect(
      library.search({ query: "planner", provenanceSources: ["chat"] }).map((result) => result.item.id)
    ).toEqual(["unverified-note"]);
    expect(library.search({ query: "provider calls" }).map((result) => result.item.id)).not.toContain(
      "rejected-note"
    );
    expect(library.search({ query: "provider calls", includeRejected: true }).map((result) => result.item.id)).toEqual([
      "rejected-note",
    ]);
  });

  it("upsert update preserves createdAt and refreshes updatedAt", () => {
    let mockTime = "2026-01-01T00:00:00.000Z";
    const library = new InMemoryTruthLibrary({ now: () => mockTime });

    // Initial upsert
    const initial = library.upsert({
      id: "time-test",
      kind: "doc",
      title: "Initial title",
      content: "Initial content",
      status: "TRUSTED",
      provenance: { source: "test", sourceType: "system" },
    });

    expect(initial.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(initial.updatedAt).toBe("2026-01-01T00:00:00.000Z");

    // Advance time
    mockTime = "2026-01-02T12:00:00.000Z";

    // Update upsert
    const updated = library.upsert({
      id: "time-test",
      kind: "doc",
      title: "Updated title",
      content: "Initial content",
      status: "TRUSTED",
      provenance: { source: "test", sourceType: "system" },
    });

    expect(updated.createdAt).toBe("2026-01-01T00:00:00.000Z"); // preserved!
    expect(updated.updatedAt).toBe("2026-01-02T12:00:00.000Z"); // refreshed!
  });

  it("provides get, list, and filter direct methods", () => {
    const library = new InMemoryTruthLibrary({ now: () => "2026-01-01T00:00:00.000Z" });

    library.upsert({
      id: "item-1",
      kind: "doc",
      title: "Title 1",
      content: "Content 1",
      status: "TRUSTED",
      provenance: { source: "test", sourceType: "system" },
      tags: ["tag-a"],
    });

    library.upsert({
      id: "item-2",
      kind: "memory",
      title: "Title 2",
      content: "Content 2",
      status: "UNVERIFIED",
      provenance: { source: "test", sourceType: "system" },
      tags: ["tag-b"],
    });

    // Test get()
    const item1 = library.get("item-1");
    expect(item1).toBeDefined();
    expect(item1?.title).toBe("Title 1");

    const nonExistent = library.get("non-existent");
    expect(nonExistent).toBeUndefined();

    // Test list() - should return all items, sorted by compareTruthItems
    const allItems = library.list();
    expect(allItems).toHaveLength(2);
    // Since compareTruthItems sorts by updatedAt descending, then by id ascending:
    // Both have same updatedAt ("2026-01-01T00:00:00.000Z").
    // Sorting by id ascending: item-1, item-2.
    expect(allItems[0].id).toBe("item-1");
    expect(allItems[1].id).toBe("item-2");

    // Let's modify item-1 updatedAt to be later
    library.upsert({
      id: "item-1",
      kind: "doc",
      title: "Title 1",
      content: "Content 1",
      status: "TRUSTED",
      provenance: { source: "test", sourceType: "system" },
      tags: ["tag-a"],
      updatedAt: "2026-01-02T00:00:00.000Z"
    });

    const allItemsUpdated = library.list();
    // item-1 now has a later updatedAt, so it should be first in descending order
    expect(allItemsUpdated[0].id).toBe("item-1");

    // Test filter()
    const filteredByTag = library.filter({ tags: ["tag-b"] });
    expect(filteredByTag).toHaveLength(1);
    expect(filteredByTag[0].id).toBe("item-2");

    const filteredByKind = library.filter({ kinds: ["doc"] });
    expect(filteredByKind).toHaveLength(1);
    expect(filteredByKind[0].id).toBe("item-1");
  });
});

describe("semantic memory/search adapter stubs", () => {
  it("do not make network calls", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network should not be used"));
    const chroma = new ChromaMemoryAdapter({ collectionName: "rector-test" });
    const algolia = new AlgoliaSearchAdapter({ indexName: "rector-test" });

    await expect(chroma.upsert([])).resolves.toEqual({ accepted: 0, skipped: 0, networkCalls: 0 });
    await expect(chroma.search({ query: "planner" })).resolves.toEqual([]);
    await expect(algolia.upsert([])).resolves.toEqual({ accepted: 0, skipped: 0, networkCalls: 0 });
    await expect(algolia.search({ query: "planner" })).resolves.toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });
});

describe("context builder local memory integration", () => {
  it("defaults to empty relevant memory/docs unless a local truth library is passed", async () => {
    const store = new InMemoryRectorStore({ now: () => "2026-01-01T00:00:00.000Z" });
    const conversation = await store.createConversation({
      title: "Memory",
      workspaceId: "local",
      retentionPolicy: "session",
    });
    const message = await store.createMessage({
      conversationId: conversation.id,
      role: "user",
      content: "Use planner architecture memory",
      status: "completed",
      redactionState: "none",
    });
    const triage = triageUserMessage(message.content);

    const defaultPack = await buildContextPack(store, {
      conversation,
      messages: [message],
      userMessage: message,
      triage,
    });

    expect(defaultPack.relevantMemory).toEqual([]);
    expect(defaultPack.relevantDocs).toEqual([]);

    const library = new InMemoryTruthLibrary({ now: () => "2026-01-01T00:00:00.000Z" });
    library.upsert({
      id: "memory-1",
      kind: "memory",
      title: "Planner memory",
      content: "Planner memory should be available to context builder.",
      status: "TRUSTED",
      provenance: { source: "chat", sourceType: "user" },
      tags: ["planner"],
    });
    library.upsert({
      id: "doc-1",
      kind: "doc",
      title: "Planner architecture document",
      content: "Planner architecture document should be available to context builder.",
      status: "TRUSTED",
      provenance: { source: "docs/architecture.md", sourceType: "file" },
      tags: ["planner", "architecture"],
    });
    library.upsert({
      id: "rejected-memory",
      kind: "memory",
      title: "Rejected planner memory",
      content: "Rejected planner memories must stay out of default context.",
      status: "REJECTED",
      provenance: { source: "stale-doc", sourceType: "file" },
      tags: ["planner"],
    });

    const pack = await buildContextPack(store, {
      conversation,
      messages: [message],
      userMessage: message,
      triage,
      truthLibrary: library,
      truthSearchLimit: 5,
    });

    expect(pack.relevantMemory.map((handle) => handle.artifactId)).toEqual(["memory-1"]);
    expect(pack.relevantDocs.map((handle) => handle.artifactId)).toEqual(["doc-1"]);
  });
});
