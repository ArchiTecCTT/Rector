import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  createRunEventBroker,
  handleRunStream,
  serializeSseFrame,
  withEventBroadcast,
  type SseFrame,
  type SseRequestLike,
  type SseResponseLike,
} from "../src/api/server";
import { SqlRectorStore, createSqliteDriver } from "../src/store/sqlRectorStore";
import { redactSecrets, redactString } from "../src/security/redaction";
import type { RunEvent } from "../src/store/schemas";
import {
  RUN_PHASES,
  TERMINAL_RUN_PHASES,
  isTerminalRunPhase,
  type RunPhase,
  type TerminalRunPhase,
} from "../src/protocol/phases";

/**
 * Property test for no secret in any SSE frame (task 7.5).
 *
 * **Property 3 (streaming boundary): No secret appears in any SSE frame.**
 * **Validates: Requirements 2.5**
 *
 * The streaming surface (`handleRunStream`, the injectable core of `GET /api/runs/:id/stream`)
 * carries ONLY persisted, redaction-applied data. Run events are redacted at persistence time:
 * `transitionRun`/`runEvent` (see `src/orchestration/runStateMachine.ts`) run every event payload
 * through `redactSecrets` BEFORE `appendEvent`/`commitRunTransition` persist it, and the SSE
 * `error` frame message passes through `redactString` at construction time. So a secret injected
 * upstream must not survive into any frame, because frames replay/stream only the persisted,
 * already-redacted events.
 *
 * This test drives that boundary against a REAL persistent store (`SqlRectorStore` over an
 * in-memory SQLite driver — no cloud account, no network) wrapped with `withEventBroadcast`:
 *
 *  - it injects a distinctive key-like secret into each event payload using carrier shapes the
 *    project's redactor actually targets (sensitive keys, `Bearer`/`Basic` headers, inline
 *    `api_key=`/`token=` pairs, and credential URIs), redacting the payload exactly as the run
 *    state machine does before persistence,
 *  - it persists a batch of events FIRST so the stream replays them as catch-up `run-event`
 *    frames, then — once the stream is live — appends more events (including a terminal one) so
 *    they stream live as `run-event` frames and a closing `done` frame,
 *  - it captures every written chunk via a mock `res` and asserts the injected secret substring is
 *    ABSENT from every replayed AND live frame.
 *
 * A secondary property covers the `error` frame redaction invariant directly through
 * `serializeSseFrame`, since `handleRunStream` itself never emits an error frame (its read-error
 * path tears down silently).
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
      for (const listener of [...closeListeners]) listener();
    },
  };
}

/** Injectable timer fakes so the 15s heartbeat never touches a real clock. */
function createFakeTimers(): {
  setIntervalImpl: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalImpl: (handle: ReturnType<typeof setInterval>) => void;
} {
  let nextId = 1;
  const live = new Set<number>();
  return {
    setIntervalImpl: () => {
      const id = nextId++;
      live.add(id);
      return id as unknown as ReturnType<typeof setInterval>;
    },
    clearIntervalImpl: (handle) => {
      live.delete(handle as unknown as number);
    },
  };
}

// --- Secret carriers --------------------------------------------------------

/**
 * A distinctive, delimiter-free key-like secret. Hex keeps it free of whitespace, `,`, `;`, `&`,
 * `/`, and `@`, so the redaction patterns below remove it wholly (never leaving a partial
 * substring) regardless of the carrier it is embedded in.
 */
const hexCharArb = fc.constantFrom(..."0123456789abcdef".split(""));
const secretArb = fc
  .array(hexCharArb, { minLength: 12, maxLength: 40 })
  .map((chars) => `sk-live-${chars.join("")}`);

/**
 * Object payload carriers whose secret the project's `redactSecrets` is guaranteed to target:
 *  - sensitive keys (`authorization`/`apiKey`/`token`/`password`/`secret`) => whole value redacted,
 *  - `Bearer`/`Basic` header strings and inline `api_key=`/`token=` pairs => `redactString` pattern,
 *  - credential URIs under URI keys (`dsn`/`url`) => userinfo stripped by `redactString`.
 */
const objectCarriers: Array<(secret: string) => Record<string, unknown>> = [
  (s) => ({ authorization: s }),
  (s) => ({ apiKey: s }),
  (s) => ({ token: s }),
  (s) => ({ password: s }),
  (s) => ({ secret: s }),
  (s) => ({ note: `Bearer ${s}` }),
  (s) => ({ note: `Basic ${s}` }),
  (s) => ({ detail: `api_key=${s}` }),
  (s) => ({ detail: `token=${s}` }),
  (s) => ({ dsn: `mysql://admin:${s}@db.example.com:3306/app` }),
  (s) => ({ url: `https://svc:${s}@api.example.com/v1` }),
];

