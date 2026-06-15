import { describe, expect, it } from "vitest";
import {
  createDecisionRequest,
  isAllowedRunPhaseTransition,
  resumeFromDecision,
  transitionRun,
} from "../src/orchestration";
import { InMemoryRectorStore, type Budget, type CreateRunInput } from "../src/store";

const budget: Budget = {
  maxUsd: 2,
  maxInputTokens: 10_000,
  maxOutputTokens: 5_000,
  maxModelCalls: 8,
  maxRuntimeMs: 60_000,
  maxHealingAttempts: 2,
  allowedProviders: ["local"],
  approvalRequiredAboveUsd: 1,
};

function makeRunInput(overrides: Partial<CreateRunInput> = {}): CreateRunInput {
  return {
    conversationId: "conv-1",
    userMessageId: "msg-1",
    status: "running",
    phase: "CHAT_RECEIVED",
    route: "local",
    complexity: "simple",
    budget,
    costEstimate: { usd: 0.5 },
    tokenEstimate: { input: 100, output: 200 },
    traceId: "trace-1",
    attempts: 0,
    healingAttempts: 0,
    validationAttempts: 0,
    ...overrides,
  };
}

describe("run state machine", () => {
  it("allows the canonical forward transition map", () => {
    expect(isAllowedRunPhaseTransition("CHAT_RECEIVED", "TRIAGE")).toBe(true);
    expect(isAllowedRunPhaseTransition("TRIAGE", "CONTEXT_BUILDING")).toBe(true);
    expect(isAllowedRunPhaseTransition("TRIAGE", "NEEDS_DECISION")).toBe(true);
    expect(isAllowedRunPhaseTransition("CONTEXT_BUILDING", "PLANNING")).toBe(true);
    expect(isAllowedRunPhaseTransition("PLANNING", "SKEPTIC_REVIEW")).toBe(true);
    expect(isAllowedRunPhaseTransition("SKEPTIC_REVIEW", "CRUCIBLE")).toBe(true);
    expect(isAllowedRunPhaseTransition("SKEPTIC_REVIEW", "PLANNING")).toBe(true);
    expect(isAllowedRunPhaseTransition("CRUCIBLE", "DAG_COMPILATION")).toBe(true);
    expect(isAllowedRunPhaseTransition("CRUCIBLE", "PLANNING")).toBe(true);
    expect(isAllowedRunPhaseTransition("DAG_COMPILATION", "EXECUTING")).toBe(true);
    expect(isAllowedRunPhaseTransition("EXECUTING", "VALIDATING")).toBe(true);
    expect(isAllowedRunPhaseTransition("EXECUTING", "HEALING")).toBe(true);
    expect(isAllowedRunPhaseTransition("VALIDATING", "SYNTHESIZING")).toBe(true);
    expect(isAllowedRunPhaseTransition("VALIDATING", "HEALING")).toBe(true);
    expect(isAllowedRunPhaseTransition("HEALING", "VALIDATING")).toBe(true);
    expect(isAllowedRunPhaseTransition("SYNTHESIZING", "DONE")).toBe(true);
    expect(isAllowedRunPhaseTransition("NEEDS_DECISION", "EXECUTING")).toBe(true);
    expect(isAllowedRunPhaseTransition("NEEDS_DECISION", "FAILED")).toBe(true);
    expect(isAllowedRunPhaseTransition("NEEDS_DECISION", "ABORTED")).toBe(true);
  });

  it("rejects invalid and terminal transitions", () => {
    expect(isAllowedRunPhaseTransition("CHAT_RECEIVED", "PLANNING")).toBe(false);
    expect(isAllowedRunPhaseTransition("DONE", "TRIAGE")).toBe(false);
    expect(isAllowedRunPhaseTransition("FAILED", "TRIAGE")).toBe(false);
    expect(isAllowedRunPhaseTransition("ABORTED", "TRIAGE")).toBe(false);
  });

  it("updates a run and appends a phase-changed event", async () => {
    const store = new InMemoryRectorStore({ now: () => "2026-06-03T00:00:00.000Z" });
    const run = await store.createRun(makeRunInput());

    const result = await transitionRun(store, run.id, "TRIAGE", {
      now: () => "2026-06-03T00:00:01.000Z",
      eventId: () => "evt-transition-1",
      attempts: 1,
      payload: { reason: "accepted" },
    });

    expect(result.run).toMatchObject({ id: run.id, phase: "TRIAGE", status: "running", attempts: 1 });
    expect(result.event).toMatchObject({
      id: "evt-transition-1",
      runId: run.id,
      type: "PHASE_CHANGED",
      phase: "TRIAGE",
      traceId: "trace-1",
      createdAt: "2026-06-03T00:00:01.000Z",
      payload: { fromPhase: "CHAT_RECEIVED", toPhase: "TRIAGE", reason: "accepted" },
    });
    expect(await store.getRun(run.id)).toEqual(result.run);
    expect(await store.listEvents(run.id)).toEqual([result.event]);
  });

  it("emits terminal event types and updates terminal statuses", async () => {
    const store = new InMemoryRectorStore({ now: () => "2026-06-03T00:00:00.000Z" });
    const doneRun = await store.createRun(makeRunInput({ phase: "SYNTHESIZING" }));
    const failedRun = await store.createRun(makeRunInput({ phase: "TRIAGE" }));
    const abortedRun = await store.createRun(makeRunInput({ phase: "TRIAGE" }));

    const done = await transitionRun(store, doneRun.id, "DONE", {
      now: () => "2026-06-03T00:00:02.000Z",
      eventId: () => "evt-done",
    });
    const failed = await transitionRun(store, failedRun.id, "FAILED", {
      now: () => "2026-06-03T00:00:03.000Z",
      eventId: () => "evt-failed",
      lastError: "boom",
    });
    const aborted = await transitionRun(store, abortedRun.id, "ABORTED", {
      now: () => "2026-06-03T00:00:04.000Z",
      eventId: () => "evt-aborted",
    });

    expect(done.run.status).toBe("completed");
    expect(done.event.type).toBe("RUN_COMPLETED");
    expect(failed.run.status).toBe("failed");
    expect(failed.run.lastError).toBe("boom");
    expect(failed.event.type).toBe("RUN_FAILED");
    expect(aborted.run.status).toBe("aborted");
    expect(aborted.event.type).toBe("RUN_ABORTED");
  });

  it("preserves event order across multiple transitions", async () => {
    const store = new InMemoryRectorStore({ now: () => "2026-06-03T00:00:00.000Z" });
    const run = await store.createRun(makeRunInput());

    const first = await transitionRun(store, run.id, "TRIAGE", {
      now: () => "2026-06-03T00:00:01.000Z",
      eventId: () => "evt-1",
    });
    const second = await transitionRun(store, run.id, "CONTEXT_BUILDING", {
      now: () => "2026-06-03T00:00:02.000Z",
      eventId: () => "evt-2",
    });

    expect(await store.listEvents(run.id)).toEqual([first.event, second.event]);
  });

  it("makes NEEDS_DECISION first-class and resumes only with explicit decision input", async () => {
    const store = new InMemoryRectorStore({ now: () => "2026-06-03T00:00:00.000Z" });
    const run = await store.createRun(makeRunInput({ phase: "PLANNING" }));

    const request = await createDecisionRequest(
      store,
      run.id,
      { question: "Proceed?", choices: ["yes", "no"] },
      {
        now: () => "2026-06-03T00:00:03.000Z",
        eventId: () => "evt-decision-request",
      }
    );

    expect(request.run.phase).toBe("NEEDS_DECISION");
    expect(request.run.status).toBe("needs_decision");
    expect(request.run.decisionRequest).toEqual({ question: "Proceed?", choices: ["yes", "no"] });
    expect(request.event.type).toBe("DECISION_REQUESTED");

    // M20: SKEPTIC_REVIEW is no longer a valid NEEDS_DECISION transition.
    // Use EXECUTING (approve operation) instead.
    await expect(
      transitionRun(store, run.id, "EXECUTING", {
        now: () => "2026-06-03T00:00:04.000Z",
        eventId: () => "evt-missing-decision",
      })
    ).rejects.toThrow("Decision input is required to resume run");

    const resumed = await resumeFromDecision(store, run.id, "EXECUTING", { answer: "yes" }, {
      now: () => "2026-06-03T00:00:05.000Z",
      eventId: () => "evt-decision-resume",
    });

    expect(resumed.run.phase).toBe("EXECUTING");
    expect(resumed.run.status).toBe("running");
    expect(resumed.run.decisionRequest).toBeUndefined();
    expect(resumed.event.payload).toMatchObject({
      fromPhase: "NEEDS_DECISION",
      toPhase: "EXECUTING",
      decision: { answer: "yes" },
    });
  });

  it("rejects invalid transitions, terminal transitions, and missing runs without appending events", async () => {
    const store = new InMemoryRectorStore({ now: () => "2026-06-03T00:00:00.000Z" });
    const run = await store.createRun(makeRunInput());
    const terminalRun = await store.createRun(makeRunInput({ phase: "DONE", status: "completed" }));

    await expect(
      transitionRun(store, run.id, "PLANNING", {
        now: () => "2026-06-03T00:00:01.000Z",
        eventId: () => "evt-invalid",
      })
    ).rejects.toThrow("Invalid run phase transition: CHAT_RECEIVED -> PLANNING");
    expect(await store.listEvents(run.id)).toEqual([]);

    await expect(
      transitionRun(store, terminalRun.id, "TRIAGE", {
        now: () => "2026-06-03T00:00:02.000Z",
        eventId: () => "evt-terminal",
      })
    ).rejects.toThrow("Invalid run phase transition: DONE -> TRIAGE");
    expect(await store.listEvents(terminalRun.id)).toEqual([]);

    await expect(transitionRun(store, "missing-run", "TRIAGE")).rejects.toThrow("Run not found: missing-run");
  });

  it("prevents partial mutation when an event with duplicate ID is appended (atomicity regression test)", async () => {
    const store = new InMemoryRectorStore({ now: () => "2026-06-03T00:00:00.000Z" });
    const run = await store.createRun(makeRunInput());

    // Transition once with eventId 'duplicate-evt'
    const firstTransitionResult = await transitionRun(store, run.id, "TRIAGE", {
      now: () => "2026-06-03T00:00:01.000Z",
      eventId: () => "duplicate-evt",
    });

    // Check that first transition succeeded
    expect(firstTransitionResult.run.phase).toBe("TRIAGE");
    expect(await store.listEvents(run.id)).toHaveLength(1);

    // Attempt a second transition with the same eventId 'duplicate-evt'
    await expect(
      transitionRun(store, run.id, "CONTEXT_BUILDING", {
        now: () => "2026-06-03T00:00:02.000Z",
        eventId: () => "duplicate-evt",
      })
    ).rejects.toThrow("Duplicate event ID: duplicate-evt");

    // Fetch the run and ensure its phase did NOT transition to CONTEXT_BUILDING (it should remain TRIAGE)
    const runAfterFailedTransition = await store.getRun(run.id);
    expect(runAfterFailedTransition?.phase).toBe("TRIAGE");

    // Ensure no additional event was appended
    expect(await store.listEvents(run.id)).toHaveLength(1);
  });
});
