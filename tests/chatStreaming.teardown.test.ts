import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  createRunEventBroker,
  handleRunStream,
  type RunEventBroker,
  type RunEventListener,
  type SseRequestLike,
  type SseResponseLike,
} from "../src/api/server";
import type { RectorStore } from "../src/store";
import type { RunEvent } from "../src/store/schemas";
import {
  RUN_PHASES,
  TERMINAL_RUN_PHASES,
  isTerminalRunPhase,
  type RunPhase,
  type TerminalRunPhase,
} from "../src/protocol/phases";

/**
 * Property test for clean SSE teardown (task 7.4).
 *
 * **Property 4: The SSE stream always terminates (closes cleanly) on completion or error.**
 * **Validates: Requirements 2.3, 2.4**
 *
 * `handleRunStream` (the injectable core of `GET /api/runs/:id/stream`) is driven with a fully
 * faked transport so no real socket, timer, or network is involved:
 *
 *  - a mock `res` records every written chunk (so terminal frames can be counted/parsed) and how
 *    many times `end()` was called,
 *  - a mock `req` is an EventEmitter-like that lets a test fire the client `"close"` event,
 *  - the broker is wrapped so the number of *active* subscriptions (subscribe minus unsubscribe) is
 *    observable — the catch-up→live subscription must balance to ZERO after teardown,
 *  - `setIntervalImpl`/`clearIntervalImpl` are injected fakes that track live timers, so we can
 *    assert the 15s heartbeat interval was cleared and no interval lingers.
 *
 * For each terminal route — (a) a run reaching every Terminal_Phase, (b) an error mid-stream, and
 * (c) a client disconnect — we assert the four teardown invariants:
 *   1. exactly the expected single terminal frame is written (one `done` frame for a terminal
 *      phase; for the read-error/disconnect routes this handler writes no terminal frame, matching
 *      the design's "single clean teardown" that just unsubscribes, clears the timer, and ends),
 *   2. exactly ONE `res.end()` call,
 *   3. ZERO remaining broker subscribers,
 *   4. ZERO lingering interval timers (the heartbeat was cleared).
 *
 * No API key, no network, no real timers/waits.
 */

// --- Fakes -----------------------------------------------------------------

interface MockRes extends SseResponseLike {
  chunks: string[];
  endCount: number;
  headers: Record<string, string>;
}

function createMockRes(): MockRes {
  const res: MockRes = {
    chunks: [],
    endCount: 0,
    headers: {},
    setHeader(name, value) {
      res.headers[name] = value;
    },
    flushHeaders() {
      /* no-op for the fake transport */
    },
    write(chunk) {
      res.chunks.push(chunk);
    },
    end() {
      res.endCount += 1;
    },
  };
  return res;
}

interface MockReq extends SseRequestLike {
  triggerClose(): void;
}

function createMockReq(): MockReq {
  const closeListeners: Array<() => void> = [];
  return {
    on(event, listener) {
      if (event === "close") closeListeners.push(listener);
    },
    triggerClose() {
      // Snapshot so a listener that mutates the list mid-dispatch cannot disrupt this pass.
      for (const listener of [...closeListeners]) listener();
    },
  };
}

/** Wrap a real broker so the count of active subscriptions is observable for the test. */
function createCountingBroker(): { broker: RunEventBroker; activeCount: () => number } {
  const inner = createRunEventBroker();
  let active = 0;
  const broker: RunEventBroker = {
    publish: (runId, event) => inner.publish(runId, event),
    publishRedacted: (runId, event) => inner.publishRedacted(runId, event),
    subscribe: (runId: string, listener: RunEventListener) => {
      active += 1;
      const unsubscribe = inner.subscribe(runId, listener);
      let removed = false;
      return () => {
        if (!removed) {
          removed = true;
          active -= 1;
        }
        unsubscribe();
      };
    },
  };
  return { broker, activeCount: () => active };
}

/** Injectable timer fakes that track live intervals (no real clock). */
function createFakeTimers(): {
  setIntervalImpl: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalImpl: (handle: ReturnType<typeof setInterval>) => void;
  activeTimerCount: () => number;
  totalSet: () => number;
} {
  let nextId = 1;
  let setCount = 0;
  const live = new Set<number>();
  return {
    setIntervalImpl: (_handler, _ms) => {
      const id = nextId++;
      setCount += 1;
      live.add(id);
      return id as unknown as ReturnType<typeof setInterval>;
    },
    clearIntervalImpl: (handle) => {
      live.delete(handle as unknown as number);
    },
    activeTimerCount: () => live.size,
    totalSet: () => setCount,
  };
}

/** A method that should never be exercised by these tests; calling it is a test bug. */
function notImplemented(name: string): never {
  throw new Error(`fake store: ${name} should not be called in this test`);
}

