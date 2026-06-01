import { Event, Subtask, Task } from "../domain/schemas";
import {
  applyHealing,
  executeSLM,
  planFlagshipTask,
  reexecHealed,
  synthesizeFinalOutput,
  validateResults,
  type WorkerDependencies,
} from "../adapters/providers";

function recordEvent(task: Task, topic: string, payload: Record<string, unknown>, deps: WorkerDependencies): Event {
  const event: Event = {
    id: `${task.id}-${task.events.length}`,
    topic,
    payload,
    timestamp: deps.now(),
  };
  task.events.push(event);
  deps.eventBus.publish(topic, payload);
  return event;
}

/** Add subtasks for the planning state */
function createSubtasks(task: Task, titles: string[]): Subtask[] {
  const now = task.createdAt;
  return titles.map((title, i) => ({
    id: `${task.id}-sub-${i}`,
    title,
    status: "pending" as const,
    createdAt: now,
    updatedAt: now,
  }));
}

export function runIntake(task: Task, deps: WorkerDependencies): Task {
  const events = [...task.events];
  const subtasks = createSubtasks(task, ["Distill context", "Build initial state"]);

  const updated: Task = {
    ...task,
    subtasks,
    events,
  };

  subtasks[0].status = "completed";
  subtasks[0].result = `Context distilled from: ${task.description.slice(0, 50)}`;
  subtasks[0].completedAt = deps.now();
  subtasks[0].updatedAt = deps.now();

  recordEvent(updated, "task.state_transition", { from: task.state, to: "2_ARCHITECTURAL_PLAN" }, deps);
  recordEvent(updated, "subtask.completed", { subtaskId: subtasks[0].id }, deps);

  // Apply state transition
  updated.state = "2_ARCHITECTURAL_PLAN" as any;
  updated.previousState = "1_INTAKE";
  updated.updatedAt = deps.now();

  return updated;
}

export function runFlagshipPlanning(task: Task, deps: WorkerDependencies): Task {
  const planned = planFlagshipTask(task.description);
  const updated = { ...task, subtasks: createSubtasks(task, planned.map((p: { title: string }) => p.title)) };

  // Mark planning subtask complete
  updated.subtasks[0].status = "completed";
  updated.subtasks[0].result = `Planned ${planned.length} subtasks`;
  updated.subtasks[0].completedAt = deps.now();
  updated.subtasks[0].updatedAt = deps.now();

  recordEvent(updated, "subtask.completed", { subtaskId: updated.subtasks[0].id }, deps);
  recordEvent(updated, "task.state_transition", { from: task.state, to: "3_SLM_EXECUTION_FANOUT" }, deps);

  updated.state = "3_SLM_EXECUTION_FANOUT" as any;
  updated.previousState = task.state;
  updated.updatedAt = deps.now();

  return updated;
}

export function runSLMExecution(task: Task, deps: WorkerDependencies): Task {
  const updated = { ...task };
  updated.subtasks = task.subtasks.map((st: Subtask, _i: number) => {
    // Skip already-completed planning subtasks
    if (st.status === "completed") return st;

    const exec = executeSLM(st.title, task.description);
    deps.telemetry.record({
      type: "model.invocation",
      model: "local-slm-1",
      detail: st.title,
    });

    if (exec.success) {
      return {
        ...st,
        status: "completed" as const,
        result: exec.result,
        completedAt: deps.now(),
        updatedAt: deps.now(),
      };
    } else {
      return {
        ...st,
        status: "failed" as const,
        error: exec.result,
        updatedAt: deps.now(),
      };
    }
  });

  recordEvent(updated, "task.state_transition", { from: task.state, to: "4_SANDBOX_VALIDATION" }, deps);
  updated.state = "4_SANDBOX_VALIDATION" as any;
  updated.previousState = task.state;
  updated.updatedAt = deps.now();

  return updated;
}

