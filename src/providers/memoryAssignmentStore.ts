import { randomBytes } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { redactString } from "../security/redaction";
import { ensureRestrictedDir } from "../security/filePermissions";
import type { AuthorizationSubject } from "../security/rbac.js";
import { can } from "../security/rbac.js";
import {
  MemoryAssignmentStateSchema,
  MemoryRoleAssignmentSchema,
  emptyMemoryAssignmentState,
  type MemoryAssignmentState,
  type MemoryRole,
  type MemoryRoleAssignment,
} from "./memoryAssignments";

export type MemoryAssignmentResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export interface MemoryAssignmentFilter {
  userId?: string;
  workspaceId?: string;
  role?: MemoryRole;
}

export interface MemoryAssignmentStore {
  getState(): Promise<MemoryAssignmentState>;
  listAssignments(filter?: MemoryAssignmentFilter): Promise<MemoryRoleAssignment[]>;
  upsertAssignment(assignment: MemoryRoleAssignment): Promise<MemoryAssignmentResult<MemoryRoleAssignment>>;
  removeAssignment(id: string): Promise<MemoryAssignmentResult<void>>;
  resetAssignments(filter?: MemoryAssignmentFilter): Promise<MemoryAssignmentResult<void>>;
}

// Chunk 045's template implementation used this name before Chunk 044's durable store landed.
export type MemoryRoleAssignmentStore = MemoryAssignmentStore;

export interface MemoryAssignmentFs {
  readFile(path: string): Promise<string | undefined>;
  writeFile(path: string, data: string): Promise<void>;
  rename(fromPath: string, toPath: string): Promise<void>;
  mkdir(dirPath: string): Promise<void>;
}

export interface LocalMemoryAssignmentStoreOptions {
  filePath: string;
  fsImpl?: MemoryAssignmentFs;
}

function defaultMemoryAssignmentFs(): MemoryAssignmentFs {
  return {
    async readFile(path: string): Promise<string | undefined> {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
        throw error;
      }
    },
    async writeFile(path: string, data: string): Promise<void> {
      await writeFile(path, data, "utf8");
    },
    async rename(fromPath: string, toPath: string): Promise<void> {
      await rename(fromPath, toPath);
    },
    async mkdir(dirPath: string): Promise<void> {
      ensureRestrictedDir(dirPath);
    },
  };
}

function toRedactedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactString(message);
}

function matchesFilter(assignment: MemoryRoleAssignment, filter: MemoryAssignmentFilter = {}): boolean {
  if (filter.role !== undefined && assignment.role !== filter.role) return false;
  if (filter.userId !== undefined && assignment.userId !== filter.userId) return false;
  return !(filter.workspaceId !== undefined && assignment.workspaceId !== filter.workspaceId);
}

function normalizeAssignment(assignment: MemoryRoleAssignment): MemoryRoleAssignment {
  return MemoryRoleAssignmentSchema.parse(assignment);
}

export function createLocalMemoryAssignmentStore(
  options: LocalMemoryAssignmentStoreOptions,
): MemoryAssignmentStore {
  const { filePath } = options;
  const fsImpl = options.fsImpl ?? defaultMemoryAssignmentFs();

  async function readState(): Promise<MemoryAssignmentState> {
    const raw = await fsImpl.readFile(filePath);
    if (raw === undefined || raw.trim() === "") return emptyMemoryAssignmentState();
    const parsed = MemoryAssignmentStateSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return emptyMemoryAssignmentState();
    return parsed.data;
  }

  async function writeState(state: MemoryAssignmentState): Promise<void> {
    await fsImpl.mkdir(dirname(filePath));
    const tempPath = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
    await fsImpl.writeFile(tempPath, JSON.stringify(state, null, 2));
    await fsImpl.rename(tempPath, filePath);
  }

  return {
    async getState(): Promise<MemoryAssignmentState> {
      try {
        return await readState();
      } catch {
        return emptyMemoryAssignmentState();
      }
    },

    async listAssignments(filter: MemoryAssignmentFilter = {}): Promise<MemoryRoleAssignment[]> {
      const state = await this.getState();
      return state.assignments.filter((assignment) => matchesFilter(assignment, filter));
    },

    async upsertAssignment(assignment: MemoryRoleAssignment): Promise<MemoryAssignmentResult<MemoryRoleAssignment>> {
      try {
        const normalized = normalizeAssignment(assignment);
        const state = await readState();
        const assignments = [...state.assignments];
        const index = assignments.findIndex((existing) => existing.id === normalized.id);
        if (index >= 0) assignments[index] = normalized;
        else assignments.push(normalized);
        await writeState({ ...state, assignments });
        return { ok: true, value: normalized };
      } catch (error) {
        return { ok: false, error: toRedactedError(error) };
      }
    },

    async removeAssignment(id: string): Promise<MemoryAssignmentResult<void>> {
      try {
        const state = await readState();
        await writeState({
          ...state,
          assignments: state.assignments.filter((assignment) => assignment.id !== id),
        });
        return { ok: true, value: undefined };
      } catch (error) {
        return { ok: false, error: toRedactedError(error) };
      }
    },

    async resetAssignments(filter: MemoryAssignmentFilter = {}): Promise<MemoryAssignmentResult<void>> {
      try {
        const state = await readState();
        const hasFilter = filter.role !== undefined || filter.userId !== undefined || filter.workspaceId !== undefined;
        const assignments = hasFilter
          ? state.assignments.filter((assignment) => !matchesFilter(assignment, filter))
          : [];
        await writeState({ ...state, assignments });
        return { ok: true, value: undefined };
      } catch (error) {
        return { ok: false, error: toRedactedError(error) };
      }
    },
  };
}

