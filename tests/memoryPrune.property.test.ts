import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { LocalMemoryProvider } from "../src/memory/provider";
import type { CreateMemoryEntryInput, MemoryEntry, MemoryLayer } from "../src/store";

/**
 * Chunk 036 Wave 1D — Prune survival invariant property tests.
 *
 * **Feature: chunk-036, Property: prune survival invariants**
 *
 * LocalMemoryProvider with an injected `now()` clock exercises the same prune scoring
 * semantics as the pre-034 in-memory baseline (recency + access + user-note bonus,
 * auto core summaries on high-access episodic prune). Properties assert:
 *
 * - maxEntries bound is respected after prune
 * - user-note entries survive over low-score episodic competitors
 * - high accessCount entries survive over low-score episodic competitors
 * - core summaries are created when accessCount > 2 episodic entries are pruned
 */

const OLD_TS = "2020-01-01T00:00:00.000Z";
const RECENT_TS = () => new Date(Date.now() - 60_000).toISOString();

function createProvider(): { provider: LocalMemoryProvider; now: () => string } {
  let tick = 0;
  const base = Date.parse("2026-06-01T12:00:00.000Z");
  const now = () => new Date(base + tick++ * 1000).toISOString();
  const provider = new LocalMemoryProvider({
    id: "mem-prune-prop",
    kind: "local-inmemory",
    now,
  });
  return { provider, now };
}

/** Mirrors LocalMemoryProvider.pruneMemory scoring for documentation and targeted checks. */
function pruneScore(entry: MemoryEntry, atMs = Date.now()): number {
  const ageMs = atMs - (Date.parse(entry.timestamp) || atMs);
  const recency = Math.max(0, 100 - Math.floor(ageMs / (1000 * 60 * 60 * 24)));
  const accessBonus = Math.min(entry.accessCount * 3, 50);
  const noteBonus = entry.source === "user-note" || entry.tags.includes("note") ? 30 : 0;
  return recency + accessBonus + noteBonus;
}

function lowScoreEpisodic(content: string, accessCount = 0): CreateMemoryEntryInput {
  return {
    layer: "episodic",
    content,
    timestamp: OLD_TS,
    tags: [],
    source: "system",
    metadata: {},
    accessCount,
  };
}

const episodicSeedArb = fc.record({
  content: fc.string({ minLength: 1, maxLength: 80 }),
  accessCount: fc.nat({ max: 2 }),
  source: fc.constantFrom("system", "run", "ponder"),
  timestamp: fc.constantFrom(OLD_TS, RECENT_TS()),
});

const layerArb = fc.constantFrom<MemoryLayer>("working", "episodic", "core");

