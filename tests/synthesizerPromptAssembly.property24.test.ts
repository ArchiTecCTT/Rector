/**
 * Feature: cloud-capable-transition, Property 24: The narrative prompt includes
 * present inputs and omits absent ones without failing.
 *
 * Validates: Requirements 7.2
 *
 * Req 7.2: WHEN the Synthesizer constructs the Narrative_Answer prompt, THE
 * Synthesizer SHALL include the triage intent, the compiled DAG, the node
 * execution logs, the validation outcomes, and the generated diffs, and SHALL
 * omit any of these inputs that are absent for the run rather than fail.
 *
 * `buildSynthesizerPrompt` is the prompt builder. The triage intent is a
 * required field (always present); the compiled DAG, node execution logs, and
 * the validation/healing outcomes (which carry the generated diffs as healing
 * actions) are the genuinely-optional inputs the builder consumes. This property
 * ranges over every combination of present/absent optional inputs and asserts:
 *
 *   1. the builder never throws ("without failing") for any combination,
 *   2. each present input is serialized into the assembled prompt, and
 *   3. each absent input is omitted from the assembled prompt (its top-level
 *      run-state key disappears and its sentinel never appears).
 *
 * Each optional input carries a unique sentinel token so its presence/absence is
 * observable both structurally (the parsed run-state JSON key) and textually (the
 * sentinel substring). The base run state (triage, context, plan, skeptic review,
 * crucible decision) is derived bottom-up from the real, deterministic pipeline
 * helpers so every required field stays internally consistent and schema-valid.
 *
 * Everything is in-memory and pure: no provider, no network, no API key, and no
 * filesystem are touched.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { createFakePlan, type PlannerInput } from "../src/orchestration/planner";
import { reviewPlanWithSkeptic } from "../src/orchestration/skeptic";
import { arbitratePlanWithCrucible } from "../src/orchestration/crucible";
import { triageUserMessage } from "../src/orchestration/triage";
import { buildSynthesizerPrompt } from "../src/orchestration/prompts";
import type { BrainstemSynthesisInput } from "../src/orchestration/synthesizer";
import { arbPrompt, makeContextPack } from "./support/byokArbitraries";

const FIXED_TIMESTAMP = "2026-01-01T00:00:00.000Z";

/**
 * Unique, redaction-safe sentinel tokens (plain uppercase alphanumerics: no
 * `token=`, `Bearer`, or credential-URL shape) so each appears in the assembled
 * prompt iff its owning input was supplied. The astronomically-unlikely event of
 * an arbitrary prompt reproducing one of these tokens is the only thing that
 * could blur the present/absent signal, so they are kept long and distinctive.
 */
const SENTINEL = {
  intent: "TRIAGEINTENTSENTINELQ24",
  dag: "DAGNODELABELSENTINELQ24",
  execution: "EXECNODEIDSENTINELQ24",
  validation: "VALIDATIONFAILSENTINELQ24",
  diff: "HEALINGDIFFACTIONSENTINELQ24",
} as const;

/** A compiled-DAG-shaped optional input carrying the DAG sentinel as a node label. */
const compiledDagSentinel = {
  id: "dag-sentinel",
  nodes: [{ id: "dag-node-sentinel", type: "task", label: SENTINEL.dag }],
  edges: [],
} as unknown as NonNullable<BrainstemSynthesisInput["compiledDag"]>;

/** A node-execution-log-shaped optional input carrying the execution sentinel as a node id. */
const executionResultSentinel = {
  status: "SUCCESS",
  nodeResults: [{ nodeId: SENTINEL.execution, status: "SUCCESS", attempts: 1 }],
} as unknown as NonNullable<BrainstemSynthesisInput["executionResult"]>;

/**
 * A validation/healing-outcome-shaped optional input. It carries the validation
 * sentinel as a failure message (the validation outcome) and the diff sentinel as
 * a healing-action reason (the generated diff/repair patch), so a present
 * validation result surfaces both the validation outcomes and the generated diffs.
 */
const validationHealingResultSentinel = {
  status: "HEALED",
  attempts: 1,
  failures: [
    {
      nodeId: "vnode-sentinel",
      classification: "transient",
      errorCode: "E_SENTINEL",
      message: SENTINEL.validation,
    },
  ],
  actions: [{ type: "repair", nodeId: "vnode-sentinel", reason: SENTINEL.diff }],
} as unknown as NonNullable<BrainstemSynthesisInput["validationHealingResult"]>;

/** An observability-summary-shaped optional input (numeric-only; detected structurally). */
const observabilitySummarySentinel = {
  spanCount: 3,
  durationMs: 123,
  modelCallCount: 2,
  estimatedCostUsd: 0.5,
} as unknown as NonNullable<BrainstemSynthesisInput["observabilitySummary"]>;

