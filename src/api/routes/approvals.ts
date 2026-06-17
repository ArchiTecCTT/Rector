import type { Application, Request, Response } from "express";
import type { Permission } from "../../security/rbac";
import {
  budgetApprovalRegistry,
  recordBudgetApprovalDecision,
  type BudgetApprovalRequest,
} from "../../security/budget";
import { codeqlRateLimitGuard } from "../codeqlRateLimitGuard";

type Authorize = (
  req: Request,
  res: Response,
  permission: Permission,
  options: { workspaceId?: string; targetType?: string; targetId?: string },
) => Promise<{ workspaceId: string } | false | undefined>;

export interface BudgetApprovalRoutesDeps {
  authorize: Authorize;
  sendRedacted(res: Response, status: number, payload: unknown): void;
}

/**
 * Budget approval API routes (Task 4.4).
 *
 * - `GET /api/budget/approvals` — list pending budget approval requests
 * - `POST /api/budget/approvals/:id/approve` — approve a pending request
 * - `POST /api/budget/approvals/:id/deny` — deny a pending request
 *
 * All responses are routed through `sendRedacted` so no secret substring escapes.
 */
export function registerBudgetApprovalRoutes(app: Application, deps: BudgetApprovalRoutesDeps): void {
  const { authorize, sendRedacted } = deps;

  // GET /api/budget/approvals — list pending budget approvals
  app.get("/api/budget/approvals", codeqlRateLimitGuard, async (req, res) => {
    const access = await authorize(req, res, "runs.approve", { targetType: "budget_approval" });
    if (!access) return;

    const pending = budgetApprovalRegistry.listPendingApprovals();
    return sendRedacted(res, 200, { approvals: sanitizeApprovalList(pending) });
  });

  // POST /api/budget/approvals/:id/approve — approve a pending budget request
  app.post("/api/budget/approvals/:id/approve", codeqlRateLimitGuard, async (req, res) => {
    const approvalId = req.params.id;
    const access = await authorize(req, res, "runs.approve", { targetType: "budget_approval", targetId: approvalId });
    if (!access) return;

    const existing = budgetApprovalRegistry.getApproval(approvalId);
    if (!existing) {
      return sendRedacted(res, 404, { error: "Budget approval request not found" });
    }
    if (existing.status !== "pending") {
      return sendRedacted(res, 409, { error: `Budget approval already ${existing.status}`, status: existing.status });
    }

    const decidedBy = (req.body as Record<string, unknown>)?.decidedBy;
    const updated = recordBudgetApprovalDecision(
      approvalId,
      "approved",
      typeof decidedBy === "string" && decidedBy.length > 0 ? decidedBy : undefined,
    );
    return sendRedacted(res, 200, { approval: sanitizeApproval(updated) });
  });

  // POST /api/budget/approvals/:id/deny — deny a pending budget request
  app.post("/api/budget/approvals/:id/deny", codeqlRateLimitGuard, async (req, res) => {
    const approvalId = req.params.id;
    const access = await authorize(req, res, "runs.approve", { targetType: "budget_approval", targetId: approvalId });
    if (!access) return;

    const existing = budgetApprovalRegistry.getApproval(approvalId);
    if (!existing) {
      return sendRedacted(res, 404, { error: "Budget approval request not found" });
    }
    if (existing.status !== "pending") {
      return sendRedacted(res, 409, { error: `Budget approval already ${existing.status}`, status: existing.status });
    }

    const decidedBy = (req.body as Record<string, unknown>)?.decidedBy;
    const updated = recordBudgetApprovalDecision(
      approvalId,
      "denied",
      typeof decidedBy === "string" && decidedBy.length > 0 ? decidedBy : undefined,
    );
    return sendRedacted(res, 200, { approval: sanitizeApproval(updated) });
  });
}

/** Sanitize an approval for egress — strip verbose usage details. */
function sanitizeApproval(request: BudgetApprovalRequest | undefined): Record<string, unknown> | undefined {
  if (!request) return undefined;
  return {
    id: request.id,
    runId: request.runId,
    reasons: request.reasons,
    status: request.status,
    decidedBy: request.decidedBy,
    decidedAt: request.decidedAt,
    createdAt: request.createdAt,
    estimatedUsd: request.usage.estimatedUsd,
  };
}

/** Sanitize a list of approvals for egress. */
function sanitizeApprovalList(requests: BudgetApprovalRequest[]): Record<string, unknown>[] {
  return requests.map(sanitizeApproval).filter((a): a is Record<string, unknown> => a !== undefined);
}
