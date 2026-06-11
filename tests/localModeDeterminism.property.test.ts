import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { runChat, type ChatRunArgs, type ChatRunResult } from "../src/orchestration/chatRunner";
import { InMemoryRectorStore } from "../src/store/inMemoryRectorStore";
import { triageUserMessage } from "../src/orchestration/triage";
import { createInMemoryObservabilityTrace } from "../src/observability";
import type { RunEvent } from "../src/store/schemas";
import { arbPrompt, makeContextPack } from "./support/byokArbitraries";

/**
 * Task 13.2 — Local_Mode determinism vs baseline property test.
 *
 * **Property 17: Local_Mode is deterministic against the baseline**
 * **Validates: Requirements 12.3**
 *
 * For any chat input, two Local_Mode runs SHALL produce identical phase sequences and outputs, and
 * that output SHALL equal the recorded pre-productization Local_Mode baseline (Requirement 12.3).
 *
 * Local_Mode is the provider-free deterministic regression baseline (`ORCHESTRATOR_MODE=local`),
 * driven here through the existing `chatRunner` local-mode harness (`runChat(..., { mode: "local" })`)
 * over the in-memory store. To make the "recorded baseline" concrete and reproducible, every source
 * of incidental non-determinism is pinned with deterministic doubles:
 *
 *   - a fresh `InMemoryRectorStore` with an injected monotonic string clock (stable, counter-based
 *     entity ids `conv-1`/`msg-1`/`run-1` and stable created/updated timestamps), and
 *   - an `InMemoryObservabilityTrace` with a fixed `traceId`, a counter-based span id factory, and a
 *     monotonic `Date` clock (stable span ids and durations).
 *
 * Two further classes of fields remain incidentally volatile because the orchestrator mints them
 * internally with wall-clock `Date`/`crypto.randomUUID()` and the local-mode entry point threads no
 * clock into the sub-components (crucible, DAG compiler, executor simulator): each run event's `id`
 * and `createdAt`, plus the ISO timestamps embedded in payloads (e.g. `crucibleDecision.createdAt`,
 * `compiledDag.createdAt`, execution node `startedAt`/`completedAt`). These incidental timestamps and
 * ids are NOT part of the semantic "phase sequence and outputs"; they are normalized out (event
 * id/createdAt stripped, every ISO-8601 timestamp string mapped to a fixed placeholder). Everything
 * that constitutes the actual output — the ordered phase/event-type sequence, the run record fields,
 * the planner/skeptic/crucible/DAG/execution payload structure, and the synthesis (status, route,
 * evidence, response text, embedded observability summary) — must then match byte-for-byte across
 * the two runs and the recorded baseline.
 *
 * Both runs are entirely in-memory and provider-free: no API key is read and zero provider/network
 * calls occur (asserted via `synthesis.providerCalls === 0` and `modelCallCount === 0`).
 */

/** A deterministic, monotonic string clock for the store (stable timestamps across both runs). */
function fixedStringClock(): () => string {
  let tick = 0;
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  return () => new Date(base + tick++ * 1000).toISOString();
}

/** A deterministic, monotonic `Date` clock for the observability trace (stable span durations). */
function fixedDateClock(): () => Date {
  let tick = 0;
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  return () => new Date(base + tick++ * 1000);
}

/** A deterministic, counter-based observability span id factory (stable span ids across runs). */
function fixedSpanIdFactory(): () => string {
  let counter = 0;
  return () => `span-${++counter}`;
}

/** The fixed trace id both runs share so the synthesis/observability output is byte-stable. */
const FIXED_TRACE_ID = "trace-local-determinism";

type LocalModeOutcome = ChatRunResult & { events: RunEvent[] };

/**
 * Runs a single provider-free Local_Mode chat run for `prompt` over a freshly constructed,
 * fully-deterministic environment (in-memory store + observability with pinned clocks/ids), exactly
 * as the chat endpoint dispatches local mode. Returns the run result plus the persisted run events
 * in insertion order.
 */