export function runSandboxValidation(task: Task, deps: WorkerDependencies): Task {
  deps.telemetry.record({ type: "validation.run", detail: "sandbox" });
  const validation = validateResults(task.subtasks);

  const updated = {
    ...task,
    validationResult: {
      passed: validation.passed,
      errors: validation.errors,
    },
  };

  recordEvent(updated, validation.passed ? "validation.passed" : "validation.failed", { passed: validation.passed, errors: validation.errors }, deps);

  if (validation.passed) {
    recordEvent(updated, "task.state_transition", { from: task.state, to: "6_FINAL_SYNTHESIS" }, deps);
    updated.state = "6_FINAL_SYNTHESIS" as any;
  } else {
    recordEvent(updated, "task.state_transition", { from: task.state, to: "5_HEALING_LOOP" }, deps);
    updated.state = "5_HEALING_LOOP" as any;
  }

  updated.previousState = task.state;
  updated.updatedAt = deps.now();
  return updated;
}

export function runHealingLoop(task: Task, deps: WorkerDependencies): Task {
  deps.telemetry.record({ type: "healing.applied", detail: "auto-fix" });

  const priorAttempts = typeof task.metadata?.healingAttempts === "number" ? task.metadata.healingAttempts : 0;
  const healingAttempts = priorAttempts + 1;
  const healedSubtasks = applyHealing(task.subtasks);
  const rerunSubtasks = reexecHealed(healedSubtasks, task.description);

  const updated: Task = {
    ...task,
    subtasks: rerunSubtasks,
    metadata: { ...(task.metadata ?? {}), healingAttempts },
  };

  recordEvent(updated, "healing.applied", { count: rerunSubtasks.filter((s: Subtask) => s.result?.startsWith("[HEALED]")).length, attempt: healingAttempts }, deps);

  // Re-validate
  const validation = validateResults(rerunSubtasks);
  updated.validationResult = {
    passed: validation.passed,
    errors: validation.errors,
  };

  if (validation.passed) {
    recordEvent(updated, "task.state_transition", { from: task.state, to: "4_SANDBOX_VALIDATION" }, deps);
    recordEvent(updated, "healing.applied", { result: "success", attempt: healingAttempts }, deps);
    updated.state = "4_SANDBOX_VALIDATION" as any;
  } else {
    recordEvent(updated, "healing.failed", { errors: validation.errors, attempt: healingAttempts }, deps);
    recordEvent(updated, "task.state_transition", { from: task.state, to: "ABORTED" }, deps);
    updated.state = "ABORTED" as any;
  }

  updated.previousState = task.state;
  updated.updatedAt = deps.now();
  return updated;
}

export function runFinalSynthesis(task: Task, deps: WorkerDependencies): Task {
  deps.telemetry.record({ type: "synthesis.run", detail: "final" });

  const output = synthesizeFinalOutput(task.subtasks);
  const updated = {
    ...task,
    output,
  };

  recordEvent(updated, "synthesis.completed", { outputLength: output.length }, deps);
  recordEvent(updated, "task.state_transition", { from: task.state, to: "7_HUMAN_HANDOFF" }, deps);

  updated.state = "7_HUMAN_HANDOFF" as any;
  updated.previousState = task.state;
  updated.updatedAt = deps.now();

  return updated;
}

export function advancePipeline(task: Task, deps: WorkerDependencies): Task {
  switch (task.state) {
    case "1_INTAKE":
      return runIntake(task, deps);
    case "2_ARCHITECTURAL_PLAN":
      return runFlagshipPlanning(task, deps);
    case "3_SLM_EXECUTION_FANOUT":
      return runSLMExecution(task, deps);
    case "4_SANDBOX_VALIDATION":
      return runSandboxValidation(task, deps);
    case "5_HEALING_LOOP":
      return runHealingLoop(task, deps);
    case "6_FINAL_SYNTHESIS":
      return runFinalSynthesis(task, deps);
    default:
      return task;
  }
}
