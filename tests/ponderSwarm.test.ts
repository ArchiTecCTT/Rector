import { describe, it, expect } from "vitest";

import { runPonderSwarm, runSubconsciousDaemon } from "../src/orchestration/ponderSwarm";
import { SpyLLMProvider, synthesisDraftToJson } from "./support/byokArbitraries";
import type { MemoryEntry } from "../src/store";
import type { Run } from "../src/store/schemas";


function makeRun(): Run {
  return {
    id: "run-ponder",
    conversationId: "conv-ponder",
    userMessageId: "msg-ponder",
    status: "completed",
    phase: "DONE",
    route: "ponder",
    complexity: "low",
    budget: {
      maxUsd: 1,
      maxInputTokens: 4000,
      maxOutputTokens: 1000,
      maxModelCalls: 2,
      maxRuntimeMs: 30_000,
      maxHealingAttempts: 0,
      allowedProviders: [],
      approvalRequiredAboveUsd: 0,
    },
    costEstimate: { usd: 0 },
    actualCost: { usd: 0 },
    tokenEstimate: { input: 0, output: 0 },
    actualTokens: { input: 0, output: 0 },
    traceId: "trace-ponder",
    attempts: 1,
    healingAttempts: 0,
    validationAttempts: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeEntry(partial: Partial<MemoryEntry> & Pick<MemoryEntry, "content">): MemoryEntry {
  const now = new Date().toISOString();
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

describe("ponderSwarm", () => {
  it("runPonderSwarm returns a redacted lesson from episodic entries", async () => {
    const secret = "ponder-leak-value-12345";
    const provider = new SpyLLMProvider({
      responses: [
        {
          content: synthesisDraftToJson({
            response: `Lesson learned with secret=${secret}`,
            citations: [{ kind: "artifact", ref: "ponder", detail: "reflection" }],
          }),
        },
      ],
    });

    const lessons = await runPonderSwarm(
      [makeEntry({ content: "User prefers concise answers.", layer: "episodic" })],
      { provider, run: makeRun() },
    );

    expect(lessons).toHaveLength(1);
    expect(lessons[0].lesson).not.toContain(secret);
    expect(lessons[0].lesson).toContain("[REDACTED]");
  });

  it("runSubconsciousDaemon detects never/always contradictions in user notes", () => {
    const contradictions = runSubconsciousDaemon([
      makeEntry({ content: "We should never deploy on Fridays.", source: "user-note" }),
      makeEntry({ content: "We should always deploy on Fridays.", source: "user-note" }),
    ]);

    expect(contradictions).toHaveLength(1);
    expect(contradictions[0]).toContain("never");
    expect(contradictions[0]).toContain("always");
  });
});