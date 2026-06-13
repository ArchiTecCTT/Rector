import type { Application, Request, Response } from "express";
import type { Permission } from "../../security/rbac";
import { redactString } from "../../security/redaction";
import type { RectorStore } from "../../store";
import { interruptRun, steerRun } from "../../orchestration/runControl";

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

export interface RunControlRoutesDeps {
  store: RectorStore;
  workspaceIdForRun(runId: string): Promise<string | undefined>;
  authorize: Authorize;
  auditRequest?: AuditRequest;
  sendRedacted(res: Response, status: number, payload: unknown): void;
}

export function registerRunControlRoutes(app: Application, deps: RunControlRoutesDeps): void {
  const { store, workspaceIdForRun, authorize, auditRequest, sendRedacted } = deps;

  app.post("/api/runs/:runId/interrupt", async (req, res) => {
    const runId = req.params.runId;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.reason !== undefined && typeof body.reason !== "string") {
      return sendRedacted(res, 400, { error: "reason must be a string when provided" });
    }

    try {
      const workspaceId = await workspaceIdForRun(runId);
      const access = await authorize(req, res, "runs.abort", { workspaceId, targetType: "run", targetId: runId });
      if (!access) return;

      const result = await interruptRun(store, runId, body.reason);
      if (!result.ok) return sendRedacted(res, 404, { error: "Run not found" });
      await auditRequest?.(req, {
        workspaceId: access.workspaceId,
        action: "run.interrupt",
        targetType: "run",
        targetId: runId,
        outcome: "success",
      });
      return sendRedacted(res, 202, {
        runId,
        status: result.status === "already_terminal" ? result.run.status : "aborting",
        mutated: result.mutated,
      });
    } catch (error) {
      return sendRedacted(res, 500, { error: redactString(error instanceof Error ? error.message : String(error)) });
    }
  });

  app.post("/api/runs/:runId/steer", async (req, res) => {
    const runId = req.params.runId;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.message !== "string" || body.message.trim().length === 0) {
      return sendRedacted(res, 400, { error: "message (string) is required" });
    }

    try {
      const workspaceId = await workspaceIdForRun(runId);
      const access = await authorize(req, res, "runs.read", { workspaceId, targetType: "run", targetId: runId });
      if (!access) return;

      const result = await steerRun(store, runId, body.message);
      if (!result.ok) return sendRedacted(res, 404, { error: "Run not found" });
      await auditRequest?.(req, {
        workspaceId: access.workspaceId,
        action: "run.steer",
        targetType: "run",
        targetId: runId,
        outcome: "success",
      });
      return sendRedacted(res, 202, { runId, queued: result.queued });
    } catch (error) {
      return sendRedacted(res, 500, { error: redactString(error instanceof Error ? error.message : String(error)) });
    }
  });
}

