# Chunk 046 — Commercial Readiness: Auth, RBAC, Quotas, Deployment Safety

> **Created:** 2026-06-12
> **Branch:** `rector-0.2.0`
> **Depends on:** Chunks 043–045 for configurable product surface; Chunk 042 security hardening recommended before/alongside implementation
> **Goal:** Prepare Rector for real hosted/VPS commercial use by hardening identity, authorization, workspace isolation, quotas, audit logs, deployment checks, backups, and operator controls without breaking local/provider-free mode.

## Why This Chunk Exists

Rector's commercial promise requires more than a strong engine. Hosted or team use needs:

- real users and sessions
- workspace/team isolation
- RBAC for sensitive actions
- secrets protected per user/workspace
- quotas/budgets
- audit logs
- safe admin/operator actions
- deploy readiness checks
- backups/restore

Chunk 037 added opt-in multi-user session auth. Chunk 046 turns that into a production-ready authorization and operational layer.

Auth0, Clerk, WorkOS, Supabase Auth, or similar providers may be useful later. But this chunk should not make any external auth provider mandatory. Local mode and contributor mode must remain zero-config.

## Product Modes

Support three auth modes:

| Mode | Purpose | Default? |
|------|---------|----------|
| `local-dev` | no-login or simple local session; contributor friendly | yes for local |
| `self-hosted` | built-in username/password or invite-based users | yes for VPS |
| `external-oidc` | Auth0/Clerk/WorkOS/etc. via OIDC later | optional |

External auth providers should be adapter-based, not hardcoded.

## Identity Model

Add/strengthen these domain objects:

```ts
interface User {
  id: string;
  email?: string;
  displayName?: string;
  status: "active" | "disabled" | "invited";
  createdAt: string;
  updatedAt: string;
}

interface Workspace {
  id: string;
  name: string;
  ownerUserId: string;
  createdAt: string;
  updatedAt: string;
}

interface WorkspaceMembership {
  id: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  createdAt: string;
  updatedAt: string;
}
```

## RBAC Roles

Suggested workspace roles:

| Role | Capabilities |
|------|--------------|
| `owner` | all actions, billing/secrets/users/delete workspace |
| `admin` | configure providers/templates/modules, manage members except owner |
| `operator` | run/retry/approve/abort workflows, view logs/costs |
| `developer` | chat/run workflows, view own runs, use configured providers |
| `viewer` | read-only conversations/runs/docs |

## Permission Model

Define capability strings:

```ts
type Permission =
  | "workspace.read"
  | "workspace.update"
  | "members.manage"
  | "providers.read"
  | "providers.configure"
  | "providers.secrets.write"
  | "models.assign"
  | "memory.configure"
  | "templates.apply"
  | "modules.configure"
  | "runs.create"
  | "runs.read"
  | "runs.approve"
  | "runs.abort"
  | "operator.read"
  | "operator.manage"
  | "audit.read"
  | "billing.manage"
  | "secrets.rotate";
```

Centralize checks:

```ts
requirePermission(req, "providers.configure")
can(user, workspace, permission)
```

No route should hand-roll auth checks.

## Auth Provider Abstraction

Create interface:

```ts
interface AuthProviderAdapter {
  kind: "local" | "oidc" | "auth0" | "clerk" | "workos";
  getLoginUrl?(state: string): Promise<string>;
  handleCallback?(input: unknown): Promise<AuthIdentity>;
  verifySession(req: Request): Promise<AuthSession | undefined>;
  logout?(session: AuthSession): Promise<void>;
}
```

Initial implementation:

1. Local/session provider using current Chunk 037 foundations.
2. OIDC/Auth0 adapter design stub behind feature flag, not required.

Auth0 note:

- Auth0 startup credits/free year can be used later.
- Do not couple core product to Auth0.
- Implement OIDC adapter shape so Auth0 can plug in cleanly.

## Session Security

Harden current session behavior:

- secure cookie config for production
- same-site defaults
- CSRF protection for state-changing routes if cookie auth used
- session expiration + refresh
- logout invalidation
- password hash policy if local auth used
- lockout/rate limit login attempts
- audit failed login attempts without secret leakage

## Workspace/User Isolation

Every user-scoped object needs workspace/user boundaries:

- provider records
- provider secrets
- orchestration assignments
- memory provider records
- memory assignments
- templates
- conversations
- runs
- artifacts
- approvals
- audit logs

Add tests proving cross-user/workspace reads and writes are blocked.

## Secrets and Provider Config

Rules:

- Secret values never returned by API.
- Secret write requires `providers.secrets.write` or equivalent.
- Secret read is not exposed, only presence/lastUpdated.
- Secret rotation supported.
- Deleting provider should revoke/delete associated secret references if safe.

## Quotas and Budgets

Commercial readiness needs quotas beyond per-run budget:

