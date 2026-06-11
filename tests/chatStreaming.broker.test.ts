import { describe, expect, it } from "vitest";
import {
  createRunEventBroker,
  withEventBroadcast,
} from "../src/api/server";
import { InMemoryRectorStore } from "../src/store/inMemoryRectorStore";
import type { RectorStore } from "../src/store";
import type { CreateRunInput, Run, RunEvent } from "../src/store/schemas";

/**
 * Unit tests for the in-process `RunEventBroker` and the `withEventBroadcast` store
 * decorator (task 6.3).
 *
 * These are deterministic, example-based tests covering the three behaviors the
 * streaming layer (ORN-40) depends on:
 *
 *  1. Publish-after-persist ordering — `withEventBroadcast` publishes an event to the
 *     broker ONLY AFTER the underlying store has persisted (and redacted) it, and it
 *     publishes the value RETURNED by the store (the canonical persisted/redacted
 *     event), never the raw input argument.
 *  2. Subscriber delivery keyed by `runId` — a subscriber for run A receives only A's
 *     events and never another run's.
 *  3. Unsubscribe removes the listener — after calling the returned unsubscribe fn, the
 *     listener receives no further events.
 *
 * No API key, no network, fully in-process: the broker is a plain pub/sub and the store
 * is either a real `InMemoryRectorStore` or a small fake that records call ordering.
 *
 * _Requirements: 2.6_
 */

// A deterministic monotonic clock so created timestamps are stable across a test.
function fixedClock(): () => string {
  let tick = 0;
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  return () => new Date(base + tick++ * 1000).toISOString();
}

function baseRunInput(conversationId: string, overrides: Partial<CreateRunInput> = {}): CreateRunInput {
  return {
    conversationId,
    userMessageId: "umsg-1",
    status: "running",
    phase: "TRIAGE",
    route: "local",
    complexity: "simple",
    budget: {
      maxUsd: 2,
      maxInputTokens: 10_000,
      maxOutputTokens: 5_000,
      maxModelCalls: 8,
      maxRuntimeMs: 60_000,
      maxHealingAttempts: 2,
      allowedProviders: ["local"],
      approvalRequiredAboveUsd: 1,
    },
    costEstimate: { usd: 0.5 },
    tokenEstimate: { input: 100, output: 200 },
    traceId: "trace-1",
    attempts: 0,
    healingAttempts: 0,
    validationAttempts: 0,
    ...overrides,
  };
}

function buildEvent(id: string, runId: string, overrides: Partial<RunEvent> = {}): RunEvent {
  return {
    id,
    runId,
    type: "PHASE_CHANGED",
    phase: "PLANNING",
    payload: {},
    traceId: "trace-1",
    createdAt: "2026-06-03T00:00:00.000Z",
    ...overrides,
  } as RunEvent;
}

// Create a conversation + run so the wrapped store has a real run to append events against.
async function seedRun(store: RectorStore, overrides: Partial<CreateRunInput> = {}): Promise<Run> {
  const conversation = await store.createConversation({
    title: "broker",
    workspaceId: "ws-1",
    retentionPolicy: "default",
  });
  return store.createRun(baseRunInput(conversation.id, overrides));
}

// A method that should never be exercised by these tests; calling it is a test bug.
function notImplemented(name: string): never {
  throw new Error(`fake store: ${name} should not be called in this test`);
}

/**
 * Build a minimal fake `RectorStore` whose `appendEvent` is supplied by the test. Every
 * other method throws if touched, so a test that relies on the fake proves it exercises
 * only `appendEvent`. This lets a test control persist ordering and return a normalized
 * (redacted) event that differs from the input, to prove the decorator publishes the
 * RETURNED value rather than the input.
 */
function makeFakeStore(appendEvent: RectorStore["appendEvent"]): RectorStore {
  return {
    createConversation: () => notImplemented("createConversation"),
    getConversation: () => notImplemented("getConversation"),
    listConversations: () => notImplemented("listConversations"),
    updateConversation: () => notImplemented("updateConversation"),
    deleteConversation: () => notImplemented("deleteConversation"),

    createMessage: () => notImplemented("createMessage"),
    getMessage: () => notImplemented("getMessage"),
    listMessages: () => notImplemented("listMessages"),
    updateMessage: () => notImplemented("updateMessage"),
    deleteMessage: () => notImplemented("deleteMessage"),

    createRun: () => notImplemented("createRun"),
    getRun: () => notImplemented("getRun"),
    listRuns: () => notImplemented("listRuns"),
    updateRun: () => notImplemented("updateRun"),
    deleteRun: () => notImplemented("deleteRun"),
    commitRunTransition: () => notImplemented("commitRunTransition"),

    appendEvent,
    getEvent: () => notImplemented("getEvent"),
    listEvents: () => notImplemented("listEvents"),
    deleteEvent: () => notImplemented("deleteEvent"),

    createArtifact: () => notImplemented("createArtifact"),
    getArtifact: () => notImplemented("getArtifact"),
    listArtifacts: () => notImplemented("listArtifacts"),
    updateArtifact: () => notImplemented("updateArtifact"),
    deleteArtifact: () => notImplemented("deleteArtifact"),
  };
}

