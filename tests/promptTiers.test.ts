import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  assemblePromptTiers,
  assertStableTierUnchanged,
  buildContextTier,
  buildVolatileTier,
  clearStableTierHashForRun,
} from "../src/orchestration/promptTiers";
import { triageUserMessage } from "../src/orchestration/triage";
import { makeContextPack } from "./support/byokArbitraries";

describe("prompt tiers", () => {
  it("keeps the stable tier hash unchanged across volatile clock changes", () => {
    const triage = triageUserMessage("Explain Rector");
    const contextPack = makeContextPack(triage);
    const first = assemblePromptTiers({
      stable: { role: "planner", systemRules: "stable rules", jsonContract: "{\"ok\": true}" },
      context: { contextPack },
      volatile: { now: () => "2026-01-01T00:00:00.000Z", phase: "PLANNING" },
    });
    const second = assemblePromptTiers({
      stable: { role: "planner", systemRules: "stable rules", jsonContract: "{\"ok\": true}" },
      context: { contextPack },
      volatile: { now: () => "2026-01-01T00:00:01.000Z", phase: "PLANNING" },
    });

    expect(first.stableHash).toBe(second.stableHash);
    expect(first.volatile).not.toBe(second.volatile);
  });

  it("caps and redacts the context tier", () => {
    const triage = triageUserMessage("Summarize");
    const contextPack = {
      ...makeContextPack(triage),
      inlineContext: [
        {
          kind: "fixture",
          summary: "secret-bearing context",
          content: `Authorization: Bearer sk-rector-tier-secret-0123456789 ${"x".repeat(500)}`,
          hash: "hash",
          sizeBytes: 600,
        },
      ],
    };

    const context = buildContextTier({
      contextPack,
      tierBudget: { maxContextChars: 180 },
    });

    expect(context.length).toBeLessThanOrEqual(180);
    expect(context).not.toContain("sk-rector-tier-secret-0123456789");
  });

  it("blocks stable tier mutation for a remembered run", () => {
    clearStableTierHashForRun("run-tier-test");
    const first = assemblePromptTiers({
      stable: { role: "planner", systemRules: "stable rules" },
    });
    const second = assemblePromptTiers({
      stable: { role: "planner", systemRules: "changed stable rules" },
    });

    assertStableTierUnchanged("run-tier-test", undefined, first.stableHash);
    expect(() => assertStableTierUnchanged("run-tier-test", undefined, second.stableHash)).toThrow(
      /Stable prompt tier mutation blocked/,
    );
    clearStableTierHashForRun("run-tier-test");
  });

  it("keeps volatile metadata out of the stable tier", () => {
    const bundle = assemblePromptTiers({
      stable: { role: "synthesizer", systemRules: "stable synthesis rules" },
      volatile: {
        now: () => "2026-01-01T00:00:00.000Z",
        activeTemplateId: "template-a",
        phase: "SYNTHESIZING",
      },
    });

    expect(bundle.stable).not.toContain("template-a");
    expect(bundle.volatile).toContain("template-a");
  });
});

describe("prompt tier properties", () => {
  it("never emits a context tier longer than the configured cap", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 2_000 }), fc.integer({ min: 50, max: 500 }), (content, cap) => {
        const context = buildContextTier({
          contextText: content,
          tierBudget: { maxContextChars: cap },
        });
        expect(context.length).toBeLessThanOrEqual(cap);
      }),
      { numRuns: 100 },
    );
  });

  it("keeps volatile tier within its cap", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 2_000 }), fc.integer({ min: 50, max: 500 }), (templateId, cap) => {
        const volatile = buildVolatileTier({ activeTemplateId: templateId }, { maxVolatileChars: cap });
        expect(volatile.length).toBeLessThanOrEqual(cap);
      }),
      { numRuns: 100 },
    );
  });
});
