import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ConcurrentTransitionError,
  maxTransitionRetries,
  transitionRun,
  ALLOWED_RUN_PHASE_TRANSITIONS,
} from "../src/orchestration/runStateMachine";
import type { RunStateMachineStore } from "../src/orchestration/runStateMachine";
import type { Run, UpdateRunInput } from "../src/store/schemas";
import type { RunEvent } from "../src/protocol/events";
import { InMemoryRectorStore } from "../src/store/inMemoryRectorStore";

// --- Helpers ---

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    conversationId: "conv-1",
    userMessageId: "msg-1",
    status: "running",
    phase: "TRIAGE",
    route: "direct_answer",
    complexity: "simple",
    budget: {
      maxUsd: 10,
      maxInputTokens: 500000,
      maxOutputTokens: 500000,
      maxModelCalls: 1000,
      maxRuntimeMs: 1800000,
      maxHealingAttempts: 10,
      allowedProviders: [],
      approvalRequiredAboveUsd: 1,
    },
    costEstimate: {},
    tokenEstimate: {},
    traceId: "trace-1",
    attempts: 0,
    healingAttempts: 0,
    validationAttempts: 0,
    version: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeEvent(runId: string, id: string): RunEvent {
  return {
    id,
    runId,
    type: "PHASE_CHANGED",
    phase: "CONTEXT_BUILDING",
    payload: { fromPhase: "TRIAGE", toPhase: "CONTEXT_BUILDING" },
    traceId: "trace-1",
    createdAt: new Date().toISOString(),
  };
}

// --- ConcurrentTransitionError tests ---

describe("ConcurrentTransitionError", () => {
  it("has the correct name", () => {
    const err = new ConcurrentTransitionError("run-1", 0, 1);
    expect(err.name).toBe("ConcurrentTransitionError");
  });

  it("includes runId, expectedVersion, and actualVersion", () => {
    const err = new ConcurrentTransitionError("run-abc", 2, 5);
    expect(err.runId).toBe("run-abc");
    expect(err.expectedVersion).toBe(2);
    expect(err.actualVersion).toBe(5);
  });

  it("has a descriptive message", () => {
    const err = new ConcurrentTransitionError("run-1", 3, 7);
    expect(err.message).toContain("run-1");
    expect(err.message).toContain("3");
    expect(err.message).toContain("7");
  });

  it("is an instance of Error", () => {
    const err = new ConcurrentTransitionError("run-1", 0, 1);
    expect(err).toBeInstanceOf(Error);
  });
});

// --- maxTransitionRetries ---

describe("maxTransitionRetries", () => {
  it("is 3", () => {
    expect(maxTransitionRetries).toBe(3);
  });
});

// --- InMemoryRectorStore optimistic concurrency ---

describe("InMemoryRectorStore commitRunTransition with version", () => {
  let store: InMemoryRectorStore;

  beforeEach(() => {
    store = new InMemoryRectorStore();
  });

  it("creates a run with version 0 by default", async () => {
    const run = await store.createRun({
      conversationId: "conv-1",
      userMessageId: "msg-1",
      status: "running",
      phase: "TRIAGE",
      route: "direct_answer",
      complexity: "simple",
      budget: {
        maxUsd: 10,
        maxInputTokens: 500000,
        maxOutputTokens: 500000,
        maxModelCalls: 1000,
        maxRuntimeMs: 1800000,
        maxHealingAttempts: 10,
        allowedProviders: [],
        approvalRequiredAboveUsd: 1,
      },
      costEstimate: {},
      tokenEstimate: {},
      traceId: "trace-1",
      attempts: 0,
      healingAttempts: 0,
      validationAttempts: 0,
    });
    expect(run.version).toBe(0);
  });

  it("increments version on successful transition", async () => {
    const run = await store.createRun({
      conversationId: "conv-1",
      userMessageId: "msg-1",
      status: "running",
      phase: "TRIAGE",
      route: "direct_answer",
      complexity: "simple",
      budget: {
        maxUsd: 10,
        maxInputTokens: 500000,
        maxOutputTokens: 500000,
        maxModelCalls: 1000,
        maxRuntimeMs: 1800000,
        maxHealingAttempts: 10,
        allowedProviders: [],
        approvalRequiredAboveUsd: 1,
      },
      costEstimate: {},
      tokenEstimate: {},
      traceId: "trace-1",
      attempts: 0,
      healingAttempts: 0,
      validationAttempts: 0,
    });
    const { run: updated } = await store.commitRunTransition(
      run.id,
      { phase: "CONTEXT_BUILDING", status: "running", version: 1 },
      makeEvent(run.id, "evt-1")
    );
    expect(updated.version).toBe(1);
  });

  it("throws ConcurrentTransitionError when version mismatches", async () => {
    const run = await store.createRun({
      conversationId: "conv-1",
      userMessageId: "msg-1",
      status: "running",
      phase: "TRIAGE",
      route: "direct_answer",
      complexity: "simple",
      budget: {
        maxUsd: 10,
        maxInputTokens: 500000,
        maxOutputTokens: 500000,
        maxModelCalls: 1000,
        maxRuntimeMs: 1800000,
        maxHealingAttempts: 10,
        allowedProviders: [],
        approvalRequiredAboveUsd: 1,
      },
      costEstimate: {},
      tokenEstimate: {},
      traceId: "trace-1",
      attempts: 0,
      healingAttempts: 0,
      validationAttempts: 0,
    });
    // First transition succeeds (version 0 -> 1)
    await store.commitRunTransition(
      run.id,
      { phase: "CONTEXT_BUILDING", status: "running", version: 1 },
      makeEvent(run.id, "evt-1")
    );
    // Second transition with stale version 1 (but actual is now 1) should succeed
    await store.commitRunTransition(
      run.id,
      { phase: "PLANNING", status: "running", version: 2 },
      makeEvent(run.id, "evt-2")
    );
    // Now try with a stale version (version 1 -> 2, but actual is 2)
    await expect(
      store.commitRunTransition(
        run.id,
        { phase: "SKEPTIC_REVIEW", status: "running", version: 2 },
        makeEvent(run.id, "evt-3")
      )
    ).rejects.toThrow(ConcurrentTransitionError);
  });

  it("allows transition when patch.version matches current.version + 1", async () => {
    const run = await store.createRun({
      conversationId: "conv-1",
      userMessageId: "msg-1",
      status: "running",
      phase: "TRIAGE",
      route: "direct_answer",
      complexity: "simple",
      budget: {
        maxUsd: 10,
        maxInputTokens: 500000,
        maxOutputTokens: 500000,
        maxModelCalls: 1000,
        maxRuntimeMs: 1800000,
        maxHealingAttempts: 10,
        allowedProviders: [],
        approvalRequiredAboveUsd: 1,
      },
      costEstimate: {},
      tokenEstimate: {},
      traceId: "trace-1",
      attempts: 0,
      healingAttempts: 0,
      validationAttempts: 0,
    });
    // current version is 0, patch.version = 1 means "expected current version is 0"
    const { run: updated } = await store.commitRunTransition(
      run.id,
      { phase: "CONTEXT_BUILDING", status: "running", version: 1 },
      makeEvent(run.id, "evt-1")
    );
    expect(updated.version).toBe(1);
    expect(updated.phase).toBe("CONTEXT_BUILDING");
  });
});