/**
 * A minimal fake `RectorStore` whose only live method is `listEvents` (the sole store call
 * `handleRunStream` makes). `listEvents` is supplied per test so it can return a catch-up snapshot
 * or throw to simulate a read error. Every other method throws if touched.
 */
function makeStreamStore(listEvents: RectorStore["listEvents"]): RectorStore {
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

    appendEvent: () => notImplemented("appendEvent"),
    getEvent: () => notImplemented("getEvent"),
    listEvents,
    deleteEvent: () => notImplemented("deleteEvent"),

    createArtifact: () => notImplemented("createArtifact"),
    getArtifact: () => notImplemented("getArtifact"),
    listArtifacts: () => notImplemented("listArtifacts"),
    updateArtifact: () => notImplemented("updateArtifact"),
    deleteArtifact: () => notImplemented("deleteArtifact"),
  };
}

// --- Helpers ----------------------------------------------------------------

const NON_TERMINAL_PHASES: RunPhase[] = RUN_PHASES.filter((phase) => !isTerminalRunPhase(phase));

function buildEvent(id: string, runId: string, phase: RunPhase): RunEvent {
  return {
    id,
    runId,
    type: "PHASE_CHANGED",
    phase,
    payload: {},
    traceId: "trace-1",
    createdAt: "2026-06-03T00:00:00.000Z",
  };
}

/** Count SSE frames of a given event name across recorded chunks (one frame per write). */
function countFrames(chunks: string[], frameName: string): number {
  return chunks.filter((chunk) => chunk.startsWith(`event: ${frameName}\n`)).length;
}

/** Extract the JSON `data:` payload of the first frame matching `frameName`, if any. */
function firstFrameData(chunks: string[], frameName: string): any | undefined {
  const chunk = chunks.find((c) => c.startsWith(`event: ${frameName}\n`));
  if (!chunk) return undefined;
  const match = chunk.match(/\ndata: (.*)\n\n$/s);
  return match ? JSON.parse(match[1]) : undefined;
}

const RUN_ID = "run-teardown";

// --- (a) Terminal phase: exactly one `done` frame, clean teardown ----------

