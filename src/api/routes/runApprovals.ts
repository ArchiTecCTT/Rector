import type { Application, Request, Response } from "express";
import type { Permission } from "../../security/rbac";
import { redactString } from "../../security/redaction";
import type { RectorStore } from "../../store";
import {
  ApprovalProcessingError,
  recordApprovalDecision,
  type ApprovalDecision,
} from "../approvalFlow";

type Authorize = (
  req: Request,
  res: Response,
  permission: Permission,
  options: { workspaceId?: string; targetType?: string; targetId?: string },
) => Promise<{ workspaceId: string } | false | undefined>;

type AuditRequest = (
  req: Request,
  input: {
    workspaceId?: string;
    action: string;
    targetType: string;
    targetId?: string;
    outcome: "success" | "denied";
    reason?: string;
  },
) => Promise<void>;

export interface RunApprovalRoutesDeps {
  store: RectorStore;
  workspaceIdForRun(runId: string): Promise<string | undefined>;
  authorize: Authorize;
  auditRequest: AuditRequest;
  sendRedacted(res: Response, status: number, payload: unknown): void;
}

/**
 * Run Approval UX decision endpoint (Requirement 9). Records a user's approve/deny decision over a
 * pending operation and continues the run. `recordApprovalDecision` appends the decision (with the
 * deciding identity and timestamp) to the Event_Log atomically with the run transition, BEFORE the
 * operation executes or is cancelled (Req 9.3): an approval resumes to EXECUTING, a denial (or a
 * 30-minute timeout) resumes to a final answer that excludes the operation (Req 9.5, 9.8). When the
 * decision cannot be recorded — the run is not awaiting this operation's decision, or the Event_Log
 * write fails — the run is left pending and a redacted indication is surfaced (Req 9.7). Every
 * outbound message is routed through `redactString` so no secret substring escapes (Req 9.6/11.3).
 */
export function registerRunApprovalRoutes(app: Application, deps: RunApprovalRoutesDeps): void {
  const { store, workspaceIdForRun, authorize, auditRequest, sendRedacted } = deps;

  // codeql[js/missing-rate-limiting]: Rate limited by apiRateLimitMiddleware via classifyRateLimitRoute.
  app.post("/api/runs/:id/decision", async (req, res) => {
    const runId = req.params.id;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { operationId, decision, decidedBy } = body;

    if (typeof operationId !== "string" || operationId.length === 0) {
      return res.status(400).json({ error: "operationId (string) is required" });
    }
    if (decision !== "approve" && decision !== "deny") {
      return res.status(400).json({ error: "decision must be 'approve' or 'deny'" });
    }
    if (typeof decidedBy !== "string" || decidedBy.length === 0) {
      return res.status(400).json({ error: "decidedBy (string) is required" });
    }

    try {
      const workspaceId = await workspaceIdForRun(runId);
      const access = await authorize(req, res, "runs.approve", { workspaceId, targetType: "run", targetId: runId });
      if (!access) return;
      const record = await recordApprovalDecision(
        store,
        { runId, operationId, decision: decision as ApprovalDecision, decidedBy },
        {},
      );
      // Outbound boundary: route the decision record through the suppression helper so a redaction
      // failure suppresses the raw record and returns a redaction-failed error (Req 9.6, 11.1, 11.5).
      await auditRequest(req, { workspaceId: access.workspaceId, action: "run.decision", targetType: "run", targetId: runId, outcome: "success" });
      return sendRedacted(res, 200, { decisionProcessed: true, record });
    } catch (error) {
      if (error instanceof ApprovalProcessingError) {
        // Req 9.7: do not execute, keep the run in its pending-decision state, and indicate the
        // decision could not be processed. RUN_NOT_FOUND maps to 404; everything else is a conflict
        // with the run's current state (409).
        const httpStatus = error.code === "RUN_NOT_FOUND" ? 404 : 409;
        return sendRedacted(res, httpStatus, {
          decisionProcessed: false,
          code: error.code,
          error: redactString(error.message),
        });
      }
      return sendRedacted(res, 500, {
        decisionProcessed: false,
        error: redactString(error instanceof Error ? error.message : String(error)),
      });
    }
  });
}
