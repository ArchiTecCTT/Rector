import type { Application, Request, Response } from "express";
import { z } from "zod";
import { redactString } from "../../security/redaction";
import type { UserStores } from "../../security/userStores";
import { permissionsForRole, type Permission, type WorkspaceRole } from "../../security/rbac";
import { WorkspaceMembershipSchema, type WorkspaceDirectory } from "../../security/workspaces";
import type { AuditLogService } from "../../security/auditLog";
import { QuotaPolicySchema, type QuotaService } from "../../security/quotas";
import { computeCommercialDeploymentReadiness } from "../../deployment/readiness";
import { sendRedactedRouteError } from "./routeError";

export type AuthorizationResult = { ok: true; workspaceId: string; role: WorkspaceRole };

export interface CommercialRoutesDeps {
  authEnabled: boolean;
  workspaceDirectory: WorkspaceDirectory;
  auditLog: AuditLogService;
  quotaService: QuotaService;
  deploymentEnv: Record<string, string | undefined>;
  authorize(
    req: Request,
    res: Response,
    permission: Permission,
    options?: { workspaceId?: string; targetType?: string; targetId?: string },
  ): Promise<AuthorizationResult | false>;
  requestActorId(req: Request): string;
  auditRequest(
    req: Request,
    input: {
      workspaceId?: string;
      actorUserId?: string;
      action: string;
      targetType: string;
      targetId?: string;
      outcome: "success" | "denied" | "failed";
      reason?: string;
    },
  ): Promise<void>;
  storesFor(req: Request): UserStores;
  sendRedacted(res: Response, status: number, payload: unknown): void;
  sendRedactedPreservingPresence<T>(
    res: Response,
    status: number,
    payload: T,
    reattach: (redacted: any) => unknown,
  ): void;
}