async function runLocalModeOnce(prompt: string): Promise<LocalModeOutcome> {
  const store = new InMemoryRectorStore({ now: fixedStringClock() });
  const conversation = await store.createConversation({
    title: "local-mode determinism",
    workspaceId: "local",
    retentionPolicy: "session",
  });
  const userMessage = await store.createMessage({
    conversationId: conversation.id,
    role: "user",
    content: prompt,
    status: "created",
    redactionState: "none",
  });
  const triage = triageUserMessage(prompt);
  const contextPack = makeContextPack(triage, prompt);
  const observability = createInMemoryObservabilityTrace({
    provider: "local",
    traceId: FIXED_TRACE_ID,
    idFactory: fixedSpanIdFactory(),
    now: fixedDateClock(),
  });

  const args: ChatRunArgs = {
    conversationId: conversation.id,
    userMessageId: userMessage.id,
    prompt,
    triage,
    contextPack,
    observability,
  };

  const result = await runChat(store, args, { mode: "local" });
  const events = await store.listEvents(result.run.id);
  return { ...result, events };
}

/** The ordered phase/event-type sequence — the "phase sequence" the property compares. */
function phaseSequence(events: RunEvent[]): string[] {
  return events.map((event) => `${event.type}:${event.phase}`);
}

/**
 * A normalized, comparable fingerprint of a Local_Mode run: the ordered phase sequence, the full run
 * record, every event payload (with only the incidentally-volatile `id`/`createdAt` stripped), and
 * the synthesis output. Two runs over the same input must produce an identical fingerprint.
 */
function fingerprint(outcome: LocalModeOutcome): unknown {
  return {
    run: outcome.run,
    phaseSequence: phaseSequence(outcome.events),
    events: outcome.events.map(({ id: _id, createdAt: _createdAt, ...rest }) => rest),
    synthesis: outcome.synthesis,
    observabilitySummary: outcome.observabilitySummary,
  };
}

/** Matches an ISO-8601 millisecond timestamp (e.g. `2026-06-07T06:03:36.565Z`). */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Serializes a fingerprint to a stable string, normalizing every ISO-8601 timestamp string to a
 * fixed placeholder. Incidental wall-clock timestamps the orchestrator mints internally (and that
 * the local-mode entry point cannot pin) are not part of the semantic phase-sequence/outputs the
 * property compares, so they are collapsed; all other content is preserved verbatim.
 */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, val) =>
    typeof val === "string" && ISO_TIMESTAMP.test(val) ? "<timestamp>" : val,
  );
}

describe("Local_Mode determinism vs baseline (Property 17)", () => {
  // Feature: productization-alpha, Property 17: Local_Mode is deterministic against the baseline
  it("two Local_Mode runs over the same input produce identical phase sequences and outputs", async () => {
    await fc.assert(
      fc.asyncProperty(arbPrompt(), async (prompt) => {
        // The first run is the recorded baseline; the second is an independent replay.
        const baseline = await runLocalModeOnce(prompt);
        const replay = await runLocalModeOnce(prompt);

        // Provider-free: neither run makes any provider/network call (Req 12.3 baseline is local).
        expect(baseline.synthesis.providerCalls).toBe(0);
        expect(replay.synthesis.providerCalls).toBe(0);
        expect(baseline.observabilitySummary.modelCallCount).toBe(0);
        expect(replay.observabilitySummary.modelCallCount).toBe(0);

        // Identical phase sequence across the two runs.
        expect(phaseSequence(replay.events)).toEqual(phaseSequence(baseline.events));

        // Identical outputs: byte-for-byte identical normalized fingerprint (phase sequence + run
        // record + event payloads + synthesis). The replay output equals the recorded baseline.
        expect(stableJson(fingerprint(replay))).toBe(stableJson(fingerprint(baseline)));
      }),
      { numRuns: 100 },
    );
  }, 120_000);
});