describe("clean SSE teardown — terminal phase (Property 4, Req 2.3)", () => {
  it("emits exactly one `done` frame and tears down cleanly for every Terminal_Phase reached live", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...(TERMINAL_RUN_PHASES as readonly TerminalRunPhase[])),
        fc.array(fc.constantFrom(...NON_TERMINAL_PHASES), { maxLength: 6 }),
        async (terminalPhase, prefixPhases) => {
          const res = createMockRes();
          const req = createMockReq();
          const { broker, activeCount } = createCountingBroker();
          const timers = createFakeTimers();
          // Empty catch-up snapshot: the run reaches its terminal phase via LIVE events, so the
          // heartbeat is armed (post-catch-up) and must then be cleared by teardown.
          const store = makeStreamStore(async () => []);

          await handleRunStream({
            runId: RUN_ID,
            req,
            res,
            store,
            broker,
            setIntervalImpl: timers.setIntervalImpl,
            clearIntervalImpl: timers.clearIntervalImpl,
          });

          // Heartbeat armed after catch-up completed without a terminal event.
          expect(timers.totalSet()).toBe(1);
          expect(timers.activeTimerCount()).toBe(1);
          expect(activeCount()).toBe(1);

          // Publish non-terminal live events, then the single terminal event.
          prefixPhases.forEach((phase, index) => {
            broker.publish(RUN_ID, buildEvent(`evt-${index}`, RUN_ID, phase));
          });
          broker.publish(RUN_ID, buildEvent("evt-terminal", RUN_ID, terminalPhase));

          // 1. Exactly one terminal `done` frame carrying that phase, and no `error` frame.
          expect(countFrames(res.chunks, "done")).toBe(1);
          expect(countFrames(res.chunks, "error")).toBe(0);
          expect(firstFrameData(res.chunks, "done")).toMatchObject({
            type: "done",
            runId: RUN_ID,
            phase: terminalPhase,
          });
          // 2. Exactly one res.end().
          expect(res.endCount).toBe(1);
          // 3. Zero remaining subscribers.
          expect(activeCount()).toBe(0);
          // 4. Heartbeat cleared, no lingering interval.
          expect(timers.activeTimerCount()).toBe(0);

          // Idempotent: a late publish or client close after teardown changes nothing.
          broker.publish(RUN_ID, buildEvent("evt-late", RUN_ID, "DONE"));
          req.triggerClose();
          expect(countFrames(res.chunks, "done")).toBe(1);
          expect(res.endCount).toBe(1);
          expect(activeCount()).toBe(0);
          expect(timers.activeTimerCount()).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("emits exactly one `done` frame when the terminal phase is observed during catch-up replay", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...(TERMINAL_RUN_PHASES as readonly TerminalRunPhase[])),
        fc.array(fc.constantFrom(...NON_TERMINAL_PHASES), { maxLength: 6 }),
        async (terminalPhase, prefixPhases) => {
          const res = createMockRes();
          const req = createMockReq();
          const { broker, activeCount } = createCountingBroker();
          const timers = createFakeTimers();
          // Persisted snapshot whose final event is terminal: teardown happens DURING catch-up,
          // before the heartbeat is ever armed, so no interval is created or left lingering.
          const persisted: RunEvent[] = [
            ...prefixPhases.map((phase, index) => buildEvent(`evt-${index}`, RUN_ID, phase)),
            buildEvent("evt-terminal", RUN_ID, terminalPhase),
          ];
          const store = makeStreamStore(async () => persisted);

          await handleRunStream({
            runId: RUN_ID,
            req,
            res,
            store,
            broker,
            setIntervalImpl: timers.setIntervalImpl,
            clearIntervalImpl: timers.clearIntervalImpl,
          });

          expect(countFrames(res.chunks, "done")).toBe(1);
          expect(countFrames(res.chunks, "error")).toBe(0);
          expect(firstFrameData(res.chunks, "done")).toMatchObject({ phase: terminalPhase });
          expect(res.endCount).toBe(1);
          expect(activeCount()).toBe(0);
          // Heartbeat never armed (torn down mid-catch-up) and nothing lingers.
          expect(timers.totalSet()).toBe(0);
          expect(timers.activeTimerCount()).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// --- (b) Error mid-stream: clean teardown, no lingering listener/timer -----

describe("clean SSE teardown — error mid-stream (Property 4, Req 2.4)", () => {
  it("tears down cleanly with one res.end(), zero subscribers, and no timer when the catch-up read errors", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 40 }), async (errorMessage) => {
        const res = createMockRes();
        const req = createMockReq();
        const { broker, activeCount } = createCountingBroker();
        const timers = createFakeTimers();
        // Simulate a run/transport error surfacing through the store read mid-stream.
        const store = makeStreamStore(async () => {
          throw new Error(errorMessage);
        });

        await handleRunStream({
          runId: RUN_ID,
          req,
          res,
          store,
          broker,
          setIntervalImpl: timers.setIntervalImpl,
          clearIntervalImpl: timers.clearIntervalImpl,
        });

        // The read-error path performs a single clean teardown: no fabricated terminal frame,
        // exactly one res.end(), the subscription removed, and no heartbeat ever armed.
        expect(countFrames(res.chunks, "done")).toBe(0);
        expect(countFrames(res.chunks, "error")).toBe(0);
        expect(res.endCount).toBe(1);
        expect(activeCount()).toBe(0);
        expect(timers.activeTimerCount()).toBe(0);

        // A client close after the error teardown is a no-op (still exactly one end).
        req.triggerClose();
        expect(res.endCount).toBe(1);
        expect(activeCount()).toBe(0);
      }),
      { numRuns: 50 }
    );
  });
});

// --- (c) Client disconnect: single clean teardown --------------------------

describe("clean SSE teardown — client disconnect (Property 4, Req 2.4)", () => {
  it("on disconnect before a terminal phase: unsubscribes, clears the heartbeat, ends once, leaves no listener or timer", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(...NON_TERMINAL_PHASES), { maxLength: 6 }),
        async (prefixPhases) => {
          const res = createMockRes();
          const req = createMockReq();
          const { broker, activeCount } = createCountingBroker();
          const timers = createFakeTimers();
          const store = makeStreamStore(async () => []);

          await handleRunStream({
            runId: RUN_ID,
            req,
            res,
            store,
            broker,
            setIntervalImpl: timers.setIntervalImpl,
            clearIntervalImpl: timers.clearIntervalImpl,
          });

          // Some live non-terminal activity, then the client disconnects before any terminal phase.
          prefixPhases.forEach((phase, index) => {
            broker.publish(RUN_ID, buildEvent(`evt-${index}`, RUN_ID, phase));
          });

          // Heartbeat was armed while the stream stayed open.
          expect(timers.totalSet()).toBe(1);
          expect(timers.activeTimerCount()).toBe(1);
          expect(activeCount()).toBe(1);

          req.triggerClose();

          // Single clean teardown: no terminal frame fabricated, exactly one end, no leaks.
          expect(countFrames(res.chunks, "done")).toBe(0);
          expect(countFrames(res.chunks, "error")).toBe(0);
          expect(res.endCount).toBe(1);
          expect(activeCount()).toBe(0);
          expect(timers.activeTimerCount()).toBe(0);

          // Idempotent: a second close (or a late publish) does not re-end or re-subscribe.
          req.triggerClose();
          broker.publish(RUN_ID, buildEvent("evt-late", RUN_ID, "EXECUTING"));
          expect(res.endCount).toBe(1);
          expect(activeCount()).toBe(0);
          expect(timers.activeTimerCount()).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });
});
