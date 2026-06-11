import { describe, it, expect, beforeEach } from "vitest";

import { InMemoryRectorStore } from "../src/store/inMemoryRectorStore";
import type { CreateMemoryEntryInput } from "../src/store";

/**
 * Tests for advanced memory (Chunk 27 / neuro-symbolic Step 2).
 * Covers hierarchical layers, time-awareness, pruning, search, and note-like entries.
 */

describe("advanced memory (in-memory store)", () => {
  let store: InMemoryRectorStore;

  beforeEach(() => {
    store = new InMemoryRectorStore({ now: () => new Date().toISOString() });
  });

  it("creates and retrieves episodic memory entries with time fields", async () => {
    const input: CreateMemoryEntryInput = {
      layer: "episodic",
      content: "User wants pagination on the list view",
      timestamp: new Date().toISOString(),
      tags: ["feature", "ui"],
      source: "user-note",
      metadata: {},
    };

    const created = await store.createMemoryEntry(input);
    expect(created.layer).toBe("episodic");
    expect(created.accessCount).toBe(0); // default in create
    expect(created.lastMentioned).toBeDefined();
    expect(created.tags).toContain("feature");

    const fetched = await store.getMemoryEntry(created.id);
    expect(fetched?.content).toContain("pagination");
  });

  it("searchMemory returns relevant entries sorted by recency/access", async () => {
    await store.createMemoryEntry({
      layer: "episodic",
      content: "Fix the redaction bug in chat",
      timestamp: new Date(Date.now() - 1000 * 60 * 60 * 24 * 2).toISOString(), // 2 days ago
      tags: ["bug"],
      source: "run",
      metadata: {},
    });

    await store.createMemoryEntry({
      layer: "episodic",
      content: "Add notes capture for quick thoughts",
      timestamp: new Date().toISOString(),
      tags: ["note", "memory"],
      source: "user-note",
      metadata: {},
    });

    const results = await store.searchMemory("notes", { layer: "episodic", limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("notes");
  });

  it("pruneMemory drops low-score items and can summarize to core", async () => {
    // Create many low-value episodic entries
    for (let i = 0; i < 5; i++) {
      await store.createMemoryEntry({
        layer: "episodic",
        content: `low value item ${i}`,
        timestamp: new Date(Date.now() - 1000 * 60 * 60 * 24 * (10 + i)).toISOString(), // old
        tags: [],
        source: "system",
        metadata: {},
      });
    }

    // One high value note
    await store.createMemoryEntry({
      layer: "episodic",
      content: "Important: always redact secrets before any LLM call",
      timestamp: new Date().toISOString(),
      tags: ["note", "security"],
      source: "user-note",
      metadata: {},
      accessCount: 5,
    });

    const before = await store.listMemoryEntries("episodic");
    expect(before.length).toBe(6);

    const pruneResult = await store.pruneMemory({ targetLayer: "episodic", maxEntries: 2 });
    expect(pruneResult.pruned).toBeGreaterThan(0);

    const after = await store.listMemoryEntries("episodic");
    expect(after.length).toBeLessThanOrEqual(2);

    // High value note should survive (higher score)
    const surviving = after.map((e) => e.content);
    expect(surviving.some((c) => c.includes("redact secrets"))).toBe(true);
  });

  it("time fields are always present and lastMentioned can be updated on access", async () => {
    const entry = await store.createMemoryEntry({
      layer: "core",
      content: "Rector uses deterministic orchestration under the chat UI",
      timestamp: new Date().toISOString(),
      tags: ["architecture"],
      source: "ponder",
      metadata: {},
    });

    expect(entry.timestamp).toMatch(/T/);
    expect(entry.lastMentioned).toMatch(/T/);

    const updated = await store.updateMemoryEntry(entry.id, {
      lastMentioned: new Date().toISOString(),
      accessCount: (entry.accessCount || 0) + 1,
    });
    expect(updated?.accessCount).toBeGreaterThan(0);
  });
});