export function createInMemoryMemoryAssignmentStore(initial?: MemoryAssignmentState): MemoryAssignmentStore {
  let state: MemoryAssignmentState = initial
    ? MemoryAssignmentStateSchema.parse(initial)
    : emptyMemoryAssignmentState();

  return {
    async getState(): Promise<MemoryAssignmentState> {
      return structuredClone(state);
    },

    async listAssignments(filter: MemoryAssignmentFilter = {}): Promise<MemoryRoleAssignment[]> {
      return structuredClone(state.assignments.filter((assignment) => matchesFilter(assignment, filter)));
    },

    async upsertAssignment(assignment: MemoryRoleAssignment): Promise<MemoryAssignmentResult<MemoryRoleAssignment>> {
      const normalized = normalizeAssignment(assignment);
      const assignments = [...state.assignments];
      const index = assignments.findIndex((existing) => existing.id === normalized.id);
      if (index >= 0) assignments[index] = normalized;
      else assignments.push(normalized);
      state = { ...state, assignments };
      return { ok: true, value: structuredClone(normalized) };
    },

    async removeAssignment(id: string): Promise<MemoryAssignmentResult<void>> {
      state = { ...state, assignments: state.assignments.filter((assignment) => assignment.id !== id) };
      return { ok: true, value: undefined };
    },

    async resetAssignments(filter: MemoryAssignmentFilter = {}): Promise<MemoryAssignmentResult<void>> {
      const hasFilter = filter.role !== undefined || filter.userId !== undefined || filter.workspaceId !== undefined;
      state = {
        ...state,
        assignments: hasFilter
          ? state.assignments.filter((assignment) => !matchesFilter(assignment, filter))
          : [],
      };
      return { ok: true, value: undefined };
    },
  };
}

// Backward-compatible factory name for Chunk 045 template tests/callers.
export function createInMemoryMemoryRoleAssignmentStore(
  initial: readonly MemoryRoleAssignment[] = [],
): MemoryRoleAssignmentStore {
  return createInMemoryMemoryAssignmentStore({
    version: 1,
    assignments: initial.map((assignment) => MemoryRoleAssignmentSchema.parse(assignment)),
  });
}

function memoryAssignmentMatchesRoleScope(
  assignment: MemoryRoleAssignment,
  input: { role: MemoryRole; userId?: string; workspaceId?: string },
): boolean {
  if (assignment.role !== input.role) return false;
  if (assignment.userId !== undefined && assignment.userId !== input.userId) return false;
  return !(assignment.workspaceId !== undefined && assignment.workspaceId !== input.workspaceId);
}

function memoryAssignmentSpecificity(assignment: MemoryRoleAssignment): number {
  return (assignment.userId ? 2 : 0) + (assignment.workspaceId ? 1 : 0);
}

function compareMemoryAssignmentPriority(a: MemoryRoleAssignment, b: MemoryRoleAssignment): number {
  const bySpecificity = memoryAssignmentSpecificity(b) - memoryAssignmentSpecificity(a);
  if (bySpecificity !== 0) return bySpecificity;
  return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
}

export function selectMemoryAssignmentForRole(
  assignments: MemoryRoleAssignment[],
  input: { role: MemoryRole; userId?: string; workspaceId?: string },
): MemoryRoleAssignment | undefined {
  return assignments
    .filter((assignment) => memoryAssignmentMatchesRoleScope(assignment, input))
    .sort(compareMemoryAssignmentPriority)[0];
}

/**
 * Authorizing decorator for MemoryAssignmentStore.
 *
 * - If `subject` is provided and has `providers.configure` permission → proceed.
 * - If `subject` is absent → allow (backward compat: caller didn't opt in to auth checks).
 * - If auth is disabled (local mode) → allow all mutations.
 */
export class AuthorizingMemoryAssignmentStore implements MemoryAssignmentStore {
  private readonly inner: MemoryAssignmentStore;
  private readonly subject: AuthorizationSubject | undefined;

  constructor(inner: MemoryAssignmentStore, subject: AuthorizationSubject | undefined) {
    this.inner = inner;
    this.subject = subject;
  }

  private checkMutate(): void {
    if (!this.subject) return; // No subject = backward compat, allow
    if (!this.subject.authEnabled) return; // Local mode: allow all
    if (!can(this.subject, "providers.configure")) {
      throw new Error(
        `Role "${this.subject.role}" does not have permission "providers.configure".`,
      );
    }
  }

  async getState(): Promise<MemoryAssignmentState> {
    return this.inner.getState();
  }

  async listAssignments(filter?: MemoryAssignmentFilter): Promise<MemoryRoleAssignment[]> {
    return this.inner.listAssignments(filter);
  }

  async upsertAssignment(assignment: MemoryRoleAssignment): Promise<MemoryAssignmentResult<MemoryRoleAssignment>> {
    this.checkMutate();
    return this.inner.upsertAssignment(assignment);
  }

  async removeAssignment(id: string): Promise<MemoryAssignmentResult<void>> {
    this.checkMutate();
    return this.inner.removeAssignment(id);
  }

  async resetAssignments(filter?: MemoryAssignmentFilter): Promise<MemoryAssignmentResult<void>> {
    this.checkMutate();
    return this.inner.resetAssignments(filter);
  }
}
