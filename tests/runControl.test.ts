import { afterEach, describe, expect, it } from "vitest";

import {
  clearRunControl,
  createAbortSignal,
  drainSteer,
  getRunControlState,
  interruptRun,
  requestInterrupt,
  steerRun,
} from "../src/orchestration/runControl";
import { InMemoryRectorStore, type Budget, type CreateRunInput } from "../src/store";

const budget: Budget = {
  maxUsd: 1,
  maxInputTokens: 10_000,
  maxOutputTokens: 5_000,
  maxModelCalls: 8,
  maxRuntimeMs: 60_000,
  maxHealingAttempts: 2,
  allowedProviders: [],
  approvalRequiredAboveUsd: 0,
};

const touchedRunIds = new Set<string>();

afterEach(() => {
  for (const runId of touchedRunIds) clearRunControl(runId);
  touchedRunIds.clear();
});

describe("run control state", () => {
  it("interruptRun appends RUN_INTERRUPT_REQUESTED and trips the abort signal", async () => {
    const store = new InMemoryRectorStore({ now: () => "2026-06-13T00:00:00.000Z" });
    const run = await store.createRun(makeRunInput({ phase: "EXECUTING" }));
    touchedRunIds.add(run.id);

    const result = await interruptRun(store, run.id, "user requested stop");

    expect(result).toMatchObject({ ok: true, status: "aborting", mutated: true });
    const state = getRunControlState(run.id);
    expect(state?.interruptRequested).toBe(true);
    expect(createAbortSignal(state!).aborted).toBe(true);
    const events = await store.listEvents(run.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "RUN_INTERRUPT_REQUESTED",
      phase: "EXECUTING",
      payload: { reason: "user requested stop" },
    });
  });

  it("requestInterrupt is idempotent for an already aborted signal", () => {
    const state = getRunControlState("missing") ?? undefined;
    expect(state).toBeUndefined();

    const runState = {
      runId: "run-manual",
      interruptRequested: false,
      steerQueue: [],
      abortController: new AbortController(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    requestInterrupt(runState, "first");
    requestInterrupt(runState, "second");

    expect(runState.interruptRequested).toBe(true);
    expect(runState.interruptReason).toBe("second");
    expect(runState.abortController.signal.aborted).toBe(true);
  });

  it("steerRun appends RUN_STEER_ENQUEUED, redacts content, and does not abort", async () => {
    const secret = "sk-RUNCONTROLSECRETABCDEFGHIJKLMNOP";
    const store = new InMemoryRectorStore({ now: () => "2026-06-13T00:00:00.000Z" });
    const run = await store.createRun(makeRunInput({ phase: "EXECUTING" }));
    touchedRunIds.add(run.id);

    await steerRun(store, run.id, "prefer the validation path");
    const second = await steerRun(store, run.id, `Authorization: Bearer ${secret}`);

    expect(second).toMatchObject({ ok: true, queued: true });
    const state = getRunControlState(run.id);
    expect(state?.interruptRequested).toBe(false);
    expect(state?.abortController.signal.aborted).toBe(false);
    expect(drainSteer(state!)).toBe("prefer the validation path");
    expect(drainSteer(state!)).not.toContain(secret);
    expect(drainSteer(state!)).toBeUndefined();

    const events = await store.listEvents(run.id);
    expect(events.map((event) => event.type)).toEqual(["RUN_STEER_ENQUEUED", "RUN_STEER_ENQUEUED"]);
    expect(JSON.stringify(events)).not.toContain(secret);
  });
});

function makeRunInput(overrides: Partial<CreateRunInput> = {}): CreateRunInput {
  return {
    conversationId: "conv-run-control",
    userMessageId: "msg-run-control",
    status: "running",
    phase: "CHAT_RECEIVED",
    route: "CODE_EDIT",
    complexity: "medium",
    budget,
    costEstimate: { usd: 0, modelCalls: 0 },
    tokenEstimate: { input: 0, output: 0 },
    traceId: "trace-run-control",
    attempts: 0,
    healingAttempts: 0,
    validationAttempts: 0,
    ...overrides,
  };
}
