import { describe, it, expect, vi, beforeEach } from "vitest";
import { InMemoryEventBus } from "../src/adapters/eventBus";
import { InMemoryTaskRepository } from "../src/adapters/taskRepository";
import { TaskSchema, type Task } from "../src/domain/schemas";

const makeTask = (overrides: Partial<Task> = {}): Task => {
  const now = Date.now();
  return TaskSchema.parse({
    id: `task-${now}`,
    description: "test task",
    state: "1_INTAKE",
    subtasks: [],
    events: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
};

describe("adapters/eventBus", () => {
  let bus: InMemoryEventBus;

  beforeEach(() => {
    bus = new InMemoryEventBus();
  });

  it("delivers published messages to subscribers", () => {
    const handler = vi.fn();
    bus.subscribe("task.created", handler);
    bus.publish("task.created", { id: "t1" });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith("task.created", { id: "t1" });
  });

  it("does not deliver messages on unrelated topics", () => {
    const handler = vi.fn();
    bus.subscribe("task.created", handler);
    bus.publish("task.completed", { id: "t1" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("unsubscribe stops delivery", () => {
    const handler = vi.fn();
    const unsub = bus.subscribe("task.created", handler);
    unsub();
    bus.publish("task.created", { id: "t1" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("supports multiple subscribers on same topic", () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.subscribe("task.created", h1);
    bus.subscribe("task.created", h2);
    bus.publish("task.created", { id: "t1" });
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });
});

describe("adapters/taskRepository", () => {
  let repo: InMemoryTaskRepository;

  beforeEach(() => {
    repo = new InMemoryTaskRepository();
  });

  it("saves and retrieves a task", async () => {
    const task = makeTask({ id: "repo-1" });
    await repo.save(task);
    const got = await repo.get("repo-1");
    expect(got).toBeDefined();
    expect(got!.id).toBe("repo-1");
    expect(got!.description).toBe("test task");
  });

  it("returns undefined for missing id", async () => {
    const got = await repo.get("nonexistent");
    expect(got).toBeUndefined();
  });

  it("saved task is an immutable copy (mutations don't bleed)", async () => {
    const task = makeTask({ id: "copy-1" });
    await repo.save(task);
    task.description = "mutated";
    const got = await repo.get("copy-1");
    expect(got!.description).toBe("test task");
  });

  it("list returns all saved tasks", async () => {
    await repo.save(makeTask({ id: "a" }));
    await repo.save(makeTask({ id: "b" }));
    const list = await repo.list();
    expect(list).toHaveLength(2);
  });
});
