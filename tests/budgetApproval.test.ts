import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Application } from "express";
import request from "supertest";
import {
  evaluateBudget,
  budgetApprovalRegistry,
  recordBudgetApprovalDecision,
  waitForBudgetApproval,
  BUDGET_APPROVAL_TIMEOUT_MS,
  type BudgetApprovalRequest,
} from "../src/security/budget";
import { registerBudgetApprovalRoutes } from "../src/api/routes/approvals";
import { RUN_EVENT_TYPES } from "../src/protocol/events";
import { handleBudgetApprovalNeeded } from "../src/orchestration/chatRunner";
import type { Run } from "../src/store/schemas";

// --- Test doubles ---

function makeTestRun(overrides: Partial<Run["budget"]> = {}): Run {
  return {
    id: "run-test-1",
    conversationId: "conv-1",
    workspaceId: "ws-1",
    status: "running",
    phase: "EXECUTING",
    budget: {
      maxUsd: 10,
      maxInputTokens: 500_000,
      maxOutputTokens: 500_000,
      maxModelCalls: 1_000,
      maxRuntimeMs: 30 * 60 * 1000,
      maxHealingAttempts: 10,
      allowedProviders: [],
      approvalRequiredAboveUsd: 1,
      ...overrides,
    },
    costEstimate: { usd: 0, inputTokens: 0, outputTokens: 0, modelCalls: 0, runtimeMs: 0 },
    tokenEstimate: { input: 0, output: 0 },
    healingAttempts: 0,
    traceId: "trace-1",
    version: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as unknown as Run;
}

function cleanupRegistry(): void {
  for (const approval of budgetApprovalRegistry.listPendingApprovals()) {
    budgetApprovalRegistry.recordDecision(approval.id, "denied", "cleanup");
  }
}

// --- Budget approval registry tests ---

describe("BudgetApprovalRegistry", () => {
  beforeEach(() => {
    cleanupRegistry();
  });

  it("creates an approval request and returns its ID", () => {
    const run = makeTestRun();
    const decision = evaluateBudget(run, { estimatedUsd: 5 });
    expect(decision.status).toBe("NEEDS_DECISION");

    const approvalId = budgetApprovalRegistry.createApproval(
      run.id,
      decision.reasons,
      decision.usage,
    );
    expect(approvalId).toMatch(/^budget-approval-/);

    const stored = budgetApprovalRegistry.getApproval(approvalId);
    expect(stored).toBeDefined();
    expect(stored!.runId).toBe(run.id);
    expect(stored!.status).toBe("pending");
    expect(stored!.reasons).toEqual(decision.reasons);
  });

  it("lists pending approvals", () => {
    const run = makeTestRun();
    const decision = evaluateBudget(run, { estimatedUsd: 5 });

    budgetApprovalRegistry.createApproval(run.id, decision.reasons, decision.usage);
    budgetApprovalRegistry.createApproval(run.id, decision.reasons, decision.usage);

    const pending = budgetApprovalRegistry.listPendingApprovals();
    expect(pending.length).toBeGreaterThanOrEqual(2);
  });

  it("records an approve decision", () => {
    const run = makeTestRun();
    const decision = evaluateBudget(run, { estimatedUsd: 5 });
    const approvalId = budgetApprovalRegistry.createApproval(
      run.id,
      decision.reasons,
      decision.usage,
    );

    const result = recordBudgetApprovalDecision(approvalId, "approved", "admin");
    expect(result).toBeDefined();
    expect(result!.status).toBe("approved");
    expect(result!.decidedBy).toBe("admin");
    expect(result!.decidedAt).toBeDefined();
  });

  it("records a deny decision", () => {
    const run = makeTestRun();
    const decision = evaluateBudget(run, { estimatedUsd: 5 });
    const approvalId = budgetApprovalRegistry.createApproval(
      run.id,
      decision.reasons,
      decision.usage,
    );

    const result = recordBudgetApprovalDecision(approvalId, "denied", "admin");
    expect(result).toBeDefined();
    expect(result!.status).toBe("denied");
    expect(result!.decidedBy).toBe("admin");
  });

  it("returns undefined for non-existent approval on recordDecision", () => {
    const result = recordBudgetApprovalDecision("non-existent-id", "approved");
    expect(result).toBeUndefined();
  });

  it("does not change status of already-decided approval", () => {
    const run = makeTestRun();
    const decision = evaluateBudget(run, { estimatedUsd: 5 });
    const approvalId = budgetApprovalRegistry.createApproval(
      run.id,
      decision.reasons,
      decision.usage,
    );

    recordBudgetApprovalDecision(approvalId, "approved", "admin1");
    const secondDecision = recordBudgetApprovalDecision(approvalId, "denied", "admin2");
    expect(secondDecision!.status).toBe("approved");
  });

  it("waitForDecision resolves immediately for already-decided approval", async () => {
    const run = makeTestRun();
    const decision = evaluateBudget(run, { estimatedUsd: 5 });
    const approvalId = budgetApprovalRegistry.createApproval(
      run.id,
      decision.reasons,
      decision.usage,
    );

    recordBudgetApprovalDecision(approvalId, "approved", "admin");
    const result = await waitForBudgetApproval(approvalId, 100);
    expect(result).toBe("approved");
  });

  it("waitForDecision resolves when decision is recorded while waiting", async () => {
    const run = makeTestRun();
    const decision = evaluateBudget(run, { estimatedUsd: 5 });
    const approvalId = budgetApprovalRegistry.createApproval(
      run.id,
      decision.reasons,
      decision.usage,
    );

    // Schedule a decision after a short delay
    setTimeout(() => {
      recordBudgetApprovalDecision(approvalId, "approved", "admin");
    }, 50);

    const result = await waitForBudgetApproval(approvalId, 5000);
    expect(result).toBe("approved");
  });

  it("waitForDecision times out when no decision is recorded", async () => {
    const run = makeTestRun();
    const decision = evaluateBudget(run, { estimatedUsd: 5 });
    const approvalId = budgetApprovalRegistry.createApproval(
      run.id,
      decision.reasons,
      decision.usage,
    );

    const result = await waitForBudgetApproval(approvalId, 100);
    expect(result).toBe("timeout");
  });

  it("waitForDecision returns timeout for non-existent approval", async () => {
    const result = await waitForBudgetApproval("non-existent", 100);
    expect(result).toBe("timeout");
  });

  it("marks request as denied on timeout", async () => {
    const run = makeTestRun();
    const decision = evaluateBudget(run, { estimatedUsd: 5 });
    const approvalId = budgetApprovalRegistry.createApproval(
      run.id,
      decision.reasons,
      decision.usage,
    );

    await waitForBudgetApproval(approvalId, 100);

    const stored = budgetApprovalRegistry.getApproval(approvalId);
    expect(stored!.status).toBe("denied");
    expect(stored!.decidedBy).toBe("timeout");
  });
});

// --- BUDGET_APPROVAL_TIMEOUT_MS constant ---

describe("BUDGET_APPROVAL_TIMEOUT_MS", () => {
  it("is 5 minutes", () => {
    expect(BUDGET_APPROVAL_TIMEOUT_MS).toBe(5 * 60 * 1000);
  });
});

// --- BUDGET_APPROVAL_REQUESTED event type ---

describe("BUDGET_APPROVAL_REQUESTED event type", () => {
  it("is in the RUN_EVENT_TYPES array", () => {
    expect(RUN_EVENT_TYPES).toContain("BUDGET_APPROVAL_REQUESTED");
  });
});

// --- handleBudgetApprovalNeeded integration ---

describe("handleBudgetApprovalNeeded", () => {
  beforeEach(() => {
    cleanupRegistry();
  });

  const mockStore = {
    appendEvent: vi.fn().mockResolvedValue({ id: "evt-1", runId: "run-test-1" }),
  };

  it("creates approval, emits SSE event, and returns approved", async () => {
    vi.clearAllMocks();
    const run = makeTestRun();
    const decision = evaluateBudget(run, { estimatedUsd: 5 });

    // Schedule approval after short delay — we need to find the approval ID
    // that handleBudgetApprovalNeeded creates. We'll look it up from the registry.
    setTimeout(() => {
      const pending = budgetApprovalRegistry.listPendingApprovals();
      const latest = pending[pending.length - 1];
      if (latest) {
        recordBudgetApprovalDecision(latest.id, "approved", "test-user");
      }
    }, 50);

    const result = await handleBudgetApprovalNeeded(
      mockStore as any,
      run,
      decision,
      "trace-1",
      5000,
    );
    expect(result).toBe("approved");
    expect(mockStore.appendEvent).toHaveBeenCalledTimes(1);
    const eventArg = mockStore.appendEvent.mock.calls[0][0];
    expect(eventArg.type).toBe("BUDGET_APPROVAL_REQUESTED");
    expect(eventArg.runId).toBe(run.id);
  });

  it("returns denied when budget is denied", async () => {
    vi.clearAllMocks();
    const run = makeTestRun();
    const decision = evaluateBudget(run, { estimatedUsd: 5 });

    setTimeout(() => {
      const pending = budgetApprovalRegistry.listPendingApprovals();
      const latest = pending[pending.length - 1];
      if (latest) {
        recordBudgetApprovalDecision(latest.id, "denied", "test-user");
      }
    }, 50);

    const result = await handleBudgetApprovalNeeded(
      mockStore as any,
      run,
      decision,
      "trace-1",
      5000,
    );
    expect(result).toBe("denied");
  });

  it("returns timeout when no decision within timeout", async () => {
    vi.clearAllMocks();
    const run = makeTestRun();
    const decision = evaluateBudget(run, { estimatedUsd: 5 });

    const result = await handleBudgetApprovalNeeded(
      mockStore as any,
      run,
      decision,
      "trace-1",
      100,
    );
    expect(result).toBe("timeout");
  });

  it("emits BUDGET_APPROVAL_REQUESTED event with approval ID and reasons", async () => {
    vi.clearAllMocks();
    const run = makeTestRun();
    const decision = evaluateBudget(run, { estimatedUsd: 5 });

    setTimeout(() => {
      const pending = budgetApprovalRegistry.listPendingApprovals();
      const latest = pending[pending.length - 1];
      if (latest) {
        recordBudgetApprovalDecision(latest.id, "approved", "test-user");
      }
    }, 50);

    await handleBudgetApprovalNeeded(mockStore as any, run, decision, "trace-1", 5000);

    const eventArg = mockStore.appendEvent.mock.calls[0][0];
    expect(eventArg.type).toBe("BUDGET_APPROVAL_REQUESTED");
    expect(eventArg.payload.approvalId).toMatch(/^budget-approval-/);
    expect(eventArg.payload.reasons).toEqual(decision.reasons);
    expect(eventArg.payload.estimatedUsd).toBe(decision.usage.estimatedUsd);
  });
});

// --- Approval route tests ---

describe("Budget approval API routes", () => {
  let app: Application;

  beforeEach(() => {
    cleanupRegistry();

    app = express() as Application;
    app.use(express.json({ limit: "1mb" }));

    const mockAuthorize = async () => {
      return { workspaceId: "ws-1" };
    };

    const mockSendRedacted = (_res: any, status: number, payload: unknown) => {
      _res.status(status).json(payload);
    };

    registerBudgetApprovalRoutes(app, {
      authorize: mockAuthorize as any,
      sendRedacted: mockSendRedacted as any,
    });
  });

  it("GET /api/budget/approvals returns pending approvals", async () => {
    const run = makeTestRun();
    const decision = evaluateBudget(run, { estimatedUsd: 5 });
    budgetApprovalRegistry.createApproval(run.id, decision.reasons, decision.usage);

    const response = await request(app).get("/api/budget/approvals");
    expect(response.status).toBe(200);
    expect(response.body.approvals).toBeDefined();
    expect(Array.isArray(response.body.approvals)).toBe(true);
    expect(response.body.approvals.length).toBeGreaterThanOrEqual(1);
  });

  it("POST /api/budget/approvals/:id/approve approves a pending request", async () => {
    const run = makeTestRun();
    const decision = evaluateBudget(run, { estimatedUsd: 5 });
    const approvalId = budgetApprovalRegistry.createApproval(
      run.id,
      decision.reasons,
      decision.usage,
    );

    const response = await request(app)
      .post(`/api/budget/approvals/${approvalId}/approve`)
      .send({ decidedBy: "test-admin" });
    expect(response.status).toBe(200);
    expect(response.body.approval).toBeDefined();
    expect(response.body.approval.status).toBe("approved");

    const stored = budgetApprovalRegistry.getApproval(approvalId);
    expect(stored!.status).toBe("approved");
    expect(stored!.decidedBy).toBe("test-admin");
  });

  it("POST /api/budget/approvals/:id/deny denies a pending request", async () => {
    const run = makeTestRun();
    const decision = evaluateBudget(run, { estimatedUsd: 5 });
    const approvalId = budgetApprovalRegistry.createApproval(
      run.id,
      decision.reasons,
      decision.usage,
    );

    const response = await request(app)
      .post(`/api/budget/approvals/${approvalId}/deny`)
      .send({ decidedBy: "test-admin" });
    expect(response.status).toBe(200);
    expect(response.body.approval.status).toBe("denied");
  });

  it("POST /api/budget/approvals/:id/approve returns 404 for non-existent approval", async () => {
    const response = await request(app)
      .post("/api/budget/approvals/non-existent/approve")
      .send({});
    expect(response.status).toBe(404);
  });

  it("POST /api/budget/approvals/:id/deny returns 404 for non-existent approval", async () => {
    const response = await request(app)
      .post("/api/budget/approvals/non-existent/deny")
      .send({});
    expect(response.status).toBe(404);
  });

  it("POST /api/budget/approvals/:id/approve returns 409 for already-decided approval", async () => {
    const run = makeTestRun();
    const decision = evaluateBudget(run, { estimatedUsd: 5 });
    const approvalId = budgetApprovalRegistry.createApproval(
      run.id,
      decision.reasons,
      decision.usage,
    );

    // Approve first
    await request(app)
      .post(`/api/budget/approvals/${approvalId}/approve`)
      .send({ decidedBy: "admin1" });

    // Try to approve again
    const response = await request(app)
      .post(`/api/budget/approvals/${approvalId}/approve`)
      .send({ decidedBy: "admin2" });
    expect(response.status).toBe(409);
  });

  it("POST /api/budget/approvals/:id/deny returns 409 for already-decided approval", async () => {
    const run = makeTestRun();
    const decision = evaluateBudget(run, { estimatedUsd: 5 });
    const approvalId = budgetApprovalRegistry.createApproval(
      run.id,
      decision.reasons,
      decision.usage,
    );

    // Deny first
    await request(app)
      .post(`/api/budget/approvals/${approvalId}/deny`)
      .send({ decidedBy: "admin1" });

    // Try to deny again
    const response = await request(app)
      .post(`/api/budget/approvals/${approvalId}/deny`)
      .send({ decidedBy: "admin2" });
    expect(response.status).toBe(409);
  });
});