describe("Feature: chunk-036, Property: prune survival invariants", () => {
  // Feature: chunk-036, Property: prune survival invariants
  it("respects maxEntries bound after prune across arbitrary episodic histories", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 25 }),
        fc.array(episodicSeedArb, { minLength: 0, maxLength: 40 }),
        async (maxEntries, seeds) => {
          const { provider } = createProvider();

          for (const seed of seeds) {
            await provider.createMemoryEntry({
              layer: "episodic",
              content: seed.content,
              timestamp: seed.timestamp,
              tags: [],
              source: seed.source,
              metadata: {},
              accessCount: seed.accessCount,
            });
          }

          await provider.pruneMemory({ targetLayer: "episodic", maxEntries });
          const episodic = await provider.listMemoryEntries("episodic");
          expect(episodic.length).toBeLessThanOrEqual(maxEntries);
        },
      ),
      { numRuns: 80 },
    );
  });

  // Feature: chunk-036, Property: prune survival invariants
  it("keeps user-note entries over low-score episodic competitors when forced to prune", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 20 }),
        fc.string({ minLength: 4, maxLength: 80 }),
        async (lowCount, noteContent) => {
          const { provider } = createProvider();

          const note = await provider.createMemoryEntry({
            layer: "episodic",
            content: noteContent,
            timestamp: OLD_TS,
            tags: [],
            source: "user-note",
            metadata: {},
            accessCount: 0,
          });

          for (let i = 0; i < lowCount; i++) {
            await provider.createMemoryEntry(lowScoreEpisodic(`low-${i}`));
          }

          const probeLow: MemoryEntry = {
            ...note,
            id: "probe-low",
            source: "system",
            accessCount: 0,
          };
          expect(pruneScore(note)).toBeGreaterThan(pruneScore(probeLow));

          await provider.pruneMemory({ targetLayer: "episodic", maxEntries: 1 });
          const surviving = await provider.listMemoryEntries("episodic");
          expect(surviving.some((entry) => entry.id === note.id)).toBe(true);
          expect(surviving[0]?.source).toBe("user-note");
        },
      ),
      { numRuns: 60 },
    );
  });

  // Feature: chunk-036, Property: prune survival invariants
  it("keeps high accessCount entries over low-score episodic competitors when forced to prune", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 20 }),
        fc.integer({ min: 3, max: 50 }),
        async (lowCount, accessCount) => {
          const { provider } = createProvider();

          const anchor = await provider.createMemoryEntry({
            layer: "episodic",
            content: "high-access anchor",
            timestamp: OLD_TS,
            tags: [],
            source: "run",
            metadata: {},
            accessCount,
          });

          for (let i = 0; i < lowCount; i++) {
            await provider.createMemoryEntry(lowScoreEpisodic(`low-${i}`));
          }

          const probeLow: MemoryEntry = {
            ...anchor,
            id: "probe-low",
            accessCount: 0,
          };
          expect(pruneScore(anchor)).toBeGreaterThan(pruneScore(probeLow));

          await provider.pruneMemory({ targetLayer: "episodic", maxEntries: 1 });
          const surviving = await provider.listMemoryEntries("episodic");
          expect(surviving.some((entry) => entry.id === anchor.id)).toBe(true);
          expect(surviving[0]?.accessCount).toBe(accessCount);
        },
      ),
      { numRuns: 60 },
    );
  });

  // Feature: chunk-036, Property: prune survival invariants
  it("creates core summaries when accessCount > 2 episodic entries are pruned", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 8 }),
        fc.integer({ min: 3, max: 12 }),
        async (prunableCount, accessCount) => {
          const { provider } = createProvider();

          const keeper = await provider.createMemoryEntry({
            layer: "episodic",
            content: "keeper",
            timestamp: RECENT_TS(),
            tags: ["note"],
            source: "user-note",
            metadata: {},
            accessCount: 10,
          });

          const prunableIds: string[] = [];
          for (let i = 0; i < prunableCount; i++) {
            const created = await provider.createMemoryEntry({
              layer: "episodic",
              content: `prunable-${i}-${accessCount}`,
              timestamp: OLD_TS,
              tags: [],
              source: "system",
              metadata: {},
              accessCount,
            });
            prunableIds.push(created.id);
            expect(pruneScore(created)).toBeLessThan(pruneScore(keeper));
          }

          const coreBefore = await provider.listMemoryEntries("core");
          const result = await provider.pruneMemory({ targetLayer: "episodic", maxEntries: 1 });
          const coreAfter = await provider.listMemoryEntries("core");
          const episodicAfter = await provider.listMemoryEntries("episodic");

          expect(episodicAfter.length).toBe(1);
          expect(episodicAfter[0]?.id).toBe(keeper.id);
          expect(result.pruned).toBe(prunableCount);
          expect(result.summarized).toBe(prunableCount);

          const newSummaries = coreAfter.filter(
            (entry) => !coreBefore.some((before) => before.id === entry.id),
          );
          expect(newSummaries.length).toBe(prunableCount);

          for (const summary of newSummaries) {
            expect(summary.layer).toBe("core");
            expect(summary.source).toBe("prune");
            expect(summary.tags).toContain("auto-summary");
            expect(summary.content).toMatch(/^\[summary\]/);
            expect(summary.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
            const originalId = summary.metadata?.originalId;
            expect(typeof originalId).toBe("string");
            expect(prunableIds).toContain(originalId);
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  // Feature: chunk-036, Property: prune survival invariants
  it("does not prune non-target layers when enforcing episodic maxEntries", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(layerArb, { minLength: 1, maxLength: 12 }),
        async (layers) => {
          const { provider } = createProvider();
          const createdIds: string[] = [];

          for (const layer of layers) {
            const created = await provider.createMemoryEntry({
              layer,
              content: `${layer}-entry`,
              timestamp: OLD_TS,
              tags: [],
              source: "system",
              metadata: {},
            });
            createdIds.push(created.id);
          }

          await provider.pruneMemory({ targetLayer: "episodic", maxEntries: 0 });
          const all = await provider.listMemoryEntries();
          const nonEpisodicIds = layers
            .map((layer, index) => (layer !== "episodic" ? createdIds[index] : undefined))
            .filter((id): id is string => id !== undefined);

          for (const id of nonEpisodicIds) {
            expect(all.some((entry) => entry.id === id)).toBe(true);
          }
        },
      ),
      { numRuns: 40 },
    );
  });
});