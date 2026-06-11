import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  aggregateConversationCost,
  aggregateRunCost,
  type RunCostAggregate,
} from "../src/observability";
import type { Run, RunEvent } from "../src/store/schemas";

/**
 * Property 5: Aggregated per-run/per-conversation cost equals the sum of per-call usage.
 * Validates: Requirements 3.2, 3.3
 *
 * `aggregateRunCost(runId, events)` folds the `providerCall.usage` carried inside each persisted run
 * event's free-form `payload` into a per-run total, and `aggregateConversationCost(...)` sums those
 * per-run totals across a conversation's runs. This suite generates `LLMUsage`-like provider-call
 * lists, synthesizes run events that carry them (interspersed with provider-call-free events that
 * must contribute zero), and asserts the aggregates equal sums computed INDEPENDENTLY of the folds
 * under test.
 *
 * Float handling: `estimatedUsd` is generated as a whole number of cents and surfaced as a
 * 2-decimal dollar value (`cents / 100`). The independent expected sum accumulates the SAME values
 * in the SAME (event) order as the fold, and the comparison uses `toBeCloseTo` so floating-point
 * rounding never makes a correct aggregate flake. Every other field is a non-negative integer and
 * is compared exactly.
 *
 * Pure + offline: no store, no provider, no network, no API key — events are synthesized in memory.
 */

// --- Generators ------------------------------------------------------------

const PROVIDER_POOL = ["openai", "anthropic", "google", "local-sim"] as const;
const MODEL_POOL = ["gpt-4o", "claude-3-5", "gemini-1.5-pro", "sim-model"] as const;

const tokenArb = fc.nat({ max: 1_000_000 });
const modelCallsArb = fc.nat({ max: 50 });
// Whole cents -> 2-decimal USD, keeping generated costs realistic and float-stable.
const usdArb = fc.nat({ max: 5_000_000 }).map((cents) => cents / 100);

interface CallSpec {
  readonly kind: "call";
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedUsd: number;
  readonly modelCalls: number;
}

interface BlankSpec {
  readonly kind: "blank";
}

type EventSpec = CallSpec | BlankSpec;

const callSpecArb: fc.Arbitrary<CallSpec> = fc.record({
  kind: fc.constant("call" as const),
  provider: fc.constantFrom(...PROVIDER_POOL),
  model: fc.constantFrom(...MODEL_POOL),
  inputTokens: tokenArb,
  outputTokens: tokenArb,
  estimatedUsd: usdArb,
  modelCalls: modelCallsArb,
});

// A provider-call-free event (e.g. a local-mode transition) — MUST contribute zero to the totals.
const blankSpecArb: fc.Arbitrary<BlankSpec> = fc.constant({ kind: "blank" as const });

// Bias toward provider-call events but keep blanks frequent enough to exercise the "contributes 0"
// path on every run.
const eventSpecArb: fc.Arbitrary<EventSpec> = fc.oneof(
  { weight: 3, arbitrary: callSpecArb },
  { weight: 1, arbitrary: blankSpecArb }
);

const eventSpecsArb = fc.array(eventSpecArb, { maxLength: 25 });

const EVENT_BASE = Date.parse("2026-01-01T00:00:00.000Z");

// --- Synthesizers ----------------------------------------------------------

/** Build one valid `RunEvent` for the given spec; call specs carry `payload.providerCall.usage`. */
function buildEvent(runId: string, index: number, spec: EventSpec): RunEvent {
  const base = {
    id: `evt-${runId}-${index}`,
    runId,
    type: "PHASE_CHANGED" as const,
    phase: "PLANNING" as const,
    traceId: `trace-${runId}`,
    createdAt: new Date(EVENT_BASE + index * 1000).toISOString(),
  };

  if (spec.kind === "blank") {
    // A provider-call-free event: free-form payload with no `providerCall` key.
    return { ...base, payload: { note: "local-mode transition" } };
  }

  return {
    ...base,
    payload: {
      providerCall: {
        provider: spec.provider,
        model: spec.model,
        usage: {
          inputTokens: spec.inputTokens,
          outputTokens: spec.outputTokens,
          totalTokens: spec.inputTokens + spec.outputTokens,
          estimatedUsd: spec.estimatedUsd,
          modelCalls: spec.modelCalls,
        },
      },
    },
  };
}

function buildEvents(runId: string, specs: readonly EventSpec[]): RunEvent[] {
  return specs.map((spec, index) => buildEvent(runId, index, spec));
}

// --- Independent expected-sum computation (does NOT call the folds under test) ----------------

interface ExpectedAggregate {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedUsd: number;
  modelCalls: number;
  providers: string[];
  models: string[];
}

/**
 * Compute the expected per-run aggregate directly from the specs, accumulating `estimatedUsd` in
 * event order (matching the fold's accumulation order) and collecting distinct provider/model ids
 * in first-seen order. This is intentionally a separate, hand-rolled summation so the assertion is
 * an independent check of `aggregateRunCost`.
 */
function expectedFromSpecs(specs: readonly EventSpec[]): ExpectedAggregate {
  let inputTokens = 0;
  let outputTokens = 0;
  let estimatedUsd = 0;
  let modelCalls = 0;
  const providers: string[] = [];
  const models: string[] = [];

  for (const spec of specs) {
    if (spec.kind !== "call") continue;
    inputTokens += spec.inputTokens;
    outputTokens += spec.outputTokens;
    estimatedUsd += spec.estimatedUsd;
    modelCalls += spec.modelCalls;
    if (!providers.includes(spec.provider)) providers.push(spec.provider);
    if (!models.includes(spec.model)) models.push(spec.model);
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimatedUsd,
    modelCalls,
    providers,
    models,
  };
}

