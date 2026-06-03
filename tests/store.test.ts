import { describe, expect, it } from "vitest";
import { InMemoryRectorStore } from "../src/store";
import type { Budget } from "../src/store";

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

describe("InMemoryRectorStore", () => {
  it("creates, gets, lists, and updates conversations without exposing mutable state", async () => {
    const store = new InMemoryRectorStore({ now: () => "2026-06-03T00:00:00.000Z" });

    const conversation = await store.createConversation({
      title: "Build Rector",
      workspaceId: "workspace-1",
      retentionPolicy: "default",
    });

    expect(conversation.id).toMatch(/^conv-/);
    expect(conversation.createdAt).toBe("2026-06-03T00:00:00.000Z");
    expect(await store.getConversation(conversation.id)).toEqual(conversation);
    expect(await store.listConversations()).toEqual([conversation]);

    const listed = await store.listConversations();
    listed[0].title = "mutated outside";
    expect((await store.getConversation(conversation.id))?.title).toBe("Build Rector");

    const updated = await store.updateConversation(conversation.id, { title: "Updated" });
    expect(updated?.title).toBe("Updated");
    expect((await store.getConversation(conversation.id))?.title).toBe("Updated");
  });

  it("creates and lists messages by conversation with copy safety", async () => {
    const store = new InMemoryRectorStore({ now: () => "2026-06-03T00:00:00.000Z" });
    const conversation = await store.createConversation({
      title: "Chat",
      workspaceId: "workspace-1",
      retentionPolicy: "default",
    });

    const message = await store.createMessage({
      conversationId: conversation.id,
      role: "user",
      content: "Implement chunk 4",
      status: "complete",
      redactionState: "none",
    });

    expect(message.id).toMatch(/^msg-/);
    expect(await store.listMessages(conversation.id)).toEqual([message]);

    const fetched = await store.getMessage(message.id);
    if (!fetched) throw new Error("expected message");
    fetched.content = "mutated outside";
    expect((await store.getMessage(message.id))?.content).toBe("Implement chunk 4");
  });

  it("persists run budget and updates run state without mutating stored nested values", async () => {
    const store = new InMemoryRectorStore({ now: () => "2026-06-03T00:00:00.000Z" });
    const conversation = await store.createConversation({
      title: "Run",
      workspaceId: "workspace-1",
      retentionPolicy: "default",
    });
    const message = await store.createMessage({
      conversationId: conversation.id,
      role: "user",
      content: "go",
      status: "complete",
      redactionState: "none",
    });

    const run = await store.createRun({
      conversationId: conversation.id,
      userMessageId: message.id,
      status: "running",
      phase: "TRIAGE",
      route: "local",
      complexity: "simple",
      budget,
      costEstimate: { usd: 0.5 },
      tokenEstimate: { input: 100, output: 200 },
      traceId: "trace-1",
      attempts: 1,
      healingAttempts: 0,
      validationAttempts: 0,
    });

    expect(run.id).toMatch(/^run-/);
    expect(run.budget).toEqual(budget);
    run.budget.allowedProviders.push("mutated");
    expect((await store.getRun(run.id))?.budget.allowedProviders).toEqual(["local"]);

    const updated = await store.updateRun(run.id, {
      status: "completed",
      phase: "DONE",
      actualCost: { usd: 0.42 },
      actualTokens: { input: 90, output: 180 },
    });
    expect(updated?.status).toBe("completed");
    expect(updated?.actualCost).toEqual({ usd: 0.42 });
    expect(await store.listRuns(conversation.id)).toHaveLength(1);
  });

  it("appends run events in insertion order and returns copies", async () => {
    const store = new InMemoryRectorStore();

    const first = await store.appendEvent({
      id: "evt-1",
      runId: "run-1",
      type: "RUN_CREATED",
      phase: "TRIAGE",
      payload: { step: 1 },
      traceId: "trace-1",
      createdAt: "2026-06-03T00:00:00.000Z",
    });
    const second = await store.appendEvent({
      id: "evt-2",
      runId: "run-1",
      type: "PHASE_CHANGED",
      phase: "PLANNING",
      payload: { step: 2 },
      traceId: "trace-1",
      createdAt: "2026-06-03T00:00:01.000Z",
    });

    expect(await store.listEvents("run-1")).toEqual([first, second]);

    const listed = await store.listEvents("run-1");
    listed[0].payload.step = 999;
    expect((await store.getEvent("evt-1"))?.payload).toEqual({ step: 1 });
  });

  it("stores artifacts with metadata copy safety", async () => {
    const store = new InMemoryRectorStore({ now: () => "2026-06-03T00:00:00.000Z" });

    const artifact = await store.createArtifact({
      kind: "patch",
      uri: "file://changes.patch",
      summary: "Generated patch",
      hash: "sha256:abc",
      sizeBytes: 123,
      piiState: "none",
      retentionPolicy: "default",
      metadata: { labels: ["chunk-4"] },
    });

    expect(artifact.id).toMatch(/^art-/);
    expect(await store.getArtifact(artifact.id)).toEqual(artifact);
    expect(await store.listArtifacts()).toEqual([artifact]);

    artifact.metadata.labels = ["mutated"];
    expect((await store.getArtifact(artifact.id))?.metadata).toEqual({ labels: ["chunk-4"] });
  });

  it("rejects appending an event with a duplicate ID", async () => {
    const store = new InMemoryRectorStore();
    const event = {
      id: "evt-dup",
      runId: "run-1",
      type: "RUN_CREATED" as const,
      phase: "TRIAGE" as const,
      payload: { step: 1 },
      traceId: "trace-1",
      createdAt: "2026-06-03T00:00:00.000Z",
    };

    await store.appendEvent(event);
    await expect(store.appendEvent(event)).rejects.toThrow("Duplicate event ID: evt-dup");
  });

  it("returns undefined or false for missing conversation, run, message, event, and artifact get/update/delete", async () => {
    const store = new InMemoryRectorStore();

    // Conversation checks
    expect(await store.getConversation("non-existent")).toBeUndefined();
    expect(await store.updateConversation("non-existent", { title: "New" })).toBeUndefined();
    expect(await store.deleteConversation("non-existent")).toBe(false);

    const conv = await store.createConversation({
      title: "Test",
      workspaceId: "ws-1",
      retentionPolicy: "default",
    });
    expect(await store.deleteConversation(conv.id)).toBe(true);
    expect(await store.deleteConversation(conv.id)).toBe(false);

    // Run checks
    expect(await store.getRun("non-existent")).toBeUndefined();
    expect(await store.updateRun("non-existent", { status: "completed" })).toBeUndefined();
    expect(await store.deleteRun("non-existent")).toBe(false);

    // Message checks
    expect(await store.getMessage("non-existent")).toBeUndefined();
    expect(await store.updateMessage("non-existent", { content: "New" })).toBeUndefined();
    expect(await store.deleteMessage("non-existent")).toBe(false);

    // Event checks
    expect(await store.getEvent("non-existent")).toBeUndefined();
    expect(await store.deleteEvent("non-existent")).toBe(false);

    // Artifact checks
    expect(await store.getArtifact("non-existent")).toBeUndefined();
    expect(await store.updateArtifact("non-existent", { summary: "New" })).toBeUndefined();
    expect(await store.deleteArtifact("non-existent")).toBe(false);
  });

  it("atomically commits run transitions using commitRunTransition", async () => {
    const store = new InMemoryRectorStore({ now: () => "2026-06-03T00:00:00.000Z" });
    const run = await store.createRun({
      conversationId: "conv-1",
      userMessageId: "msg-1",
      status: "running",
      phase: "TRIAGE",
      route: "local",
      complexity: "simple",
      budget,
      costEstimate: { usd: 0.5 },
      tokenEstimate: { input: 100, output: 200 },
      traceId: "trace-1",
      attempts: 0,
      healingAttempts: 0,
      validationAttempts: 0,
    });

    const event = {
      id: "evt-trans-test",
      runId: run.id,
      type: "PHASE_CHANGED" as const,
      phase: "PLANNING" as const,
      payload: { reason: "test" },
      traceId: "trace-1",
      createdAt: "2026-06-03T00:00:01.000Z",
    };

    // 1. Successful atomic commit
    const result = await store.commitRunTransition(run.id, { phase: "PLANNING" }, event);
    expect(result.run.phase).toBe("PLANNING");
    expect(result.event.id).toBe("evt-trans-test");

    const fetchedRun = await store.getRun(run.id);
    expect(fetchedRun?.phase).toBe("PLANNING");
    expect(await store.listEvents(run.id)).toEqual([result.event]);

    // 2. Failure: non-existent run ID
    await expect(
      store.commitRunTransition("non-existent-run", { phase: "TRIAGE" }, { ...event, id: "evt-different" })
    ).rejects.toThrow("Run not found: non-existent-run");

    // 3. Failure: validation error on run patch
    await expect(
      store.commitRunTransition(run.id, { phase: "INVALID_PHASE" as any }, { ...event, id: "evt-different" })
    ).rejects.toThrow();

    // 4. Failure: duplicate event ID
    await expect(
      store.commitRunTransition(run.id, { phase: "CONTEXT_BUILDING" }, event)
    ).rejects.toThrow("Duplicate event ID: evt-trans-test");

    // Ensure the run phase did not change after failed transition attempts
    const runAfterFails = await store.getRun(run.id);
    expect(runAfterFails?.phase).toBe("PLANNING");
  });
});
