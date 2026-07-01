import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  renderStrictJsonRepairCards,
  repairHintForDiagnostic,
} from "../../src/orchestration/strictJsonRepairCards";
import {
  createStrictOutputDiagnostic,
  diagnosticFromSemanticInvariant,
  zodDiagnostics,
} from "../../src/orchestration/strictOutputDiagnostics";
import { buildPlannerRepairPrompt } from "../../src/orchestration/prompts";
import { triageUserMessage } from "../../src/orchestration/triage";
import type { ContextPack } from "../../src/orchestration/contextBuilder";
import type { PlannerInput } from "../../src/orchestration/planner";

function plannerInput(): PlannerInput {
  const triage = triageUserMessage("Plan a migration");
  const contextPack: ContextPack = {
    id: "ctx-repair-cards",
    createdAt: "2026-01-01T00:00:00.000Z",
    userIntentSummary: "Plan a migration",
    conversationRef: { id: "conv-repair", title: "Repair cards", workspaceId: "local" },
    messageRefs: [],
    relevantDocs: [],
    relevantMemory: [],
    constraints: [],
    availableProviders: { configured: [], unavailable: [], notes: [] },
    availableTools: { names: [], notes: [] },
    riskFlags: triage.riskFlags,
    triage,
    artifactHandles: [],
    inlineContext: [],
  };
  return { triage, contextPack, messageContent: "Plan a migration" };
}

describe("strictJsonRepairCards", () => {
  it("renders path, kind, code, and bounded redacted problem text", () => {
    const diagnostics = [
      diagnosticFromSemanticInvariant({
        code: "secret_context",
        message: `Bad token sk-test-secret1234567890 ${"x".repeat(400)}`,
        path: ["tasks", 0, "dependencies", 0],
      }),
    ];

    const cards = renderStrictJsonRepairCards(diagnostics, { maxTotalChars: 2_000 });

    expect(cards).toContain("Strict JSON repair cards");
    expect(cards).toContain("path: tasks.0.dependencies.0");
    expect(cards).toContain("kind/code: semantic_invariant / secret_context");
    expect(cards).toContain("problem:");
    expect(cards).toContain("repair:");
    expect(cards).not.toContain("sk-test-secret1234567890");
    expect(cards.length).toBeLessThanOrEqual(2_000);
  });

  it("maps invalid_union_discriminator on kind to shadow fact kinds and TS guidance", () => {
    const diagnostic = createStrictOutputDiagnostic({
      kind: "semantic_invariant",
      code: "invalid_union_discriminator",
      message: "Invalid discriminator value",
      path: "kind",
      details: {
        expectedValues: ["capability_evidence", "capability_warning", "capability_failure"],
      },
    });
    const hint = repairHintForDiagnostic(diagnostic);
    expect(hint).toContain("capability_evidence");
    expect(hint).toContain("capability_warning");
    expect(hint).toContain("diagnostic/root_cause/cascade");
  });

  it("uses zod details for repair hints when available", () => {
    const Schema = z.object({ riskLevel: z.enum(["low", "medium"]) });
    const parsed = Schema.safeParse({ riskLevel: "nope" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const [diagnostic] = zodDiagnostics(parsed.error);
      expect(repairHintForDiagnostic(diagnostic)).toContain("enum");
    }
  });

  it("caps the number of rendered cards", () => {
    const diagnostics = Array.from({ length: 30 }, (_, index) =>
      createStrictOutputDiagnostic({
        kind: "schema",
        code: `code_${index}`,
        message: `issue ${index}`,
        path: `field.${index}`,
      }),
    );

    const cards = renderStrictJsonRepairCards(diagnostics, { maxCards: 5, maxTotalChars: 8_000 });
    expect(cards.match(/\[1\]/g)?.length).toBe(1);
    expect(cards.match(/\[\d+\]/g)?.length).toBe(5);
  });
});

describe("planner repair prompt with diagnostics", () => {
  it("includes structured repair cards and reference-set hints", () => {
    const diagnostics = [
      createStrictOutputDiagnostic({
        kind: "schema",
        code: "zod_custom",
        message: "Planner task foo references missing dependency: bar",
        path: ["tasks", 0, "dependencies", 0],
        details: { zodCode: "custom" },
      }),
    ];

    const messages = buildPlannerRepairPrompt(plannerInput(), '{"goal":"x"}', "flat summary unused", {
      role: "planner",
      diagnostics,
      allowedTaskIds: ["alpha", "beta"],
    });

    const repairUser = messages.at(-1)?.content ?? "";
    expect(repairUser).toContain("Strict JSON repair cards");
    expect(repairUser).toContain("path: tasks.0.dependencies.0");
    expect(repairUser).toContain("kind/code: schema / zod_custom");
    expect(repairUser).toContain("Allowed task ids for dependencies and gates: alpha, beta");
    expect(repairUser).toContain("Emit one complete JSON object only");
    expect(repairUser).not.toContain("flat summary unused");
  });
});