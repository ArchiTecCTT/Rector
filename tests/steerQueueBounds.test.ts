import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createRunControlState,
  enqueueSteer,
  drainSteer,
  MAX_STEER_QUEUE_SIZE,
} from "../src/orchestration/runControl.js";

describe("Bounded steerQueue (M24)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exports MAX_STEER_QUEUE_SIZE as 20", () => {
    expect(MAX_STEER_QUEUE_SIZE).toBe(20);
  });

  it("enqueues messages up to the capacity", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = createRunControlState();
    for (let i = 0; i < MAX_STEER_QUEUE_SIZE; i++) {
      enqueueSteer(state, `steer ${i}`);
    }
    expect(state.steerQueue.length).toBe(MAX_STEER_QUEUE_SIZE);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("drops the oldest message when at capacity (FIFO eviction)", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = createRunControlState();
    for (let i = 0; i < MAX_STEER_QUEUE_SIZE; i++) {
      enqueueSteer(state, `steer ${i}`);
    }
    // Queue is full: [steer 0, steer 1, ..., steer 19]
    enqueueSteer(state, "overflow message");
    expect(state.steerQueue.length).toBe(MAX_STEER_QUEUE_SIZE);
    // Oldest ("steer 0") should be dropped, "overflow message" is newest
    expect(state.steerQueue[0]).toBe("steer 1");
    expect(state.steerQueue[state.steerQueue.length - 1]).toBe("overflow message");
  });

  it("logs a warning when dropping the oldest message", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = createRunControlState();
    for (let i = 0; i < MAX_STEER_QUEUE_SIZE; i++) {
      enqueueSteer(state, `steer ${i}`);
    }
    enqueueSteer(state, "overflow message");
    expect(warnSpy).toHaveBeenCalledWith(
      "[RUN_CONTROL] Steer queue at capacity, dropping oldest message",
    );
  });

  it("warns for each overflow insertion", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = createRunControlState();
    for (let i = 0; i < MAX_STEER_QUEUE_SIZE; i++) {
      enqueueSteer(state, `steer ${i}`);
    }
    enqueueSteer(state, "overflow 1");
    enqueueSteer(state, "overflow 2");
    enqueueSteer(state, "overflow 3");
    expect(warnSpy).toHaveBeenCalledTimes(3);
  });

  it("maintains FIFO order under repeated overflow", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = createRunControlState();
    for (let i = 0; i < MAX_STEER_QUEUE_SIZE + 5; i++) {
      enqueueSteer(state, `msg ${i}`);
    }
    // After 25 enqueues with capacity 20, we should have messages 5–24
    expect(state.steerQueue.length).toBe(MAX_STEER_QUEUE_SIZE);
    expect(state.steerQueue[0]).toBe("msg 5");
    expect(state.steerQueue[state.steerQueue.length - 1]).toBe("msg 24");
  });

  it("drainSteer returns items in FIFO order after overflow", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = createRunControlState();
    for (let i = 0; i < MAX_STEER_QUEUE_SIZE + 2; i++) {
      enqueueSteer(state, `msg ${i}`);
    }
    // First drain should be "msg 2" (oldest after 2 evictions)
    expect(drainSteer(state)).toBe("msg 2");
    expect(drainSteer(state)).toBe("msg 3");
  });

  it("does not warn when under capacity", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = createRunControlState();
    enqueueSteer(state, "just one");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("whitespace-only message is not enqueued and does not affect queue", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = createRunControlState();
    enqueueSteer(state, "valid");
    enqueueSteer(state, "   ");
    expect(state.steerQueue.length).toBe(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
