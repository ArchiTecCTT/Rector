import type { Request, Response } from "express";

/** Workspace-scoped roles used by the commercial readiness RBAC layer. */
export const WORKSPACE_ROLES = ["owner", "admin", "operator", "developer", "viewer"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/** Capability strings used by central route guards. */
export const PERMISSIONS = [
  "workspace.read",
  "workspace.update",
  "members.manage",
  "providers.read",
  "providers.configure",
  "providers.secrets.write",
  "models.assign",
  "memory.configure",
  "templates.apply",
  "modules.configure",
  "runs.create",
  "runs.read",
  "runs.approve",
  "runs.abort",
  "operator.read",
  "operator.manage",
  "audit.read",
  "billing.manage",
  "secrets.rotate",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL_PERMISSIONS = [...PERMISSIONS];

const ROLE_PERMISSIONS: Record<WorkspaceRole, readonly Permission[]> = {
  owner: ALL_PERMISSIONS,
  admin: [
    "workspace.read",
    "workspace.update",
    "members.manage",
    "providers.read",
    "providers.configure",
    "models.assign",
    "memory.configure",
    "templates.apply",
    "modules.configure",
    "runs.create",
    "runs.read",
    "runs.approve",
    "runs.abort",
    "operator.read",
    "operator.manage",
    "audit.read",
  ],
  operator: [
    "workspace.read",
    "providers.read",
    "runs.read",
    "runs.approve",
    "runs.abort",
    "operator.read",
    "operator.manage",
  ],
  developer: [
    "workspace.read",
    "providers.read",
    "templates.apply",
    "runs.create",
    "runs.read",
  ],
  viewer: ["workspace.read", "providers.read", "runs.read"],
};

export interface AuthorizationSubject {
  authEnabled: boolean;
  userId?: string;
  workspaceId?: string;
  role?: WorkspaceRole;
}

export interface AuthorizationDecision {
  allowed: boolean;
  permission: Permission;
  role: WorkspaceRole;
  workspaceId?: string;
  reason?: string;
}

export interface PermissionGrant {
  ok: true;
  permission: Permission;
  role: WorkspaceRole;
  workspaceId?: string;
}

export interface PermissionDenial {
  ok: false;
  permission: Permission;
  role: WorkspaceRole;
  workspaceId?: string;
  status: 403;
  reason: string;
}

export type PermissionResult = PermissionGrant | PermissionDenial;

/** True when `value` is one of Rector's fixed workspace roles. */
export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return typeof value === "string" && (WORKSPACE_ROLES as readonly string[]).includes(value);
}

/** True when `value` is a known permission string. */
export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && (PERMISSIONS as readonly string[]).includes(value);
}

/** Return the capability set granted to a role. */
export function permissionsForRole(role: WorkspaceRole): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

/** Pure role/permission predicate. */
export function canRole(role: WorkspaceRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/**
 * Pure authorization predicate. Auth-disabled local mode is intentionally treated as an owner in
 * the implicit local workspace so contributor mode remains zero-config.
 */
export function can(subject: AuthorizationSubject, permission: Permission): boolean {
  const role = subject.authEnabled ? subject.role : "owner";
  if (!role) return false;
  return canRole(role, permission);
}

/**
 * Central permission evaluator used by route guards. It returns a structured denial rather than
 * throwing, so API handlers can audit and redact the failure uniformly.
 */
export function requirePermission(subject: AuthorizationSubject, permission: Permission): PermissionResult {
  const role: WorkspaceRole = subject.authEnabled ? subject.role ?? "viewer" : "owner";
  if (subject.authEnabled && !subject.role) {
    return {
      ok: false,
      permission,
      role,
      workspaceId: subject.workspaceId,
      status: 403,
      reason: `No workspace role is assigned for permission "${permission}".`,
    };
  }
  if (canRole(role, permission)) {
    return { ok: true, permission, role, workspaceId: subject.workspaceId };
  }
  return {
    ok: false,
    permission,
    role,
    workspaceId: subject.workspaceId,
    status: 403,
    reason: `Role "${role}" does not have permission "${permission}".`,
  };
}

/** Express response helper for a central permission denial. */
export function sendPermissionDenied(res: Response, denial: PermissionDenial): void {
  res.status(denial.status).json({ error: "Permission denied", permission: denial.permission, reason: denial.reason });
}

/**
 * Convenience shape for code that wants `requirePermission(req, ...)` semantics after a route-level
 * guard has attached a workspace role to the request.
 */
declare module "express-serve-static-core" {
  interface Request {
    rectorWorkspace?: {
      workspaceId: string;
      role: WorkspaceRole;
    };
  }
}

export function requireRequestPermission(
  req: Request,
  permission: Permission,
  authEnabled: boolean,
): PermissionResult {
  return requirePermission(
    {
      authEnabled,
      userId: req.rectorAuth?.userId,
      workspaceId: req.rectorWorkspace?.workspaceId,
      role: req.rectorWorkspace?.role,
    },
    permission,
  );
}