```ts
interface QuotaPolicy {
  maxRunsPerDay?: number;
  maxUsdPerDay?: number;
  maxUsdPerMonth?: number;
  maxProviderCallsPerRun?: number;
  maxSandboxMinutesPerDay?: number;
  maxStorageMb?: number;
}
```

Apply at:

- run creation
- provider call preflight
- memory provider calls
- sandbox execution
- ponder/background jobs

Expose in UI:

- current usage
- remaining quota
- denial reason
- owner/admin controls

## Audit Logs

Add durable `AuditEvent` model:

```ts
interface AuditEvent {
  id: string;
  workspaceId?: string;
  actorUserId?: string;
  action: string;
  targetType: string;
  targetId?: string;
  outcome: "success" | "denied" | "failed";
  reason?: string;
  ipHash?: string;
  userAgentHash?: string;
  createdAt: string;
}
```

Log:

- login/logout/failure
- provider secret writes/rotations/deletes
- model assignment changes
- memory assignment changes
- template apply
- run approval/abort/retry
- quota denials
- sandbox denials
- admin/member changes

Never log secret values or raw prompts with possible sensitive data.

## Deployment Readiness Checks

Add `/api/setup/deployment-readiness` or extend setup status.

Checks:

- auth mode configured for production
- secure cookie secret configured
- persistence durable when production mode
- secret store writable/encrypted
- rate limiter production adapter or explicit local-only warning
- sandbox mode explicit
- provider configs validated
- memory providers tested
- telemetry configured or explicitly disabled
- backups configured or warning

## Backup/Restore Plan

Initial commercial baseline:

- export metadata/config without secrets
- encrypted backup of local secret store if user chooses
- SQLite backup guidance/helper
- TiDB backup docs/checklist
- memory provider export plan only where API supports it

Do not silently back up secrets to plaintext.

## API Surface

Add/extend:

```http
GET    /api/auth/session
POST   /api/auth/login
POST   /api/auth/logout
GET    /api/workspaces
POST   /api/workspaces
GET    /api/workspaces/:id/members
POST   /api/workspaces/:id/members
PATCH  /api/workspaces/:id/members/:memberId
DELETE /api/workspaces/:id/members/:memberId
GET    /api/rbac/permissions
GET    /api/audit/events
GET    /api/quotas
PUT    /api/quotas
GET    /api/setup/deployment-readiness
POST   /api/secrets/:id/rotate
```

Route permissions must be tested.

## UI Work

Add Settings/Admin panels:

- Users & Workspaces
- Roles & Permissions summary
- Quotas/Budgets
- Audit Log
- Deployment Readiness
- Secret Rotation

Local mode should hide or simplify advanced admin UI.

## Tests

Add:

- `tests/rbacPolicy.test.ts`
- `tests/authSessionHardening.test.ts`
- `tests/workspaceIsolation.test.ts`
- `tests/secretAccessControl.test.ts`
- `tests/quotaPolicy.test.ts`
- `tests/auditLog.test.ts`
- `tests/deploymentReadiness.test.ts`
- `tests/rbacApiAuthorization.test.ts`
- `tests/authUi.dom.test.ts`

Test cases:

- viewer cannot configure providers
- developer can create runs but cannot write secrets
- operator can approve/abort runs
- admin can apply templates
- owner can manage members/quotas
- cross-workspace provider config access denied
- secret value never returned
- failed permission creates audit event
- quota denial blocks provider call before spend
- local mode remains zero-config

## Acceptance Criteria

- RBAC permission system exists and protects sensitive routes.
- Workspace/user isolation is enforced for config, memory, providers, runs, and templates.
- Secret operations require explicit permission and never return values.
- Quota policy gates run/provider/sandbox/memory usage.
- Audit log records security-relevant actions with no secrets.
- Deployment readiness reports production blockers/warnings.
- External auth provider adapter shape exists but Auth0 is optional/not required.
- Local/provider-free mode remains contributor-friendly.
- `npm test`, `npm run build`, and `npm audit` pass.

## Risks

| Risk | Mitigation |
|------|------------|
| Auth0/vendor lock-in | implement generic OIDC/Auth adapter; Auth0 later |
| RBAC too complex | start with fixed roles + central permission map |
| Breaking local dev | local-dev mode remains default and tested |
| Secret leakage | no secret reads; redaction/audit tests |
| Cross-tenant data leak | workspace isolation tests for every route family |
| Quota false positives | clear denial reasons + owner override |

## Commercial Readiness After This Chunk

After Chunks 042–046, Rector should be much closer to a commercial beta:

- hardened engine
- configurable model routing
- configurable memory roles
- template onboarding
- RBAC/auth/quotas/audit/deployment checks

Still likely needed before full production/v1:

- billing/subscriptions
- production observability integrations
- robust backup/restore implementation
- hosted infrastructure automation
- formal security review
- compliance posture
- support/admin workflows

## Suggested Commit

```text
feat(chunk-046): plan commercial auth and rbac hardening
```
