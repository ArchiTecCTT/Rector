import { describe, expect, it, beforeAll, afterAll } from "vitest";
import express from "express";
import http from "node:http";
import {
  createRunEventBroker,
  handleRunStream,
  createApp,
  type RunEventBroker,
  type RunEventListener,
  type SseRequestLike,
  type SseResponseLike,
} from "../src/api/server";
import { TaskManager } from "../src/thalamus/router";
import type { RectorStore } from "../src/store";
import type { RunEvent } from "../src/store/schemas";

/**
 * Unit tests for SSE stream edge cases (task 7.6).
 *
 * **Validates: Requirements 2.9, 2.11**
 *
 * Two narrow edge cases that the broader property tests (7.4 teardown, 7.5 redaction) do not pin
 * down on their own:
 *
 *  1. **Non-existent `runId` stream (Req 2.9).** Opening the stream for a run with no persisted
 *     events must replay NO events and fabricate NO payload: the handler emits zero `run-event`
 *     frames and zero `done`/`error` frames, sets exactly the SSE headers, stays subscribed for
 *     live events, and does NOT 404 or end. A later client disconnect then tears down cleanly.
 *
 *  2. **Streamed run-creation failure (Req 2.11).** A `POST .../messages?stream=1` whose run cannot
 *     be created (here, a non-existent conversation id — the design-endorsed "cannot create run"
 *     path) returns a redacted error, NOT a `202 { runId }`: no background run, no stream opened,
 *     and no secret in the error body.
 *
 * No API key, no network, no real timers/waits.
 */

// --- Fakes (mirrors the MockRes/MockReq pattern in chatStreaming.teardown/redaction tests) -----

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
    setIntervalImpl: () => {
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
 * `handleRunStream` makes). Every other method throws if touched.
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

/** Count SSE frames of a given event name across recorded chunks (one frame per write). */
function countFrames(chunks: string[], frameName: string): number {
  return chunks.filter((chunk) => chunk.startsWith(`event: ${frameName}\n`)).length;
}

// --- (1) Non-existent runId stream: no replay, no fabricated payload (Req 2.9) -----------------

describe("SSE stream edge case — non-existent runId (Req 2.9)", () => {
  const RUN_ID = "run-does-not-exist";

  it("replays no events, fabricates no payload, sets SSE headers, and stays subscribed for an empty/non-existent run", async () => {
    const res = createMockRes();
    const req = createMockReq();
    const { broker, activeCount } = createCountingBroker();
    const timers = createFakeTimers();
    // Empty snapshot models a runId with no persisted run or events.
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

    // Exactly the SSE headers are set (no 404, no error status — this is a stream, not a lookup).
    expect(res.headers["Content-Type"]).toBe("text/event-stream");
    expect(res.headers["Cache-Control"]).toBe("no-cache");
    expect(res.headers["Connection"]).toBe("keep-alive");

    // No run-event frame replayed and NO fabricated terminal/error frame written.
    expect(countFrames(res.chunks, "run-event")).toBe(0);
    expect(countFrames(res.chunks, "done")).toBe(0);
    expect(countFrames(res.chunks, "error")).toBe(0);
    // No fabricated payload at all: nothing with a `data:` line was written for the empty run.
    expect(res.chunks.some((chunk) => chunk.includes("data:"))).toBe(false);

    // Stays subscribed for live events and does NOT end (no terminal frame, no teardown yet).
    expect(activeCount()).toBe(1);
    expect(res.endCount).toBe(0);
    // Heartbeat armed (post-catch-up, non-terminal) and carries no run data when it fires.
    expect(timers.totalSet()).toBe(1);
    expect(timers.activeTimerCount()).toBe(1);
  });

  it("tears down cleanly when the client disconnects from a still-empty non-existent run stream", async () => {
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

    // Subscribed, no frames, heartbeat armed.
    expect(activeCount()).toBe(1);
    expect(res.endCount).toBe(0);

    req.triggerClose();

    // Single clean teardown: no fabricated frame, exactly one end, no listener/timer left behind.
    expect(countFrames(res.chunks, "run-event")).toBe(0);
    expect(countFrames(res.chunks, "done")).toBe(0);
    expect(countFrames(res.chunks, "error")).toBe(0);
    expect(res.endCount).toBe(1);
    expect(activeCount()).toBe(0);
    expect(timers.activeTimerCount()).toBe(0);
  });
});

// --- (2) Streamed run-creation failure: redacted error, no stream opened (Req 2.11) -----------

describe("streamed chat run-creation failure (Req 2.11)", () => {
  let app: express.Application;
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    app = createApp(new TaskManager());
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 3000;
        base = `http://localhost:${port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  async function api(path: string, opts?: RequestInit) {
    const res = await fetch(`${base}${path}`, {
      headers: { "Content-Type": "application/json", ...(opts?.headers ?? {}) },
      ...opts,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    return { status: res.status, body: text, data: data as Record<string, unknown> };
  }

  it("returns a redacted error and opens no stream (no 202 { runId }) when the run cannot be created", async () => {
    // A non-existent conversation id is the design-endorsed "cannot create run" path: the streamed
    // request can never reach a 202 { runId } because there is nothing to create the run against.
    // Embed a key-like string to assert the error body carries no secret.
    const secret = "sk-live-deadbeefcafef00d";
    const result = await api(`/api/chat/conversations/conv-nonexistent/messages?stream=1`, {
      method: "POST",
      body: JSON.stringify({ content: `please run with api_key=${secret}` }),
    });

    // Not a 202 streaming acknowledgement — a (client) error instead.
    expect(result.status).not.toBe(202);
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.status).toBeLessThan(500);

    // No runId/traceId was produced, so no SSE stream can be opened by the client.
    expect(result.data.runId).toBeUndefined();
    expect(result.data.traceId).toBeUndefined();

    // The body is an error payload, redaction-applied: no injected secret leaks into it.
    expect(typeof result.data.error).toBe("string");
    expect(result.body).not.toContain(secret);
  });

  it("does not open a stream for the failed streamed request (the GET stream is never reachable without a runId)", async () => {
    // Re-issue the failing streamed POST and confirm again that no runId is handed back. Without a
    // runId the client has nothing to open `GET /api/runs/:id/stream` against, so no stream exists.
    const result = await api(`/api/chat/conversations/conv-missing/messages?stream=1`, {
      method: "POST",
      body: JSON.stringify({ content: "hello" }),
    });

    expect(result.status).not.toBe(202);
    expect(result.data.runId).toBeUndefined();
    expect(result.data.traceId).toBeUndefined();
    expect(typeof result.data.error).toBe("string");
  });
});