/** Assert a produced aggregate matches the independently computed expectation. */
function assertAggregateMatches(actual: RunCostAggregate, expected: ExpectedAggregate): void {
  expect(actual.inputTokens).toBe(expected.inputTokens);
  expect(actual.outputTokens).toBe(expected.outputTokens);
  expect(actual.totalTokens).toBe(expected.totalTokens);
  expect(actual.totalTokens).toBe(actual.inputTokens + actual.outputTokens);
  expect(actual.modelCalls).toBe(expected.modelCalls);
  expect(actual.providers).toEqual(expected.providers);
  expect(actual.models).toEqual(expected.models);
  expect(actual.estimatedUsd).toBeCloseTo(expected.estimatedUsd, 6);
}

// --- Property: per-run aggregation ----------------------------------------

describe("aggregateRunCost — Property 5 (per-run)", () => {
  it("equals the independently summed per-call usage, with provider-call-free events contributing 0", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 12 }), eventSpecsArb, (runId, specs) => {
        const events = buildEvents(runId, specs);
        const aggregate = aggregateRunCost(runId, events);
        assertAggregateMatches(aggregate, expectedFromSpecs(specs));
        expect(aggregate.runId).toBe(runId);
      }),
      { numRuns: 200 }
    );
  });

  it("ignores events whose runId does not match the requested run", () => {
    fc.assert(
      fc.property(eventSpecsArb, eventSpecsArb, (mineSpecs, otherSpecs) => {
        const runId = "run-target";
        const mine = buildEvents(runId, mineSpecs);
        // Same provider-call usage but on a different run — must not leak into the target's totals.
        const others = buildEvents("run-other", otherSpecs);
        // Interleave the two runs' events.
        const interleaved: RunEvent[] = [];
        const max = Math.max(mine.length, others.length);
        for (let i = 0; i < max; i += 1) {
          if (i < mine.length) interleaved.push(mine[i]);
          if (i < others.length) interleaved.push(others[i]);
        }
        const aggregate = aggregateRunCost(runId, interleaved);
        assertAggregateMatches(aggregate, expectedFromSpecs(mineSpecs));
      }),
      { numRuns: 100 }
    );
  });
});

// --- Property: per-conversation aggregation -------------------------------

describe("aggregateConversationCost — Property 5 (per-conversation)", () => {
  it("totals equal the sum of per-run aggregates and the runs breakdown matches in insertion order", () => {
    const runSpecsArb = fc.array(eventSpecsArb, { minLength: 1, maxLength: 6 });

    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 12 }), runSpecsArb, (conversationId, perRunSpecs) => {
        // Distinct run ids in insertion order.
        const runs: Run[] = perRunSpecs.map(
          (_specs, index) => ({ id: `run-${index}` }) as unknown as Run
        );
        const eventsByRun = new Map<string, RunEvent[]>();
        runs.forEach((run, index) => {
          eventsByRun.set(run.id, buildEvents(run.id, perRunSpecs[index]));
        });

        const conversation = aggregateConversationCost(conversationId, runs, eventsByRun);

        // Independently compute each run's expected aggregate and the conversation totals.
        const perRunExpected = perRunSpecs.map((specs) => expectedFromSpecs(specs));

        expect(conversation.conversationId).toBe(conversationId);
        expect(conversation.runCount).toBe(runs.length);
        expect(conversation.runs).toHaveLength(runs.length);

        let inputTokens = 0;
        let outputTokens = 0;
        let estimatedUsd = 0;
        let modelCalls = 0;
        conversation.runs.forEach((runAggregate, index) => {
          // The per-run breakdown is in the runs' insertion order and matches each run's aggregate.
          expect(runAggregate.runId).toBe(runs[index].id);
          assertAggregateMatches(runAggregate, perRunExpected[index]);
          inputTokens += perRunExpected[index].inputTokens;
          outputTokens += perRunExpected[index].outputTokens;
          estimatedUsd += perRunExpected[index].estimatedUsd;
          modelCalls += perRunExpected[index].modelCalls;
        });

        expect(conversation.inputTokens).toBe(inputTokens);
        expect(conversation.outputTokens).toBe(outputTokens);
        expect(conversation.totalTokens).toBe(inputTokens + outputTokens);
        expect(conversation.modelCalls).toBe(modelCalls);
        expect(conversation.estimatedUsd).toBeCloseTo(estimatedUsd, 6);
      }),
      { numRuns: 150 }
    );
  });
});

// --- Example-based sanity checks ------------------------------------------

describe("aggregateRunCost — worked example", () => {
  it("sums two provider calls and de-duplicates provider/model ids in first-seen order", () => {
    const runId = "run-ex";
    const events = buildEvents(runId, [
      {
        kind: "call",
        provider: "openai",
        model: "gpt-4o",
        inputTokens: 100,
        outputTokens: 40,
        estimatedUsd: 0.12,
        modelCalls: 1,
      },
      { kind: "blank" },
      {
        kind: "call",
        provider: "openai",
        model: "claude-3-5",
        inputTokens: 10,
        outputTokens: 5,
        estimatedUsd: 0.03,
        modelCalls: 2,
      },
    ]);

    const aggregate = aggregateRunCost(runId, events);
    expect(aggregate.inputTokens).toBe(110);
    expect(aggregate.outputTokens).toBe(45);
    expect(aggregate.totalTokens).toBe(155);
    expect(aggregate.modelCalls).toBe(3);
    expect(aggregate.estimatedUsd).toBeCloseTo(0.15, 6);
    expect(aggregate.providers).toEqual(["openai"]);
    expect(aggregate.models).toEqual(["gpt-4o", "claude-3-5"]);
  });
});
