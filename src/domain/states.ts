/**
 * Rector task state machine constants.
 */

export const STATES = {
  INTAKE: "1_INTAKE",
  ARCHITECTURAL_PLAN: "2_ARCHITECTURAL_PLAN",
  SLM_EXECUTION_FANOUT: "3_SLM_EXECUTION_FANOUT",
  SANDBOX_VALIDATION: "4_SANDBOX_VALIDATION",
  HEALING_LOOP: "5_HEALING_LOOP",
  FINAL_SYNTHESIS: "6_FINAL_SYNTHESIS",
  HUMAN_HANDOFF: "7_HUMAN_HANDOFF",
  PAUSED: "PAUSED",
  ABORTED: "ABORTED",
} as const;

export const ALL_STATES = Object.values(STATES) as readonly string[];

/** Manual-control states */
export const MANUAL_STATES = [STATES.PAUSED, STATES.ABORTED] as const;

/** Valid transitions map: fromState -> Set<toState> (plain object for bracket access) */
export const VALID_TRANSITIONS: Record<string, Set<string>> = {
  "1_INTAKE": new Set(["2_ARCHITECTURAL_PLAN"]),
  "2_ARCHITECTURAL_PLAN": new Set(["3_SLM_EXECUTION_FANOUT"]),
  "3_SLM_EXECUTION_FANOUT": new Set(["4_SANDBOX_VALIDATION"]),
  "4_SANDBOX_VALIDATION": new Set(["5_HEALING_LOOP", "6_FINAL_SYNTHESIS"]),
  "5_HEALING_LOOP": new Set(["4_SANDBOX_VALIDATION"]),
  "6_FINAL_SYNTHESIS": new Set(["7_HUMAN_HANDOFF"]),
  "7_HUMAN_HANDOFF": new Set(),
  "PAUSED": new Set(["1_INTAKE"]),
  "ABORTED": new Set(),
};

/** Event topics for the in-memory event bus */
export const TOPICS = {
  TASK_CREATED: "task.created",
  STATE_TRANSITION: "task.state_transition",
  SUBTASK_COMPLETED: "subtask.completed",
  SUBTASK_FAILED: "subtask.failed",
  VALIDATION_PASSED: "validation.passed",
  VALIDATION_FAILED: "validation.failed",
  HEALING_APPLIED: "healing.applied",
  HEALING_FAILED: "healing.failed",
  SYNTHESIS_COMPLETED: "synthesis.completed",
  TASK_COMPLETED: "task.completed",
  TASK_PAUSED: "task.paused",
  TASK_ABORTED: "task.aborted",
} as const;