describe("RunEventBroker + withEventBroadcast (task 6.3)", () => {
  // --- 1. Publish-after-persist ordering, and publish the RETURNED value ----

  describe("publish-after-persist ordering", () => {
    it("publishes only after the store has persisted the event, and publishes the persisted/redacted RETURN value (not the input)", async () => {
      const order: string[] = [];

      // The persisted (canonical, redacted) event the store returns. It deliberately
      // differs from the input below so we can prove the decorator broadcasts THIS, not
      // the raw input argument.
      const persistedEvent = buildEvent("evt-1", "run-A", {
        payload: { redacted: true },
      });

      const fakeStore = makeFakeStore(async (_input) => {
        order.push("persist-start");
        // Defer resolution to a later microtask so that, if the decorator published
        // before awaiting persistence, "published" would appear before "persisted".
        await Promise.resolve();
        order.push("persisted");
        return persistedEvent;
      });

      const broker = createRunEventBroker();
      const decorated = withEventBroadcast(fakeStore, broker);

      let received: RunEvent | undefined;
      broker.subscribe("run-A", (event) => {
        order.push("published");
        received = event;
      });

      // The raw input carries a different (pre-redaction) payload than what the store returns.
      const input = buildEvent("evt-1", "run-A", { payload: { secret: "sk-RAW-INPUT" } });
      const returned = await decorated.appendEvent(input);

      // Publish happened strictly AFTER the persist resolved.
      expect(order).toEqual(["persist-start", "persisted", "published"]);

      // The decorator returns and publishes the store's canonical persisted event...
      expect(returned).toBe(persistedEvent);
      expect(received).toBe(persistedEvent);
      // ...not the raw input argument.
      expect(received).not.toBe(input);
      expect(received?.payload).toEqual({ redacted: true });
    });

    it("publishes nothing when the underlying store throws (no persist => no broadcast)", async () => {
      const fakeStore = makeFakeStore(async () => {
        throw new Error("persist failed");
      });

      const broker = createRunEventBroker();
      const decorated = withEventBroadcast(fakeStore, broker);

      const received: RunEvent[] = [];
      broker.subscribe("run-A", (event) => received.push(event));

      await expect(decorated.appendEvent(buildEvent("evt-1", "run-A"))).rejects.toThrow(/persist failed/);

      expect(received).toEqual([]);
    });
  });

  // --- 2. Subscriber delivery keyed by runId -------------------------------

  describe("subscriber delivery keyed by runId", () => {
    it("a subscriber for run A receives only A's events, not another run's", async () => {
      const store = new InMemoryRectorStore({ now: fixedClock() });
      const broker = createRunEventBroker();
      const decorated = withEventBroadcast(store, broker);

      const runA = await seedRun(decorated, { userMessageId: "umsg-a" });
      const runB = await seedRun(decorated, { userMessageId: "umsg-b" });

      const receivedByA: RunEvent[] = [];
      broker.subscribe(runA.id, (event) => receivedByA.push(event));

      const aEvent = await decorated.appendEvent(buildEvent("evt-a1", runA.id));
      await decorated.appendEvent(buildEvent("evt-b1", runB.id));
      const aEvent2 = await decorated.appendEvent(buildEvent("evt-a2", runA.id, { phase: "EXECUTING" }));

      // Only run A's two events were delivered, in order; run B's event never reached A's listener.
      expect(receivedByA).toEqual([aEvent, aEvent2]);
      expect(receivedByA.every((event) => event.runId === runA.id)).toBe(true);
      expect(receivedByA.some((event) => event.id === "evt-b1")).toBe(false);
    });
  });

  // --- 3. Unsubscribe removes the listener ---------------------------------

  describe("unsubscribe removes the listener", () => {
    it("after calling the returned unsubscribe fn, the listener receives no further events", async () => {
      const store = new InMemoryRectorStore({ now: fixedClock() });
      const broker = createRunEventBroker();
      const decorated = withEventBroadcast(store, broker);

      const run = await seedRun(decorated);

      const received: RunEvent[] = [];
      const unsubscribe = broker.subscribe(run.id, (event) => received.push(event));

      const first = await decorated.appendEvent(buildEvent("evt-1", run.id));
      expect(received).toEqual([first]);

      unsubscribe();

      // Further appends are persisted but never delivered to the removed listener.
      await decorated.appendEvent(buildEvent("evt-2", run.id, { phase: "EXECUTING" }));
      await decorated.appendEvent(buildEvent("evt-3", run.id, { phase: "VALIDATING" }));

      expect(received).toEqual([first]);
    });
  });
});