/** String carriers for the `error` frame message, all recognized by `redactString`. */
const stringCarriers: Array<(secret: string) => string> = [
  (s) => `Bearer ${s}`,
  (s) => `Basic ${s}`,
  (s) => `request rejected: api_key=${s}`,
  (s) => `token=${s} was refused`,
  (s) => `connect mysql://admin:${s}@db.example.com failed`,
];

const NON_TERMINAL_PHASES: RunPhase[] = RUN_PHASES.filter((phase) => !isTerminalRunPhase(phase));

/** Count SSE frames of a given event name across recorded chunks (one frame per write). */
function countFrames(chunks: string[], frameName: string): number {
  return chunks.filter((chunk) => chunk.startsWith(`event: ${frameName}\n`)).length;
}

const RUN_ID = "run-redaction";

// --- (a) run-event frames: replay + live carry no secret -------------------

describe("no secret in SSE run-event frames (Property 3, Req 2.5)", () => {
  it("never leaks an injected secret into any replayed or live run-event frame", async () => {
    await fc.assert(
      fc.asyncProperty(
        secretArb,
        fc.array(fc.nat(objectCarriers.length - 1), { minLength: 1, maxLength: 5 }),
        fc.array(fc.nat(objectCarriers.length - 1), { minLength: 1, maxLength: 5 }),
        fc.constantFrom(...(TERMINAL_RUN_PHASES as readonly TerminalRunPhase[])),
        async (secret, replayCarriers, liveCarriers, terminalPhase) => {
          // Real persistent store (in-memory SQLite, no cloud/network), broadcast-wrapped so live
          // appends publish to the broker the stream subscribes to.
          const driver = createSqliteDriver({ path: ":memory:" });
          try {
            const base = new SqlRectorStore({ driver, now: () => "2026-06-03T00:00:00.000Z" });
            const broker = createRunEventBroker();
            const store = withEventBroadcast(base, broker);

            let seq = 0;
            // Mirror transitionRun/runEvent: redact the payload at persistence time.
            const makeEvent = (carrierIndex: number, phase: RunPhase): RunEvent => {
              const id = `evt-${seq}`;
              seq += 1;
              return {
                id,
                runId: RUN_ID,
                type: "PHASE_CHANGED",
                phase,
                payload: redactSecrets(objectCarriers[carrierIndex](secret)),
                traceId: "trace-1",
                redactionState: "redacted",
                createdAt: "2026-06-03T00:00:00.000Z",
              };
            };

            // Seed catch-up events FIRST (all non-terminal) so the stream replays them.
            for (let i = 0; i < replayCarriers.length; i += 1) {
              const phase = NON_TERMINAL_PHASES[i % NON_TERMINAL_PHASES.length];
              await store.appendEvent(makeEvent(replayCarriers[i], phase));
            }

            const res = createMockRes();
            const req = createMockReq();
            const timers = createFakeTimers();

            // Open the stream: subscribes, replays the seeded snapshot, then goes live.
            await handleRunStream({
              runId: RUN_ID,
              req,
              res,
              store,
              broker,
              setIntervalImpl: timers.setIntervalImpl,
              clearIntervalImpl: timers.clearIntervalImpl,
            });

            // Live (non-terminal) events stream as published.
            for (let i = 0; i < liveCarriers.length; i += 1) {
              const phase = NON_TERMINAL_PHASES[i % NON_TERMINAL_PHASES.length];
              await store.appendEvent(makeEvent(liveCarriers[i], phase));
            }
            // A terminal live event closes the stream with a single `done` frame.
            await store.appendEvent(makeEvent(liveCarriers[0], terminalPhase));

            // The injected secret must be absent from EVERY written chunk (replay + live + done).
            expect(res.chunks.length).toBeGreaterThan(0);
            for (const chunk of res.chunks) {
              expect(chunk).not.toContain(secret);
            }
            expect(res.chunks.join("")).not.toContain(secret);

            // Sanity: we actually exercised both replay and live run-event frames and the terminal frame.
            expect(countFrames(res.chunks, "run-event")).toBe(
              replayCarriers.length + liveCarriers.length + 1
            );
            expect(countFrames(res.chunks, "done")).toBe(1);
          } finally {
            driver.close();
          }
        }
      ),
      { numRuns: 60 }
    );
  });
});

// --- (b) error frame: redacted message carries no secret -------------------

describe("no secret in SSE error frame (Property 3, Req 2.5)", () => {
  it("redacts a secret embedded in an error frame message before it is serialized", () => {
    fc.assert(
      fc.property(secretArb, fc.nat(stringCarriers.length - 1), (secret, carrierIndex) => {
        const rawMessage = stringCarriers[carrierIndex](secret);
        // The design mandates `error.message` passes through `redactString` at construction time.
        const frame: SseFrame = { type: "error", runId: RUN_ID, message: redactString(rawMessage) };
        const wire = serializeSseFrame(frame);
        expect(wire).not.toContain(secret);
      }),
      { numRuns: 100 }
    );
  });
});
