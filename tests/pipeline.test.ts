import { describe, it, expect } from "vitest";
import { TaskManager } from "../src/thalamus/router";
import { LocalTelemetry } from "../src/adapters/providers";
import { STATES } from "../src/domain/states";

function makeManager() {
  const manager = new TaskManager();
  const tel = new LocalTelemetry();
  manager.setTelemetry({
    record: (e: { type: string }) => tel.record(e),
    getMetrics: () => tel.getMetrics() as any,
  });
  return { manager, tel };
}

// Quick sanity check
const { manager: _m } = makeManager();

describe("pipeline — happy path", () => {
  it("normal task advances through all states to HUMAN_HANDOFF", async () => {
    const { manager, tel } = makeManager();
    const task = manager.createTask("Build a REST API for task management");

    let current = task;
    for (let i = 0; i < 10; i++) {
      current = await manager.advance(current.id);
      if (current.state === STATES.HUMAN_HANDOFF) break;
    }

    expect(current.state).toBe(STATES.HUMAN_HANDOFF);
    expect(current.output).toBeDefined();
    expect(current.output!.length).toBeGreaterThan(0);
    expect(tel.getMetrics().healingRuns).toBe(0);
  });
});

describe("pipeline — healing loop", () => {
  it("task with 'fail' or 'broken' enters healing loop then completes", async () => {
    const { manager, tel } = makeManager();
    const task = manager.createTask("Refactor the broken retry logic to work correctly");

    let current = task;
    for (let i = 0; i < 12; i++) {
      current = await manager.advance(current.id);
      if (current.state === STATES.HUMAN_HANDOFF) break;
    }

    expect(current.state).toBe(STATES.HUMAN_HANDOFF);
    expect(current.subtasks.every((s) => s.status === "completed")).toBe(true);
    const healedSubs = current.subtasks.filter((s) => s.result?.includes("HEALED"));
    expect(healedSubs.length).toBeGreaterThanOrEqual(1);
    expect(current.validationResult?.passed).toBe(true);
    expect(tel.getMetrics().healingRuns).toBeGreaterThanOrEqual(1);
    expect(tel.getMetrics().synthesisRuns).toBeGreaterThan(0);
    expect(tel.getMetrics().validationRuns).toBeGreaterThan(0);
  });

  it("unhealable tasks abort instead of synthesizing broken output", async () => {
    const { manager } = makeManager();
    const task = manager.createTask("Refactor the unhealable broken fail logic");

    let current = task;
    for (let i = 0; i < 12; i++) {
      current = await manager.advance(current.id);
      if (current.state === STATES.ABORTED) break;
    }

    expect(current.state).toBe(STATES.ABORTED);
    expect(current.output).toBeUndefined();
    expect(current.validationResult?.passed).toBe(false);
    expect(current.subtasks.some((s) => s.status === "failed")).toBe(true);
  });
});

describe("pipeline — event stream", () => {
  it("emits events during pipeline execution", async () => {
    const { manager } = makeManager();
    const events: string[] = [];
    manager.subscribe("task.state_transition", (_topic, payload) => {
      events.push((payload as any).to);
    });

    const task = manager.createTask("Build a new dashboard");
    let current = task;
    for (let i = 0; i < 10; i++) {
      current = await manager.advance(current.id);
      if (current.state === STATES.HUMAN_HANDOFF) break;
    }

    expect(events).toEqual([
      STATES.ARCHITECTURAL_PLAN,
      STATES.SLM_EXECUTION_FANOUT,
      STATES.SANDBOX_VALIDATION,
      STATES.FINAL_SYNTHESIS,
      STATES.HUMAN_HANDOFF,
    ]);
  });
});