// --- transitionRun retry logic ---

describe("transitionRun retry on ConcurrentTransitionError", () => {
  function makeStore(
    run: Run,
    transitionBehavior: (
      runId: string,
      patch: UpdateRunInput,
      event: RunEvent,
      callCount: { value: number }
    ) => Promise<{ run: Run; event: RunEvent }>
  ): RunStateMachineStore {
    const callCount = { value: 0 };
    return {
      getRun: vi.fn().mockResolvedValue(run),
      updateRun: vi.fn().mockResolvedValue(run),
      appendEvent: vi.fn().mockResolvedValue(makeEvent(run.id, "evt-1")),
      commitRunTransition: vi.fn((runId: string, patch: UpdateRunInput, event: RunEvent) => {
        callCount.value++;
        return transitionBehavior(runId, patch, event, callCount);
      }),
    };
  }

  it("succeeds on first attempt when no conflict", async () => {
    const run = makeRun();
    const store = makeStore(run, async (runId, patch, event, cc) => ({
      run: { ...run, ...patch } as Run,
      event,
    }));

    const result = await transitionRun(store, "run-1", "CONTEXT_BUILDING");
    expect(result.run.phase).toBe("CONTEXT_BUILDING");
  });

  it("retries on ConcurrentTransitionError and succeeds", async () => {
    const run = makeRun();
    let callCount = 0;
    const store = makeStore(run, async (runId, patch, event, cc) => {
      callCount++;
      if (callCount === 1) {
        throw new ConcurrentTransitionError(runId, 0, 1);
      }
      return { run: { ...run, ...patch } as Run, event };
    });

    const result = await transitionRun(store, "run-1", "CONTEXT_BUILDING");
    expect(result.run.phase).toBe("CONTEXT_BUILDING");
    expect(callCount).toBe(2);
  });

  it("retries up to maxTransitionRetries times then throws", async () => {
    const run = makeRun();
    let callCount = 0;
    const store = makeStore(run, async (runId, _patch, event, cc) => {
      callCount++;
      throw new ConcurrentTransitionError(runId, callCount - 1, callCount);
    });

    await expect(transitionRun(store, "run-1", "CONTEXT_BUILDING")).rejects.toThrow(
      ConcurrentTransitionError
    );
    // Initial attempt + maxTransitionRetries retries = 1 + 3 = 4 total
    expect(callCount).toBe(1 + maxTransitionRetries);
  });

  it("sets patch.version on each attempt", async () => {
    const run = makeRun({ version: 5 });
    const versions: (number | undefined)[] = [];
    const store = makeStore(run, async (runId, patch, event, cc) => {
      versions.push(patch.version);
      if (versions.length === 1) {
        throw new ConcurrentTransitionError(runId, 5, 6);
      }
      return { run: { ...run, ...patch } as Run, event };
    });

    await transitionRun(store, "run-1", "CONTEXT_BUILDING");
    // First attempt: version = 5+1 = 6 (failed), second attempt: version = 6
    expect(versions[0]).toBe(6);
    expect(versions.length).toBe(2);
  });

  it("does not retry on non-concurrent errors", async () => {
    const run = makeRun();
    let callCount = 0;
    const store = makeStore(run, async () => {
      callCount++;
      throw new Error("Some other error");
    });

    await expect(transitionRun(store, "run-1", "CONTEXT_BUILDING")).rejects.toThrow(
      "Some other error"
    );
    expect(callCount).toBe(1);
  });
});
