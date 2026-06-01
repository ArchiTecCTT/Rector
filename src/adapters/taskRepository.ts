import type { Task } from "../domain/schemas";

function cloneTask(task: Task): Task {
  return {
    ...task,
    subtasks: task.subtasks.map((st) => ({ ...st })),
    events: task.events.map((ev) => ({ ...ev, payload: structuredClone(ev.payload) })),
    metadata: task.metadata ? structuredClone(task.metadata) : undefined,
    validationResult: task.validationResult ? structuredClone(task.validationResult) : undefined,
  };
}

export class InMemoryTaskRepository {
  private tasks = new Map<string, Task>();

  async save(task: Task): Promise<Task> {
    const snapshot = cloneTask(task);
    this.tasks.set(task.id, snapshot);
    return cloneTask(snapshot);
  }

  async get(id: string): Promise<Task | undefined> {
    const task = this.tasks.get(id);
    return task ? cloneTask(task) : undefined;
  }

  async list(): Promise<Task[]> {
    return Array.from(this.tasks.values()).map(cloneTask);
  }
}
