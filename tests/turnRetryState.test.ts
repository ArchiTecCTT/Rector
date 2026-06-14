import { describe, expect, it } from "vitest";

import { TurnRetryState } from "../src/providers/turnRetryState";

describe("TurnRetryState", () => {
  it("marks each recovery strategy only once", () => {
    const state = new TurnRetryState();

    expect(state.tryMarkRetried429()).toBe(true);
    expect(state.tryMarkRetried429()).toBe(false);
    expect(state.hasRetried429).toBe(true);

    expect(state.tryMarkRetriedAuth()).toBe(true);
    expect(state.tryMarkRetriedAuth()).toBe(false);
    expect(state.hasRetriedAuth).toBe(true);

    expect(state.tryMarkActivatedFallback()).toBe(true);
    expect(state.tryMarkActivatedFallback()).toBe(false);
    expect(state.hasActivatedFallback).toBe(true);

    expect(state.tryMarkCompressedAndRetried()).toBe(true);
    expect(state.tryMarkCompressedAndRetried()).toBe(false);
    expect(state.hasCompressedAndRetried).toBe(true);
  });
});
