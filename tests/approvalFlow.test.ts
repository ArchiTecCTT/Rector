import { describe, expect, it, beforeAll, afterAll } from "vitest";
import express from "express";
import http from "node:http";
import {
  APPROVAL_DECISION_TIMEOUT_MS,
  ApprovalProcessingError,
  presentApprovalRequest,
  recordApprovalDecision,
  type ApprovalRequestView,
} from "../src/api/approvalFlow";
import { createApp } from "../src/api/server";
import { TaskManager } from "../src/thalamus/router";
import { LocalTelemetry } from "../src/adapters/providers";
import { InMemoryRectorStore, type Budget, type CreateRunInput, type Run } from "../src/store";

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

function makeRunInput(overrides: Partial<CreateRunInput> = {}): CreateRunInput {
  return {
    conversationId: "conv-1",
    userMessageId: "msg-1",
    status: "running",
    phase: "EXECUTING",
    route: "local",
    complexity: "simple",
    budget,
    costEstimate: { usd: 0.5 },
    tokenEstimate: { input: 100, output: 200 },
    traceId: "trace-1",
    attempts: 0,
    healingAttempts: 0,
    validationAttempts: 0,
    ...overrides,
  };
}

function view(overrides: Partial<ApprovalRequestView> = {}): ApprovalRequestView {
  return {
    runId: "run-1",
    operationId: "op-1",
    diff: "--- a/file.ts\n+++ b/file.ts\n@@ -0,0 +1 @@\n+const x = 1;",
    command: "npm run build",
    targetPath: "src/file.ts",
    ...overrides,
  };
}

async function seedPendingRun(
  store: InMemoryRectorStore,
  options: {
    operationId?: string;
    presentedAt?: string;
    riskyCommand?: boolean;
    view?: ApprovalRequestView;
  } = {}
): Promise<Run> {
  const run = await store.createRun(makeRunInput());
  const operationId = options.operationId ?? "op-1";
  await presentApprovalRequest(
    store,
    {
      runId: run.id,
      operationId,
      riskyCommand: options.riskyCommand ?? true,
      view: options.view ?? view({ runId: run.id, operationId }),
    },
    { now: () => options.presentedAt ?? "2026-06-03T00:00:00.000Z" }
  );
  return (await store.getRun(run.id)) as Run;
}

