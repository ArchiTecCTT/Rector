import { describe, it, expect, vi, beforeEach } from "vitest";
import { InMemoryEventBus } from "../src/adapters/eventBus";
import { InMemoryTaskRepository } from "../src/adapters/taskRepository";
import { TaskSchema, type Task } from "../src/domain/schemas";
import { RunEventSchema } from "../src/protocol/events";

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

  describe("publishRedacted (M3)", () => {
    it("redacts secret-keyed values before dispatch", () => {
      const handler = vi.fn();
      bus.subscribe("run.event", handler);
      bus.publishRedacted("run.event", { apiKey: "sk-secret-123", status: "ok" });
      expect(handler).toHaveBeenCalledTimes(1);
      const [, payload] = handler.mock.calls[0];
      expect(payload).toHaveProperty("apiKey", "[REDACTED]");
      expect(payload).toHaveProperty("status", "ok");
    });

    it("redacts bearer tokens in string values", () => {
      const handler = vi.fn();
      bus.subscribe("run.event", handler);
      bus.publishRedacted("run.event", { header: "Bearer tok_abc123" });
      const [, payload] = handler.mock.calls[0];
      expect(payload.header).not.toContain("tok_abc123");
    });

    it("does not mutate the original payload", () => {
      const handler = vi.fn();
      bus.subscribe("run.event", handler);
      const original = { apiKey: "sk-secret", count: 5 };
      bus.publishRedacted("run.event", original);
      // Original is not mutated (redactSecrets returns a new object)
      expect(original).toHaveProperty("apiKey", "sk-secret");
    });

    it("publish delivers unredacted payload (no redaction)", () => {
      const handler = vi.fn();
      bus.subscribe("run.event", handler);
      bus.publish("run.event", { apiKey: "sk-secret", status: "ok" });
      const [, payload] = handler.mock.calls[0];
      expect(payload).toHaveProperty("apiKey", "sk-secret");
    });
  });
});

describe("RunEventSchema payload constraints (M14)", () => {
  const makeEvent = (payload: Record<string, unknown>) => ({
    id: "evt-1",
    runId: "run-1",
    type: "RUN_CREATED" as const,
    phase: "TRIAGE" as const,
    payload,
    createdAt: new Date().toISOString(),
  });

  it("accepts valid payload with string/number/boolean/null values", () => {
    const result = RunEventSchema.safeParse(makeEvent({ name: "test", count: 5, active: true, extra: null }));
    expect(result.success).toBe(true);
  });

  it("accepts empty payload", () => {
    const result = RunEventSchema.safeParse(makeEvent({}));
    expect(result.success).toBe(true);
  });

  it("rejects payload with more than 50 keys", () => {
    const payload: Record<string, unknown> = {};
    for (let i = 0; i < 51; i++) payload[`key${i}`] = "val";
    const result = RunEventSchema.safeParse(makeEvent(payload));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toContain("50");
    }
  });

  it("accepts payload with exactly 50 keys", () => {
    const payload: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) payload[`key${i}`] = "val";
    const result = RunEventSchema.safeParse(makeEvent(payload));
    expect(result.success).toBe(true);
  });

  it("rejects payload key longer than 128 chars", () => {
    const longKey = "x".repeat(129);
    const result = RunEventSchema.safeParse(makeEvent({ [longKey]: "value" }));
    expect(result.success).toBe(false);
  });

  it("accepts payload key of exactly 128 chars", () => {
    const key = "x".repeat(128);
    const result = RunEventSchema.safeParse(makeEvent({ [key]: "value" }));
    expect(result.success).toBe(true);
  });

  it("rejects payload with object value", () => {
    const result = RunEventSchema.safeParse(makeEvent({ nested: { inner: true } }));
    expect(result.success).toBe(false);
  });

  it("rejects payload with array value", () => {
    const result = RunEventSchema.safeParse(makeEvent({ items: [1, 2, 3] }));
    expect(result.success).toBe(false);
  });

  it("rejects string value longer than 10000 chars", () => {
    const result = RunEventSchema.safeParse(makeEvent({ data: "x".repeat(10_001) }));
    expect(result.success).toBe(false);
  });

  it("accepts string value of exactly 10000 chars", () => {
    const result = RunEventSchema.safeParse(makeEvent({ data: "x".repeat(10_000) }));
    expect(result.success).toBe(true);
  });

  it("rejects undefined value in payload", () => {
    const result = RunEventSchema.safeParse(makeEvent({ missing: undefined } as any));
    expect(result.success).toBe(false);
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
