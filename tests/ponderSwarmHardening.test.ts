import { describe, expect, it } from "vitest";

import {
  PonderTriggerPolicy,
  detectContradictions,
  ponderLessonInputHash,
  runPonderSwarm,
} from "../src/orchestration/ponderSwarm";
import { SpyLLMProvider, generousBudget, makeExternalRun, synthesisDraftToJson } from "./support/byokArbitraries";
import type { MemoryEntry } from "../src/store";

function makeEntry(partial: Partial<MemoryEntry> & Pick<MemoryEntry, "content">): MemoryEntry {
  const now = "2026-06-12T00:00:00.000Z";
  return {
    id: partial.id ?? "mem-1",
    layer: partial.layer ?? "episodic",
    content: partial.content,
    timestamp: partial.timestamp ?? now,
    lastMentioned: partial.lastMentioned ?? now,
    accessCount: partial.accessCount ?? 0,
    tags: partial.tags ?? [],
    source: partial.source,
    metadata: partial.metadata ?? {},
  };
}

describe("ponder swarm hardening", () => {
  it("does not call provider when there is no informative memory", async () => {
    const provider = new SpyLLMProvider();

    const lessons = await runPonderSwarm([], { provider, run: makeExternalRun(generousBudget()) });

    expect(lessons).toEqual([]);
    expect(provider.invokeCount).toBe(0);
    expect(provider.estimateCount).toBe(0);
  });

  it("suppresses duplicate lesson content and hashes", async () => {
    const lesson = "Prefer focused edits with explicit validation evidence.";
    const provider = new SpyLLMProvider({
      responses: [
        {
          content: synthesisDraftToJson({
            response: lesson,
            citations: [{ kind: "artifact", ref: "mem-1", detail: "reflection" }],
          }),
        },
      ],
    });
    const existing = makeEntry({
      id: "core-lesson",
      layer: "core",
      content: lesson,
      tags: ["ponder-lesson"],
      source: "ponder-swarm",
      metadata: { contentHash: ponderLessonInputHash(lesson) },
    });

    const lessons = await runPonderSwarm(
      [makeEntry({ content: "The user repeatedly asks for focused edits with validation evidence." })],
      { provider, run: makeExternalRun(generousBudget()) },
      { existingLessons: [existing] },
    );

    expect(provider.invokeCount).toBe(1);
    expect(lessons).toEqual([]);
  });

  it("honors budget denial without invoking the provider", async () => {
    const provider = new SpyLLMProvider({
      responses: [
        {
          content: synthesisDraftToJson({
            response: "This should not be produced.",
            citations: [],
          }),
        },
      ],
    });

    const lessons = await runPonderSwarm(
      [makeEntry({ content: "The user prefers concise lessons after every major validation run." })],
      { provider, run: makeExternalRun(generousBudget({ maxModelCalls: 0 })) },
    );

    expect(lessons).toEqual([]);
    expect(provider.invokeCount).toBe(0);
  });

  it("redacts contradiction output and carries confidence/provenance", () => {
    const secret = "abc123-super-secret";
    const signals = detectContradictions([
      makeEntry({ id: "left", content: `We should never deploy with token=${secret}.`, source: "user-note" }),
      makeEntry({ id: "right", content: `We should always deploy with token=${secret}.`, source: "user-note" }),
    ]);

    expect(signals).toHaveLength(1);
    expect(signals[0].message).toContain("[REDACTED]");
    expect(signals[0].message).not.toContain(secret);
    expect(signals[0].confidence).toBeGreaterThanOrEqual(0.8);
    expect(signals[0].sourceMemoryIds).toEqual(["left", "right"]);
  });

  it("bounds ponder triggers by the configured run window", () => {
    let now = Date.parse("2026-06-12T00:00:00.000Z");
    const policy = new PonderTriggerPolicy({
      minNewEpisodicEntries: 1,
      maxRunsPerWindow: 1,
      windowMs: 60_000,
      nowMs: () => now,
    });
    const memory = [makeEntry({ content: "The user prefers validated, concise implementation summaries." })];

    const first = policy.shouldRun({ trigger: "run-completed", episodicEntries: memory });
    expect(first.shouldRun).toBe(true);
    policy.recordRun();

    const second = policy.shouldRun({ trigger: "run-completed", episodicEntries: memory });
    expect(second.shouldRun).toBe(false);
    expect(second.reasons.join(" ")).toContain("max runs");

    now += 61_000;
    const third = policy.shouldRun({
      trigger: "contradiction",
      episodicEntries: memory.map((entry) => ({ ...entry, timestamp: "2026-06-12T00:01:02.000Z" })),
      contradictionSignals: [
        {
          kind: "never-always",
          message: "Potential contradiction",
          confidence: 0.8,
          sourceMemoryIds: ["a", "b"],
          evidence: [],
          contentHash: "hash",
        },
      ],
    });
    expect(third.shouldRun).toBe(true);
  });
});