describe("recordApprovalDecision", () => {
  it("presents an operation by moving the run into NEEDS_DECISION with a redacted view", async () => {
    const store = new InMemoryRectorStore({ now: () => "2026-06-03T00:00:00.000Z" });
    const run = await seedPendingRun(store, {
      view: view({
        runId: "run-x",
        operationId: "op-1",
        command: "deploy --token=SECRET123",
        diff: "Authorization: Bearer abc.def.ghi",
        targetPath: "src/app.ts",
      }),
    });

    expect(run.phase).toBe("NEEDS_DECISION");
    expect(run.status).toBe("needs_decision");
    const request = run.decisionRequest as Record<string, any>;
    expect(request.kind).toBe("approval");
    expect(request.operationId).toBe("op-1");
    expect(request.presentedAt).toBe("2026-06-03T00:00:00.000Z");
    // Redaction boundary: no secret substring survives in the presented view (Req 9.6).
    expect(JSON.stringify(request.view)).not.toContain("SECRET123");
    expect(JSON.stringify(request.view)).not.toContain("abc.def.ghi");
  });

  it("records an approval in the Event_Log before resuming to EXECUTING", async () => {
    const store = new InMemoryRectorStore({ now: () => "2026-06-03T00:00:00.000Z" });
    const run = await seedPendingRun(store);

    const record = await recordApprovalDecision(
      store,
      { runId: run.id, operationId: "op-1", decision: "approve", decidedBy: "alice" },
      { now: () => "2026-06-03T00:05:00.000Z" }
    );

    expect(record).toMatchObject({
      runId: run.id,
      operationId: "op-1",
      decision: "approve",
      decidedBy: "alice",
      decidedAt: "2026-06-03T00:05:00.000Z",
    });

    const resumed = await store.getRun(run.id);
    expect(resumed?.phase).toBe("EXECUTING");
    expect(resumed?.decisionRequest).toBeUndefined();

    // The decision (identity + timestamp) is appended to the Event_Log (Req 9.3, Property 14).
    const events = await store.listEvents(run.id);
    const decisionEvent = events[events.length - 1];
    expect(decisionEvent.payload).toMatchObject({
      fromPhase: "NEEDS_DECISION",
      toPhase: "EXECUTING",
      decision: { decision: "approve", decidedBy: "alice", decidedAt: "2026-06-03T00:05:00.000Z" },
    });
  });

  it("continues the run to a final answer (SYNTHESIZING) on denial", async () => {
    const store = new InMemoryRectorStore({ now: () => "2026-06-03T00:00:00.000Z" });
    const run = await seedPendingRun(store);

    const record = await recordApprovalDecision(
      store,
      { runId: run.id, operationId: "op-1", decision: "deny", decidedBy: "bob" },
      { now: () => "2026-06-03T00:05:00.000Z" }
    );

    expect(record.decision).toBe("deny");
    const resumed = await store.getRun(run.id);
    expect(resumed?.phase).toBe("SYNTHESIZING");
    expect(resumed?.status).toBe("running");
  });

  it("downgrades a stale approval (past 30 minutes) to a timeout denial", async () => {
    const store = new InMemoryRectorStore({ now: () => "2026-06-03T00:00:00.000Z" });
    const presentedAt = "2026-06-03T00:00:00.000Z";
    const run = await seedPendingRun(store, { presentedAt });

    const decidedAt = new Date(Date.parse(presentedAt) + APPROVAL_DECISION_TIMEOUT_MS).toISOString();
    const record = await recordApprovalDecision(
      store,
      { runId: run.id, operationId: "op-1", decision: "approve", decidedBy: "carol" },
      { now: () => decidedAt }
    );

    // A late "approve" can never execute a risky command (Req 9.8): it is recorded as a denial and
    // the run continues to a final answer that excludes the operation.
    expect(record.decision).toBe("timeout-denied");
    const resumed = await store.getRun(run.id);
    expect(resumed?.phase).toBe("SYNTHESIZING");
  });

  it("keeps the run pending when it is not awaiting a decision (Req 9.7)", async () => {
    const store = new InMemoryRectorStore({ now: () => "2026-06-03T00:00:00.000Z" });
    const run = await store.createRun(makeRunInput({ phase: "EXECUTING" }));

    await expect(
      recordApprovalDecision(
        store,
        { runId: run.id, operationId: "op-1", decision: "approve", decidedBy: "alice" },
        {}
      )
    ).rejects.toBeInstanceOf(ApprovalProcessingError);

    const after = await store.getRun(run.id);
    expect(after?.phase).toBe("EXECUTING");
    expect(await store.listEvents(run.id)).toEqual([]);
  });

  it("keeps the run pending when the operation id does not match (Req 9.7)", async () => {
    const store = new InMemoryRectorStore({ now: () => "2026-06-03T00:00:00.000Z" });
    const run = await seedPendingRun(store, { operationId: "op-1" });

    await expect(
      recordApprovalDecision(
        store,
        { runId: run.id, operationId: "op-other", decision: "approve", decidedBy: "alice" },
        { now: () => "2026-06-03T00:05:00.000Z" }
      )
    ).rejects.toMatchObject({ code: "OPERATION_MISMATCH" });

    const after = await store.getRun(run.id);
    expect(after?.phase).toBe("NEEDS_DECISION");
  });

  it("throws RUN_NOT_FOUND for an unknown run", async () => {
    const store = new InMemoryRectorStore({ now: () => "2026-06-03T00:00:00.000Z" });
    await expect(
      recordApprovalDecision(
        store,
        { runId: "missing", operationId: "op-1", decision: "deny", decidedBy: "alice" },
        {}
      )
    ).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
  });
});

describe("POST /api/runs/:id/decision", () => {
  let app: express.Application;
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    const manager = new TaskManager();
    const tel = new LocalTelemetry();
    manager.setTelemetry({ record: (e) => tel.record(e), getMetrics: () => tel.getMetrics() });
    app = createApp(manager);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 3000;
        base = `http://localhost:${port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  async function post(path: string, body: unknown) {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: (await res.json().catch(() => ({}))) as any };
  }

  it("rejects an invalid decision value with 400", async () => {
    const r = await post("/api/runs/run-1/decision", {
      operationId: "op-1",
      decision: "maybe",
      decidedBy: "alice",
    });
    expect(r.status).toBe(400);
  });

  it("requires operationId and decidedBy", async () => {
    expect((await post("/api/runs/run-1/decision", { decision: "approve", decidedBy: "alice" })).status).toBe(400);
    expect((await post("/api/runs/run-1/decision", { operationId: "op-1", decision: "approve" })).status).toBe(400);
  });

  it("returns 404 with decisionProcessed=false for an unknown run", async () => {
    const r = await post("/api/runs/unknown-run/decision", {
      operationId: "op-1",
      decision: "approve",
      decidedBy: "alice",
    });
    expect(r.status).toBe(404);
    expect(r.data.decisionProcessed).toBe(false);
    expect(r.data.code).toBe("RUN_NOT_FOUND");
  });
});
