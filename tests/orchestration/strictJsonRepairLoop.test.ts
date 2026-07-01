import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  runBoundedStrictJsonRepairLoop,
  type StrictJsonAttemptContext,
} from "../../src/orchestration/strictJsonRepairLoop";
import {
  diagnosticFromSemanticInvariant,
  zodDiagnostics,
} from "../../src/orchestration/strictOutputDiagnostics";
import { createFakePlan, runLivePlanner, type PlannerInput } from "../../src/orchestration/planner";
import { triageUserMessage } from "../../src/orchestration/triage";
import { LLMResponseSchema } from "../../src/providers/llm";
import { DEFAULT_SPY_USAGE, SpyLLMProvider, generousBudget, makeContextPack, makeExternalRun } from "../support/byokArbitraries";

const PayloadSchema = z.object({ ok: z.literal(true), value: z.string().min(1) }).strict();

function validatePayload(value: unknown) {
  const parsed = PayloadSchema.safeParse(value);
  return parsed.success
    ? { ok: true as const, value: parsed.data }
    : { ok: false as const, diagnostics: zodDiagnostics(parsed.error) };
}

function inputFor(prompt: string): PlannerInput {
  const triage = triageUserMessage(prompt);
  return { triage, contextPack: makeContextPack(triage, prompt), messageContent: prompt };
}

describe("bounded strict JSON repair loop", () => {
  it("classifies a valid first attempt as first_pass", async () => {
    const seen: StrictJsonAttemptContext[] = [];

    const result = await runBoundedStrictJsonRepairLoop({
      operation: "unit-test",
      call: async (context) => {
        seen.push(context);
        return { content: JSON.stringify({ ok: true, value: "ready" }) };
      },
      validate: validatePayload,
    });

    expect(result.status).toBe("passed");
    expect(result.classification).toBe("first_pass");
    expect(result.attempts).toHaveLength(1);
    expect(seen[0]).toMatchObject({ attemptNumber: 1, attemptKind: "first", priorDiagnostics: [] });
  });

  it("classifies a successful repair attempt as repair_pass with diagnostic history", async () => {
    const result = await runBoundedStrictJsonRepairLoop({
      operation: "unit-test",
      call: async (context) => ({
        content: context.attemptKind === "first" ? "{\"ok\":true" : JSON.stringify({ ok: true, value: "repaired" }),
      }),
      validate: validatePayload,
    });

    expect(result.status).toBe("passed");
    expect(result.classification).toBe("repair_pass");
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0].diagnostics.map((diagnostic) => diagnostic.code)).toContain("json_syntax_error");
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("json_syntax_error");
    if (result.status === "passed") {
      expect(result.value.value).toBe("repaired");
    }
  });

  it("returns failed_after_repair when the repair attempt still violates semantic invariants", async () => {
    const result = await runBoundedStrictJsonRepairLoop({
      operation: "unit-test",
      call: async (context) => ({
        content: context.attemptKind === "first"
          ? JSON.stringify({ ok: true, value: "" })
          : JSON.stringify({ ok: true, value: "schema-valid" }),
      }),
      validate: (value) => {
        const parsed = validatePayload(value);
        if (!parsed.ok) return parsed;
        return {
          ok: false as const,
          diagnostics: [
            diagnosticFromSemanticInvariant({
              code: "semantic_rule_failed",
              message: "Schema-valid output still failed the semantic rule",
              path: ["value"],
            }),
          ],
        };
      },
    });

    expect(result.status).toBe("failed");
    expect(result.classification).toBe("failed_after_repair");
    expect(result.attempts).toHaveLength(2);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("zod_too_small");
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("semantic_rule_failed");
  });

  it("does not count deterministic fallback JSON as a live strict pass", async () => {
    const result = await runBoundedStrictJsonRepairLoop({
      operation: "unit-test",
      maxAttempts: 1,
      call: async () => ({
        content: JSON.stringify({ ok: true, value: "fallback" }),
        evidenceStatus: "deterministic_fallback",
      }),
      validate: validatePayload,
    });

    expect(result.status).toBe("failed");
    expect(result.classification).toBe("failed_after_repair");
    expect(result.attempts).toHaveLength(1);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("deterministic_fallback_not_live");
  });

  it("keeps planner validators strict while surfacing repair_pass classification", async () => {
    const input = inputFor("Fix src/api/server.ts and update tests.");
    const validPlan = createFakePlan(input);
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [
        LLMResponseSchema.parse({
          provider: "spy",
          model: "spy-model",
          content: JSON.stringify({ ...validPlan, tasks: [{ ...validPlan.tasks[0], id: "" }] }),
          finishReason: "stop",
          usage: DEFAULT_SPY_USAGE,
        }),
        LLMResponseSchema.parse({
          provider: "spy",
          model: "spy-model",
          content: JSON.stringify(validPlan),
          finishReason: "stop",
          usage: DEFAULT_SPY_USAGE,
        }),
      ],
    });

    const result = await runLivePlanner(input, { provider, run: makeExternalRun(generousBudget()) });

    expect(result.status).toBe("ok");
    expect(result.attempts).toBe(2);
    expect(result.strictJsonClassification).toBe("repair_pass");
    expect(result.strictJsonAttempts?.[0]?.diagnostics.map((diagnostic) => diagnostic.path)).toContain("tasks.0.id");
    expect(result.strictJsonEvidenceStatus).toBe("test_only_injected");
  });
});