/**
 * Builds the internally-consistent, always-present base run state for a prompt.
 * The triage intent is embedded with {@link SENTINEL.intent} at the front of the
 * intent text so it always reaches the serialized prompt.
 */
function buildBaseInput(prompt: string): Pick<
  BrainstemSynthesisInput,
  "triage" | "contextPack" | "plannerOutput" | "skepticReview" | "crucibleDecision"
> {
  const triage = triageUserMessage(prompt);
  const intent = `${SENTINEL.intent} ${prompt}`;
  const contextPack = makeContextPack(triage, intent);
  const plannerInput: PlannerInput = { triage, contextPack, messageContent: intent };
  const plannerOutput = createFakePlan(plannerInput);
  const skepticReview = reviewPlanWithSkeptic(plannerOutput, contextPack);
  const crucibleDecision = arbitratePlanWithCrucible({
    plannerOutput,
    skepticReview,
    now: () => FIXED_TIMESTAMP,
  });
  return { triage, contextPack, plannerOutput, skepticReview, crucibleDecision };
}

/**
 * Extracts and parses the `RUN STATE (JSON)` block embedded in the synthesizer
 * user message. JSON.stringify escapes any newline inside a string value as the
 * two characters `\n`, so the real `"\n\nRespond with ONLY"` tail can only match
 * the message's actual closing line, never content inside the serialized state.
 */
function extractRunState(userContent: string): Record<string, unknown> {
  const marker = "RUN STATE (JSON):\n";
  const start = userContent.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const jsonStart = start + marker.length;
  const jsonEnd = userContent.indexOf("\n\nRespond with ONLY", jsonStart);
  expect(jsonEnd).toBeGreaterThan(jsonStart);
  return JSON.parse(userContent.slice(jsonStart, jsonEnd)) as Record<string, unknown>;
}

const arbCase = fc.record({
  prompt: arbPrompt(),
  includeDag: fc.boolean(),
  includeExecution: fc.boolean(),
  includeValidation: fc.boolean(),
  includeObservability: fc.boolean(),
});

describe("Feature: cloud-capable-transition, Property 24: the narrative prompt includes present inputs and omits absent ones without failing", () => {
  // Validates: Requirements 7.2.
  it("assembles the synthesizer prompt for every present/absent input combination, including present inputs and omitting absent ones", () => {
    fc.assert(
      fc.property(arbCase, (testCase) => {
        const { prompt, includeDag, includeExecution, includeValidation, includeObservability } = testCase;
        const base = buildBaseInput(prompt);

        const input: BrainstemSynthesisInput = {
          traceId: "trace-prop24",
          ...base,
          compiledDag: includeDag ? compiledDagSentinel : undefined,
          executionResult: includeExecution ? executionResultSentinel : undefined,
          validationHealingResult: includeValidation ? validationHealingResultSentinel : undefined,
          observabilitySummary: includeObservability ? observabilitySummarySentinel : undefined,
        };

        // (1) The builder must never fail for any combination of present/absent inputs.
        const messages = buildSynthesizerPrompt(input);
        expect(messages).toHaveLength(2);
        expect(messages[1].role).toBe("user");
        const userContent = messages[1].content;
        const runState = extractRunState(userContent);

        // Triage intent is a required input: always present in the assembled prompt.
        expect(typeof runState.request).toBe("string");
        expect(runState.triage).toBeDefined();
        expect(userContent).toContain(SENTINEL.intent);

        // (2)/(3) Compiled DAG: present iff supplied.
        if (includeDag) {
          expect(runState.dag).toBeDefined();
          expect(userContent).toContain(SENTINEL.dag);
        } else {
          expect(runState.dag).toBeUndefined();
          expect(userContent).not.toContain(SENTINEL.dag);
        }

        // Node execution logs: present iff supplied.
        if (includeExecution) {
          expect(runState.execution).toBeDefined();
          expect(userContent).toContain(SENTINEL.execution);
        } else {
          expect(runState.execution).toBeUndefined();
          expect(userContent).not.toContain(SENTINEL.execution);
        }

        // Validation outcomes and the generated diffs (healing actions): present iff supplied.
        if (includeValidation) {
          expect(runState.validation).toBeDefined();
          expect(userContent).toContain(SENTINEL.validation);
          expect(userContent).toContain(SENTINEL.diff);
        } else {
          expect(runState.validation).toBeUndefined();
          expect(userContent).not.toContain(SENTINEL.validation);
          expect(userContent).not.toContain(SENTINEL.diff);
        }

        // Observability summary: present iff supplied (numeric-only, detected structurally).
        if (includeObservability) {
          expect(runState.observability).toBeDefined();
        } else {
          expect(runState.observability).toBeUndefined();
        }
      }),
      { numRuns: 200 }
    );
  });
});
