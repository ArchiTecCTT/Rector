/**
 * Task 13.6 — Local-mode run determinism property test.
 *
 * Feature: cloud-capable-transition, Property 35: Local-mode runs are deterministic
 *
 * **Property 35: Local-mode runs are deterministic**
 * **Validates: Requirements 9.7**
 *
 * Req 9.7: WHEN the same Local_Mode run is executed twice with identical inputs, THE Rector_Server
 * SHALL produce user-facing output deep-equal across the two executions (determinism property).
 *
 * Local_Mode is the provider-free deterministic regression baseline (`ORCHESTRATOR_MODE=local`),
 * driven here through the live `chatRunner` local-mode dispatch (`runChat(..., { mode: "local" })`)
 * over the in-memory store — exactly as the chat endpoint dispatches a local run. The whole pipeline
 * (planner → skeptic → crucible → DAG → executor → validation → synthesis) executes with no router,
 * no API key, and no network/sandbox boundary.
 *
 * The property quantifies over an arbitrary user prompt (spanning every triage route) and asserts
 * that two independent executions of the identical input produce deep-equal user-facing output:
 *
 *   - **User-facing output** is the `BrainstemSynthesis` the run returns (status, route, traceId,
 *     evidence, `providerCalls`, and the `response` text rendered to the user). Two runs over the
 *     same input must yield a byte-identical `response` and a deep-equal synthesis object.
 *   - **Provider-free** (the local invariant Req 9.7 rests on): `synthesis.providerCalls === 0` and
 *     the observability summary records `modelCallCount === 0` for both runs.
 *   - **Whole-run determinism**: the persisted run record, the ordered phase/event-type sequence,
 *     and every event payload are byte-identical across the two runs (a stronger check that subsumes
 *     the user-facing-output guarantee).
 *
 * To make "identical inputs" reproducible, every source of incidental non-determinism that the
 * local-mode entry point CAN pin is pinned with deterministic doubles:
 *
 *   - a fresh `InMemoryRectorStore` per run with an injected monotonic, counter-based string clock
 *     (stable entity ids `conv-1`/`msg-1`/`run-1` and stable created/updated timestamps), and
 *   - an `InMemoryObservabilityTrace` with a fixed `traceId`, a counter-based span-id factory, and a
 *     monotonic `Date` clock (stable span ids and durations).
 *
 * A few timestamps/ids are minted internally by sub-components from wall-clock `Date` /
 * `crypto.randomUUID()` that the local-mode entry point threads no clock into (each run event's `id`
 * and `createdAt`, plus ISO timestamps embedded in payloads such as `crucibleDecision.createdAt`,
 * `compiledDag.createdAt`, and execution node `startedAt`/`completedAt`). These incidental values are
 * NOT part of the user-facing output: the event `id`/`createdAt` are stripped and every ISO-8601
 * timestamp string is normalized to a fixed placeholder before the byte-for-byte comparison. The
 * user-facing synthesis is additionally asserted deep-equal directly.
 *
 * Everything is in-memory and provider-free: no API key is read and zero provider/network calls
 * occur (asserted via `synthesis.providerCalls === 0` and `modelCallCount === 0`).
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { runChat, type ChatRunArgs, type ChatRunResult } from "../src/orchestration/chatRunner";
import { InMemoryRectorStore } from "../src/store/inMemoryRectorStore";
import { triageUserMessage } from "../src/orchestration/triage";
import { createInMemoryObservabilityTrace } from "../src/observability";
import type { RunEvent } from "../src/store/schemas";
import { arbPrompt, makeContextPack } from "./support/byokArbitraries";

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

/** A deterministic, counter-based observability span-id factory (stable span ids across runs). */
function fixedSpanIdFactory(): () => string {
  let counter = 0;
  return () => `span-${++counter}`;
}

/** The fixed trace id both runs share so the synthesis/observability output is byte-stable. */
const FIXED_TRACE_ID = "trace-prop35-local-determinism";

type LocalModeOutcome = ChatRunResult & { events: RunEvent[] };

/**
 * Executes a single provider-free Local_Mode chat run for `prompt` over a freshly constructed,
 * fully-deterministic environment (in-memory store + observability with pinned clocks/ids), exactly
 * as the chat endpoint dispatches local mode. Returns the run result plus the persisted run events
 * in insertion order.
 */
async function runLocalModeOnce(prompt: string): Promise<LocalModeOutcome> {
  const store = new InMemoryRectorStore({ now: fixedStringClock() });
  const conversation = await store.createConversation({
    title: "prop35 local-mode determinism",
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

/** The ordered phase/event-type sequence — part of the deterministic run output. */
function phaseSequence(events: RunEvent[]): string[] {
  return events.map((event) => `${event.type}:${event.phase}`);
}

/**
 * A normalized, comparable fingerprint of a Local_Mode run: the persisted run record, the ordered
 * phase sequence, every event payload (with only the incidentally-volatile `id`/`createdAt`
 * stripped), and the user-facing synthesis. Two runs over the same input must produce an identical
 * fingerprint.
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
 * the local-mode entry point cannot pin) are not part of the deterministic user-facing output the
 * property compares, so they are collapsed; all other content is preserved verbatim.
 */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, val) =>
    typeof val === "string" && ISO_TIMESTAMP.test(val) ? "<timestamp>" : val,
  );
}

describe("Feature: cloud-capable-transition, Property 35: Local-mode runs are deterministic", () => {
  // Validates: Requirements 9.7.
  it("two Local_Mode runs over the same input produce deep-equal user-facing output", async () => {
    await fc.assert(
      fc.asyncProperty(arbPrompt(), async (prompt) => {
        // Two independent Local_Mode executions of the identical input.
        const first = await runLocalModeOnce(prompt);
        const second = await runLocalModeOnce(prompt);

        // Provider-free (the invariant Req 9.7 rests on): neither run makes any provider/network call.
        expect(first.synthesis.providerCalls).toBe(0);
        expect(second.synthesis.providerCalls).toBe(0);
        expect(first.observabilitySummary.modelCallCount).toBe(0);
        expect(second.observabilitySummary.modelCallCount).toBe(0);

        // Req 9.7: the user-facing output (the synthesized assistant message) is deep-equal across
        // the two executions — byte-identical `response` text and an otherwise deep-equal synthesis.
        expect(second.synthesis.response).toBe(first.synthesis.response);
        expect(second.synthesis).toEqual(first.synthesis);

        // Identical phase sequence across the two runs.
        expect(phaseSequence(second.events)).toEqual(phaseSequence(first.events));

        // Whole-run determinism: byte-for-byte identical normalized fingerprint (run record + phase
        // sequence + event payloads + synthesis + observability summary).
        expect(stableJson(fingerprint(second))).toBe(stableJson(fingerprint(first)));
      }),
      { numRuns: 100 },
    );
  }, 120_000);
});