export function registerCommercialRoutes(app: Application, deps: CommercialRoutesDeps): void {
  const {
    authEnabled,
    workspaceDirectory,
    auditLog,
    quotaService,
    deploymentEnv,
    authorize,
    requestActorId,
    auditRequest,
    storesFor,
    sendRedacted,
    sendRedactedPreservingPresence,
  } = deps;

  // codeql[js/missing-rate-limiting]: Rate limited by apiRateLimitMiddleware via classifyRateLimitRoute.
  app.get("/api/rbac/permissions", async (req, res) => {
    const workspace = await authorize(req, res, "workspace.read", {
      workspaceId: typeof req.query.workspaceId === "string" ? req.query.workspaceId : undefined,
      targetType: "workspace",
    });
    if (!workspace) return;
    sendRedacted(res, 200, {
      workspaceId: workspace.workspaceId,
      role: workspace.role,
      permissions: permissionsForRole(workspace.role),
    });
  });

  app.get("/api/workspaces", async (req, res) => {
    try {
      const userId = requestActorId(req);
      const entries = authEnabled
        ? await workspaceDirectory.listWorkspacesForUser(userId)
        : [{ workspace: await workspaceDirectory.getDefaultWorkspaceForUser("default"), membership: WorkspaceMembershipSchema.parse({ id: "local-owner", workspaceId: "local", userId: "default", role: "owner", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }) }];
      sendRedacted(res, 200, {
        workspaces: entries.map((entry) => ({ ...entry.workspace, role: entry.membership.role })),
      });
    } catch (error) {
      sendRedactedRouteError(sendRedacted, res, 500, error);
    }
  });

  app.post("/api/workspaces", async (req, res) => {
    if (authEnabled && !req.rectorAuth) return res.status(401).json({ error: "Authentication required" });
    try {
      const body = z.object({ name: z.string().min(1) }).parse(req.body ?? {});
      const ownerUserId = requestActorId(req);
      const workspace = await workspaceDirectory.createWorkspace({ name: body.name, ownerUserId });
      await auditRequest(req, { workspaceId: workspace.id, action: "workspace.create", targetType: "workspace", targetId: workspace.id, outcome: "success" });
      sendRedacted(res, 201, { workspace });
    } catch (error) {
      sendRedactedRouteError(sendRedacted, res, 400, error);
    }
  });

  // codeql[js/missing-rate-limiting]: Rate limited by apiRateLimitMiddleware via classifyRateLimitRoute.
  app.get("/api/workspaces/:id/members", async (req, res) => {
    const workspace = await authorize(req, res, "members.manage", { workspaceId: req.params.id, targetType: "workspace", targetId: req.params.id });
    if (!workspace) return;
    try {
      sendRedacted(res, 200, { members: await workspaceDirectory.listMembers(workspace.workspaceId) });
    } catch (error) {
      sendRedactedRouteError(sendRedacted, res, 500, error);
    }
  });

  // codeql[js/missing-rate-limiting]: Rate limited by apiRateLimitMiddleware via classifyRateLimitRoute.
  app.post("/api/workspaces/:id/members", async (req, res) => {
    const workspace = await authorize(req, res, "members.manage", { workspaceId: req.params.id, targetType: "workspace", targetId: req.params.id });
    if (!workspace) return;
    try {
      const body = z.object({ userId: z.string().min(1), role: z.enum(["owner", "admin", "operator", "developer", "viewer"]) }).parse(req.body ?? {});
      const member = await workspaceDirectory.addMembership({ workspaceId: workspace.workspaceId, userId: body.userId, role: body.role });
      await auditRequest(req, { workspaceId: workspace.workspaceId, action: "members.add", targetType: "membership", targetId: member.id, outcome: "success" });
      sendRedacted(res, 201, { member });
    } catch (error) {
      sendRedactedRouteError(sendRedacted, res, 400, error);
    }
  });

  // codeql[js/missing-rate-limiting]: Rate limited by apiRateLimitMiddleware via classifyRateLimitRoute.
  app.patch("/api/workspaces/:id/members/:memberId", async (req, res) => {
    const workspace = await authorize(req, res, "members.manage", { workspaceId: req.params.id, targetType: "membership", targetId: req.params.memberId });
    if (!workspace) return;
    try {
      const body = z.object({ role: z.enum(["owner", "admin", "operator", "developer", "viewer"]) }).parse(req.body ?? {});
      const members = await workspaceDirectory.listMembers(workspace.workspaceId);
      if (!members.some((member) => member.id === req.params.memberId)) {
        return sendRedacted(res, 404, { error: "Member not found" });
      }
      const member = await workspaceDirectory.updateMembershipRole(req.params.memberId, body.role);
      if (!member) return sendRedacted(res, 404, { error: "Member not found" });
      await auditRequest(req, { workspaceId: workspace.workspaceId, action: "members.update", targetType: "membership", targetId: member.id, outcome: "success" });
      sendRedacted(res, 200, { member });
    } catch (error) {
      sendRedactedRouteError(sendRedacted, res, 400, error);
    }
  });

  // codeql[js/missing-rate-limiting]: Rate limited by apiRateLimitMiddleware via classifyRateLimitRoute.
  app.delete("/api/workspaces/:id/members/:memberId", async (req, res) => {
    const workspace = await authorize(req, res, "members.manage", { workspaceId: req.params.id, targetType: "membership", targetId: req.params.memberId });
    if (!workspace) return;
    const members = await workspaceDirectory.listMembers(workspace.workspaceId);
    const target = members.find((member) => member.id === req.params.memberId);
    if (!target) return sendRedacted(res, 404, { error: "Member not found" });
    const removed = await workspaceDirectory.removeMembership(req.params.memberId);
    await auditRequest(req, { workspaceId: workspace.workspaceId, action: "members.remove", targetType: "membership", targetId: req.params.memberId, outcome: removed ? "success" : "failed" });
    sendRedacted(res, 200, { removed, id: req.params.memberId });
  });

  // codeql[js/missing-rate-limiting]: Rate limited by apiRateLimitMiddleware via classifyRateLimitRoute.
  app.get("/api/audit/events", async (req, res) => {
    const workspace = await authorize(req, res, "audit.read", {
      workspaceId: typeof req.query.workspaceId === "string" ? req.query.workspaceId : undefined,
      targetType: "audit",
    });
    if (!workspace) return;
    const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
    const events = await auditLog.list({ workspaceId: workspace.workspaceId, limit: Number.isFinite(limitRaw) ? limitRaw : 100 });
    sendRedacted(res, 200, { events });
  });

  // codeql[js/missing-rate-limiting]: Rate limited by apiRateLimitMiddleware via classifyRateLimitRoute.
  app.get("/api/quotas", async (req, res) => {
    const workspace = await authorize(req, res, "workspace.read", {
      workspaceId: typeof req.query.workspaceId === "string" ? req.query.workspaceId : undefined,
      targetType: "quota",
    });
    if (!workspace) return;
    sendRedacted(res, 200, {
      workspaceId: workspace.workspaceId,
      policy: await quotaService.getPolicy(workspace.workspaceId),
      usage: await quotaService.getUsage(workspace.workspaceId),
    });
  });

  // codeql[js/missing-rate-limiting]: Rate limited by apiRateLimitMiddleware via classifyRateLimitRoute.
  app.put("/api/quotas", async (req, res) => {
    const workspaceId = typeof req.body?.workspaceId === "string" ? req.body.workspaceId : undefined;
    const workspace = await authorize(req, res, "billing.manage", { workspaceId, targetType: "quota" });
    if (!workspace) return;
    try {
      const policy = QuotaPolicySchema.parse(req.body?.policy ?? req.body ?? {});
      const saved = await quotaService.setPolicy(workspace.workspaceId, policy);
      await auditRequest(req, { workspaceId: workspace.workspaceId, action: "quota.update", targetType: "quota", outcome: "success" });
      sendRedacted(res, 200, { workspaceId: workspace.workspaceId, policy: saved });
    } catch (error) {
      sendRedactedRouteError(sendRedacted, res, 400, error);
    }
  });

  // codeql[js/missing-rate-limiting]: Rate limited by apiRateLimitMiddleware via classifyRateLimitRoute.
  app.get("/api/setup/deployment-readiness", async (req, res) => {
    const workspace = await authorize(req, res, "workspace.read", { targetType: "setup" });
    if (!workspace) return;
    sendRedacted(res, 200, computeCommercialDeploymentReadiness(deploymentEnv));
  });

  // codeql[js/missing-rate-limiting]: Rate limited by apiRateLimitMiddleware via classifyRateLimitRoute.
  app.post("/api/secrets/:id/rotate", async (req, res) => {
    const workspace = await authorize(req, res, "secrets.rotate", { targetType: "secret", targetId: req.params.id });
    if (!workspace) return;
    try {
      const body = z.object({ value: z.string().min(1) }).parse(req.body ?? {});
      const result = await storesFor(req).secretStore.setSecret(req.params.id, body.value);
      if (!result.ok) return sendRedacted(res, 500, { error: redactString(result.error) });
      await auditRequest(req, { workspaceId: workspace.workspaceId, action: "secret.rotate", targetType: "secret", targetId: req.params.id, outcome: "success" });
      sendRedactedPreservingPresence(res, 200, { id: req.params.id, rotated: true, secretPresent: true }, (redacted) => {
        redacted.secretPresent = true;
        return redacted;
      });
    } catch (error) {
      sendRedactedRouteError(sendRedacted, res, 400, error);
    }
  });
}
