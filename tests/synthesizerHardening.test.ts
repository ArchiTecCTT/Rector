import { describe, expect, it } from "vitest";

import { DagExecutionResultSchema } from "../src/orchestration/executorSimulator";
import { PlannerInputSchema, createFakePlan } from "../src/orchestration/planner";
import { reviewPlanWithSkeptic } from "../src/orchestration/skeptic";
import { arbitratePlanWithCrucible } from "../src/orchestration/crucible";
import { triageUserMessage } from "../src/orchestration/triage";
import {
  MAX_NARRATIVE_ANSWER_CHARS,
  runLiveSynthesizer,
  synthesizeChatBrainstemResponse,
  type BrainstemSynthesisInput,
  type SynthesisDraft,
} from "../src/orchestration/synthesizer";
import type { HealingLoopResult } from "../src/orchestration/validationHealing";
import {
  DEFAULT_SPY_USAGE,
  SpyLLMProvider,
  generousBudget,
  makeContextPack,
  makeExternalRun,
  synthesisDraftToJson,
} from "./support/byokArbitraries";

const NOW = "2026-01-01T00:00:00.000Z";
const FAILURE_MARKER = "SYNTH_HARDENING_FAILURE_MARKER";

function makeInput(overrides: Partial<BrainstemSynthesisInput> = {}): BrainstemSynthesisInput {
  const prompt = "Fix the TypeScript validation failure in src/api/server.ts and update tests.";
  const triage = triageUserMessage(prompt);
  const contextPack = makeContextPack(triage, prompt);
  const plannerInput = PlannerInputSchema.parse({ triage, contextPack, messageContent: prompt });
  const plannerOutput = createFakePlan(plannerInput);
  const skepticReview = reviewPlanWithSkeptic(plannerOutput, contextPack);
  const crucibleDecision = arbitratePlanWithCrucible({ plannerOutput, skepticReview, now: () => NOW });
  return {
    traceId: "trace-synth-hardening",
    triage,
    contextPack,
    plannerOutput,
    skepticReview,
    crucibleDecision,
    ...overrides,
  };
}

function failedExecution() {
  return DagExecutionResultSchema.parse({
    dagId: "dag-synth-hardening",
    runId: "run-synth-hardening",
    status: "FAILED",
    startedAt: NOW,
    completedAt: NOW,
    durationMs: 1,
    nodeResults: [
      {
        nodeId: "validate:test",
        status: "FAILED",
        attempts: 1,
        startedAt: NOW,
        completedAt: NOW,
        durationMs: 1,
        dependencies: [],
        error: { code: "VALIDATION_FAILED", message: `test failed ${FAILURE_MARKER}`, nodeId: "validate:test" },
      },
    ],
    events: [
      { sequence: 1, type: "DAG_STARTED", at: NOW },
      { sequence: 2, type: "DAG_COMPLETED", status: "FAILED", at: NOW },
    ],
  });
}

function failedHealing(): HealingLoopResult {
  const finalExecutionResult = failedExecution();
  return {
    status: "FAILED",
    attempts: 1,
    failures: [
      {
        nodeId: "validate:test",
        classification: "VALIDATION",
        errorCode: "VALIDATION_FAILED",
        message: `test failed ${FAILURE_MARKER}`,
      },
    ],
    actions: [{ type: "FAIL_RUN", nodeId: "validate:test", classification: "VALIDATION", reason: "validation failed" }],
    finalExecutionResult,
    rounds: [],
  };
}

describe("synthesizer hardening", () => {
  it("keeps deterministic local synthesis stable and provider-free", () => {
    const input = makeInput({ executionResult: failedExecution(), validationHealingResult: failedHealing() });

    const first = synthesizeChatBrainstemResponse(input);
    const second = synthesizeChatBrainstemResponse(input);

    expect(first).toEqual(second);
    expect(first.providerCalls).toBe(0);
    expect(first.response).toContain("Local mode: provider calls: 0");
  });

  it("falls back deterministically with an explicit fallback reason after malformed live output", async () => {
    const input = makeInput({ executionResult: failedExecution(), validationHealingResult: failedHealing() });
    const provider = new SpyLLMProvider({ estimate: DEFAULT_SPY_USAGE, responses: ["not json", "still not json"] });

    const result = await runLiveSynthesizer(input, { provider, run: makeExternalRun(generousBudget()) });

    expect(result.status).toBe("fallback");
    expect(result.synthesis).toEqual(synthesizeChatBrainstemResponse(input));
    expect(result.fallbackReason).toContain("validation failed");
    expect(JSON.stringify(result)).not.toContain("not json");
  });

  it("formats successful live synthesis with summary/actions/validation/risks/next steps and preserves citations", async () => {
    const input = makeInput({ executionResult: failedExecution(), validationHealingResult: failedHealing() });
    const draft: SynthesisDraft = {
      response: "The validation run failed and no safe automatic repair remains.",
      citations: [{ kind: "failure", ref: "validate:test", detail: `validation output ${FAILURE_MARKER}` }],
    };
    const provider = new SpyLLMProvider({ estimate: DEFAULT_SPY_USAGE, responses: [synthesisDraftToJson(draft)] });

    const result = await runLiveSynthesizer(input, { provider, run: makeExternalRun(generousBudget()) });

    expect(result.status).toBe("ok");
    expect(result.citations).toHaveLength(1);
    expect(result.synthesis.response).toContain("Summary:");
    expect(result.synthesis.response).toContain("Actions:");
    expect(result.synthesis.response).toContain("Validation:");
    expect(result.synthesis.response).toContain("Risks:");
    expect(result.synthesis.response).toContain("Next steps:");
    expect(result.synthesis.response).toContain(FAILURE_MARKER);
    expect(result.synthesis.response.length).toBeLessThanOrEqual(MAX_NARRATIVE_ANSWER_CHARS);
  });
});
