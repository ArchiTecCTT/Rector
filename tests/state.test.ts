import { describe, it, expect } from "vitest";
import { STATES, VALID_TRANSITIONS, TOPICS } from "../src/domain/states";
import { isValidTransition, getNextState, getPossibleNextStates } from "../src/domain/transitions";
import { TaskSchema, SubtaskSchema } from "../src/domain/schemas";

describe("domain/states", () => {
  it("defines all expected states", () => {
    expect(STATES.INTAKE).toBe("1_INTAKE");
    expect(STATES.HUMAN_HANDOFF).toBe("7_HUMAN_HANDOFF");
    expect(STATES.PAUSED).toBe("PAUSED");
    expect(STATES.ABORTED).toBe("ABORTED");
  });

  it("has valid transitions from INTAKE", () => {
    const from = STATES.INTAKE;
    expect(VALID_TRANSITIONS[from].has(STATES.ARCHITECTURAL_PLAN)).toBe(true);
    expect(VALID_TRANSITIONS[from].has(STATES.SLM_EXECUTION_FANOUT)).toBe(false);
  });

  it("rejects invalid transitions", () => {
    expect(isValidTransition(STATES.INTAKE, STATES.HUMAN_HANDOFF)).toBe(false);
  });

  it("getNextState returns first valid next state", () => {
    const next = getNextState(STATES.INTAKE);
    expect(next).toBe(STATES.ARCHITECTURAL_PLAN);
  });

  it("getPossibleNextStates returns all possible next states", () => {
    const nexts = getPossibleNextStates(STATES.SANDBOX_VALIDATION);
    expect(nexts).toContain(STATES.HEALING_LOOP);
    expect(nexts).toContain(STATES.FINAL_SYNTHESIS);
    expect(nexts.length).toBe(2);
  });

  it("terminal states have no outgoing transitions", () => {
    expect(VALID_TRANSITIONS[STATES.HUMAN_HANDOFF].size).toBe(0);
    expect(VALID_TRANSITIONS[STATES.ABORTED].size).toBe(0);
  });

  it("PAUSED state allows retry back to INTAKE", () => {
    expect(VALID_TRANSITIONS[STATES.PAUSED].has(STATES.INTAKE)).toBe(true);
  });

  it("ABORTED state is terminal and cannot retry", () => {
    expect(VALID_TRANSITIONS[STATES.ABORTED].has(STATES.INTAKE)).toBe(false);
    expect(isValidTransition(STATES.ABORTED, STATES.INTAKE)).toBe(false);
  });

  it("defines all event topics", () => {
    expect(Object.values(TOPICS).length).toBeGreaterThanOrEqual(10);
    expect(TOPICS.TASK_CREATED).toBe("task.created");
    expect(TOPICS.TASK_COMPLETED).toBe("task.completed");
  });
});

describe("domain/schemas", () => {
  it("SubtaskSchema validates correctly", () => {
    const ok = SubtaskSchema.parse({
      id: "s1",
      title: "test",
      status: "pending",
      createdAt: 1,
      updatedAt: 1,
    });
    expect(ok.id).toBe("s1");
    expect(ok.status).toBe("pending");
  });

  it("TaskSchema rejects bad state", () => {
    expect(() =>
      TaskSchema.parse({
        id: "t1",
        description: "task",
        state: "UNKNOWN_STATE",
        subtasks: [],
        events: [],
        createdAt: 1,
        updatedAt: 1,
      })
    ).toThrow();
  });
});
