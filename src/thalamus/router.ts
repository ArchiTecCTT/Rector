import { randomUUID } from "node:crypto";
import { STATES, VALID_TRANSITIONS } from "../domain/states";
import { type Task, TaskSchema } from "../domain/schemas";
import { InMemoryTaskRepository } from "../adapters/taskRepository";
import { InMemoryEventBus } from "../adapters/eventBus";
import { advancePipeline } from "../workers/workers";
import { isValidTransition, getPossibleNextStates } from "../domain/transitions";

export class TaskManager {
  private tasks = new InMemoryTaskRepository();
  private eventBus = new InMemoryEventBus();
  private _telemetry = {
    record: (_e: { type: string }) => {},
    getMetrics: () => ({
      modelInvocations: 0,
      cacheHits: 0,
      validationRuns: 0,
      healingRuns: 0,
      synthesisRuns: 0,
      totalCost: 0,
      events: [],
    }),
  };

  get telemetry() {
    return this._telemetry;
  }

  constructor(deps?: {
    record: (e: { type: string }) => void;
    getMetrics: () => any;
  }) {
    if (deps) this._telemetry = deps;
  }

  setTelemetry(deps: {
    record: (e: { type: string }) => void;
    getMetrics: () => any;
  }): void {
    this._telemetry = deps;
  }

  createTask(description: string): Task {
    const now = Date.now();
    const task: Task = {
      id: `task-${randomUUID()}`,
      description,
      state: STATES.INTAKE,
      previousState: undefined,
      subtasks: [],
      events: [],
      metadata: {},
      createdAt: now,
      updatedAt: now,
    };

    // Validate before saving
    TaskSchema.parse(task);
    void this.tasks.save(task);
    return task;
  }

  async getTask(id: string): Promise<Task | undefined> {
    return this.tasks.get(id);
  }

  async listTasks(): Promise<Task[]> {
    return this.tasks.list();
  }

  async transition(taskId: string, toState: string): Promise<Task> {
    const task = await this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const manualTarget = toState === STATES.PAUSED || toState === STATES.ABORTED;
    const terminalSource = task.state === STATES.HUMAN_HANDOFF || task.state === STATES.ABORTED;
    const pausedResume = task.state === STATES.PAUSED && toState === STATES.INTAKE;
    const pausedAbort = task.state === STATES.PAUSED && toState === STATES.ABORTED;
    const validPipelineTransition = isValidTransition(task.state, toState);

    if (toState === task.state) {
      throw new Error(`Cannot transition ${task.state} to itself`);
    }
    if (terminalSource) {
      throw new Error(`Cannot transition from terminal state ${task.state}`);
    }
    if (!(manualTarget || pausedResume || pausedAbort || validPipelineTransition)) {
      throw new Error(
        `Invalid transition from ${task.state} to ${toState}. Allowed: ${getPossibleNextStates(task.state).join(", ") || "none"}`
      );
    }

    const now = Date.now();
    const updated: Task = {
      ...task,
      state: toState as any,
      previousState: task.state,
      updatedAt: now,
      events: [...task.events],
    };
    updated.events.push({
      id: `${taskId}-${updated.events.length}`,
      topic: "task.state_transition",
      payload: { from: task.state, to: toState },
      timestamp: now,
    });

    return this.tasks.save(updated);
  }

  async approve(taskId: string): Promise<Task> {
    const task = await this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.state !== STATES.HUMAN_HANDOFF) {
      throw new Error(`Cannot approve from ${task.state}`);
    }
    const now = Date.now();
    return this.tasks.save({
      ...task,
      approved: true,
      updatedAt: now,
      events: [
        ...task.events,
        {
          id: `${taskId}-${task.events.length}`,
          topic: "task.approved",
          payload: { approved: true },
          timestamp: now,
        },
      ],
    });
  }

  async advance(taskId: string): Promise<Task> {
    const task = await this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    // Build deps that proxy calls to the underlying telemetry
    const deps = {
      telemetry: {
        record: (_e: any) => {
          this._telemetry.record(_e);
        },
        getMetrics: () => this._telemetry.getMetrics(),
      },
      eventBus: {
        publish: (topic: string, payload: Record<string, unknown>) => {
          this.eventBus.publish(topic, payload);
        },
      },
      now: () => Date.now(),
    };

    const updated = advancePipeline(task, deps);
    return this.tasks.save(updated);
  }

  subscribe(topic: string, handler: (topic: string, payload: Record<string, unknown>) => void): () => void {
    return this.eventBus.subscribe(topic, handler);
  }
}
