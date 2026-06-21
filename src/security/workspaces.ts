import { createHash } from "node:crypto";
import { z } from "zod";
import { sanitizeUserId } from "./userDataPaths";
import { WORKSPACE_ROLES, type WorkspaceRole } from "./rbac";

const NonEmptyStringSchema = z.string().min(1);
export const UserStatusSchema = z.enum(["active", "disabled", "invited"]);
export const WorkspaceRoleSchema = z.enum(WORKSPACE_ROLES);

export const UserSchema = z.object({
  id: NonEmptyStringSchema,
  email: z.string().email().optional(),
  displayName: z.string().min(1).optional(),
  status: UserStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type User = z.infer<typeof UserSchema>;

export const WorkspaceSchema = z.object({
  id: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
  ownerUserId: NonEmptyStringSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const WorkspaceMembershipSchema = z.object({
  id: NonEmptyStringSchema,
  workspaceId: NonEmptyStringSchema,
  userId: NonEmptyStringSchema,
  role: WorkspaceRoleSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type WorkspaceMembership = z.infer<typeof WorkspaceMembershipSchema>;

export interface WorkspaceDirectory {
  getUser(userId: string): Promise<User | undefined>;
  upsertUser(user: User): Promise<User>;
  getWorkspace(workspaceId: string): Promise<Workspace | undefined>;
  getDefaultWorkspaceForUser(userId: string): Promise<Workspace>;
  listWorkspacesForUser(userId: string): Promise<Array<{ workspace: Workspace; membership: WorkspaceMembership }>>;
  createWorkspace(input: { name: string; ownerUserId: string; id?: string }): Promise<Workspace>;
  getMembership(userId: string, workspaceId: string): Promise<WorkspaceMembership | undefined>;
  listMembers(workspaceId: string): Promise<WorkspaceMembership[]>;
  addMembership(input: { workspaceId: string; userId: string; role: WorkspaceRole; id?: string }): Promise<WorkspaceMembership>;
  updateMembershipRole(memberId: string, role: WorkspaceRole): Promise<WorkspaceMembership | undefined>;
  removeMembership(memberId: string): Promise<boolean>;
}

export interface InMemoryWorkspaceDirectoryOptions {
  users?: User[];
  workspaces?: Workspace[];
  memberships?: WorkspaceMembership[];
  autoProvisionPersonalWorkspaces?: boolean;
  now?: () => string;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function defaultUser(userId: string, now: string): User {
  return UserSchema.parse({
    id: userId,
    status: "active",
    displayName: userId === "default" ? "Local developer" : userId,
    createdAt: now,
    updatedAt: now,
  });
}

function workspaceIdForUser(userId: string): string {
  if (userId === "default") return "local";
  const sanitized = sanitizeUserId(userId);
  if (sanitized === userId) return `user-${sanitized}`;
  return `user-${sanitized}-${createHash("sha256").update(userId).digest("hex").slice(0, 8)}`;
}

function legacyWorkspaceIdForUser(userId: string): string {
  return userId === "default" ? "local" : `user-${sanitizeUserId(userId)}`;
}

function workspaceNameForUser(userId: string): string {
  return userId === "default" ? "Local Workspace" : `${userId}'s Workspace`;
}

export function createInMemoryWorkspaceDirectory(
  options: InMemoryWorkspaceDirectoryOptions = {},
): WorkspaceDirectory {
  const users = new Map<string, User>();
  const workspaces = new Map<string, Workspace>();
  const memberships = new Map<string, WorkspaceMembership>();
  const autoProvisionPersonalWorkspaces = options.autoProvisionPersonalWorkspaces ?? true;
  const now = options.now ?? (() => new Date().toISOString());
  let workspaceCounter = 0;
  let membershipCounter = 0;

  for (const user of options.users ?? []) users.set(user.id, UserSchema.parse(clone(user)));
  for (const workspace of options.workspaces ?? []) workspaces.set(workspace.id, WorkspaceSchema.parse(clone(workspace)));
  for (const membership of options.memberships ?? []) {
    memberships.set(membership.id, WorkspaceMembershipSchema.parse(clone(membership)));
  }

  function nextWorkspaceId(): string {
    do {
      workspaceCounter += 1;
    } while (workspaces.has(`ws-${workspaceCounter}`));
    return `ws-${workspaceCounter}`;
  }

  function nextMembershipId(): string {
    do {
      membershipCounter += 1;
    } while (memberships.has(`member-${membershipCounter}`));
    return `member-${membershipCounter}`;
  }

  function ensureUser(userId: string): User {
    const existing = users.get(userId);
    if (existing) return existing;
    const stamped = now();
    const user = defaultUser(userId, stamped);
    users.set(user.id, clone(user));
    return user;
  }

  function membershipsForUser(userId: string): WorkspaceMembership[] {
    return Array.from(memberships.values()).filter((membership) => membership.userId === userId);
  }

  function ensurePersonalWorkspace(userId: string): Workspace {
    const user = ensureUser(userId);
    const personalWorkspaceIds = [workspaceIdForUser(user.id), legacyWorkspaceIdForUser(user.id)];
    const existingPersonalWorkspace = personalWorkspaceIds
      .map((workspaceId) => workspaces.get(workspaceId))
      .find((workspace): workspace is Workspace => workspace !== undefined && workspace.ownerUserId === user.id);

    if (existingPersonalWorkspace) {
      const existingMembership = Array.from(memberships.values()).find(
        (membership) => membership.workspaceId === existingPersonalWorkspace.id && membership.userId === user.id,
      );
      if (!existingMembership) {
        const stamped = now();
        const membership = WorkspaceMembershipSchema.parse({
          id: uniqueMembershipId(`member-${existingPersonalWorkspace.id}-${sanitizeUserId(user.id)}`),
          workspaceId: existingPersonalWorkspace.id,
          userId: user.id,
          role: "owner",
          createdAt: stamped,
          updatedAt: stamped,
        });
        memberships.set(membership.id, clone(membership));
      }
      return existingPersonalWorkspace;
    }

    const stamped = now();
    const workspace = WorkspaceSchema.parse({
      id: workspaceIdForUser(user.id),
      name: workspaceNameForUser(user.id),
      ownerUserId: user.id,
      createdAt: stamped,
      updatedAt: stamped,
    });
    if (workspaces.has(workspace.id)) {
      throw new Error(`Personal workspace id collision for user ${user.id}`);
    }
    workspaces.set(workspace.id, clone(workspace));
    const membership = WorkspaceMembershipSchema.parse({
      id: uniqueMembershipId(`member-${workspace.id}-${sanitizeUserId(user.id)}`),
      workspaceId: workspace.id,
      userId: user.id,
      role: "owner",
      createdAt: stamped,
      updatedAt: stamped,
    });
    memberships.set(membership.id, clone(membership));
    return workspace;
  }

  function uniqueMembershipId(preferred: string): string {
    if (!memberships.has(preferred)) return preferred;
    return nextMembershipId();
  }

  return {
    async getUser(userId: string): Promise<User | undefined> {
      const user = users.get(userId);
      return user ? clone(user) : undefined;
    },

    async upsertUser(user: User): Promise<User> {
      const parsed = UserSchema.parse(clone(user));
      users.set(parsed.id, clone(parsed));
      return clone(parsed);
    },

    async getWorkspace(workspaceId: string): Promise<Workspace | undefined> {
      const workspace = workspaces.get(workspaceId);
      return workspace ? clone(workspace) : undefined;
    },

    async getDefaultWorkspaceForUser(userId: string): Promise<Workspace> {
      if (autoProvisionPersonalWorkspaces) return clone(ensurePersonalWorkspace(userId));
      const membershipsForCurrentUser = membershipsForUser(userId);
      const first = membershipsForCurrentUser[0];
      const workspace = first ? workspaces.get(first.workspaceId) : undefined;
      if (workspace) return clone(workspace);
      throw new Error(`No default workspace is provisioned for user ${userId}`);
    },

    async listWorkspacesForUser(userId: string): Promise<Array<{ workspace: Workspace; membership: WorkspaceMembership }>> {
      if (autoProvisionPersonalWorkspaces && membershipsForUser(userId).length === 0) {
        ensurePersonalWorkspace(userId);
      }
      return membershipsForUser(userId)
        .map((membership) => {
          const workspace = workspaces.get(membership.workspaceId);
          return workspace ? { workspace: clone(workspace), membership: clone(membership) } : undefined;
        })
        .filter((entry): entry is { workspace: Workspace; membership: WorkspaceMembership } => entry !== undefined);
    },

    async createWorkspace(input: { name: string; ownerUserId: string; id?: string }): Promise<Workspace> {
      ensureUser(input.ownerUserId);
      const stamped = now();
      const workspace = WorkspaceSchema.parse({
        id: input.id ?? nextWorkspaceId(),
        name: input.name,
        ownerUserId: input.ownerUserId,
        createdAt: stamped,
        updatedAt: stamped,
      });
      if (workspaces.has(workspace.id)) {
        throw new Error(`Workspace id already exists: ${workspace.id}`);
      }
      workspaces.set(workspace.id, clone(workspace));
      const membership = WorkspaceMembershipSchema.parse({
        id: nextMembershipId(),
        workspaceId: workspace.id,
        userId: input.ownerUserId,
        role: "owner",
        createdAt: stamped,
        updatedAt: stamped,
      });
      memberships.set(membership.id, clone(membership));
      return clone(workspace);
    },

    async getMembership(userId: string, workspaceId: string): Promise<WorkspaceMembership | undefined> {
      if (autoProvisionPersonalWorkspaces && (workspaceId === workspaceIdForUser(userId) || workspaceId === legacyWorkspaceIdForUser(userId))) {
        ensurePersonalWorkspace(userId);
      }
      const membership = Array.from(memberships.values()).find(
        (candidate) => candidate.userId === userId && candidate.workspaceId === workspaceId,
      );
      return membership ? clone(membership) : undefined;
    },

    async listMembers(workspaceId: string): Promise<WorkspaceMembership[]> {
      return Array.from(memberships.values())
        .filter((membership) => membership.workspaceId === workspaceId)
        .map(clone);
    },

    async addMembership(input: { workspaceId: string; userId: string; role: WorkspaceRole; id?: string }): Promise<WorkspaceMembership> {
      ensureUser(input.userId);
      if (!workspaces.has(input.workspaceId)) {
        throw new Error(`Workspace not found: ${input.workspaceId}`);
      }
      const existing = Array.from(memberships.values()).find(
        (membership) => membership.workspaceId === input.workspaceId && membership.userId === input.userId,
      );
      const stamped = now();
      if (existing) {
        const updated = WorkspaceMembershipSchema.parse({ ...existing, role: input.role, updatedAt: stamped });
        memberships.set(updated.id, clone(updated));
        return clone(updated);
      }
      const membership = WorkspaceMembershipSchema.parse({
        id: input.id ?? nextMembershipId(),
        workspaceId: input.workspaceId,
        userId: input.userId,
        role: input.role,
        createdAt: stamped,
        updatedAt: stamped,
      });
      memberships.set(membership.id, clone(membership));
      return clone(membership);
    },

    async updateMembershipRole(memberId: string, role: WorkspaceRole): Promise<WorkspaceMembership | undefined> {
      const current = memberships.get(memberId);
      if (!current) return undefined;
      const updated = WorkspaceMembershipSchema.parse({ ...current, role, updatedAt: now() });
      memberships.set(memberId, clone(updated));
      return clone(updated);
    },

    async removeMembership(memberId: string): Promise<boolean> {
      return memberships.delete(memberId);
    },
  };
}

/** Return true when `workspaceId` is one of the user's accessible workspaces. */
export async function userCanAccessWorkspace(
  directory: WorkspaceDirectory,
  userId: string,
  workspaceId: string,
): Promise<boolean> {
  return (await directory.getMembership(userId, workspaceId)) !== undefined;
}
